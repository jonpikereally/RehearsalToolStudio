/**
 * The studio's hands: a file API for a window that has none of its own.
 *
 * The studio reads Ableton sets off this disk and writes beside them. In
 * Chrome the page could do that itself through the File System Access API;
 * in a WebKit window it cannot, so the server does it instead — it runs on
 * the same machine as the files, which is the only machine the studio was
 * ever for. Everything the page used to do with a directory handle it now
 * asks for here, by folder path.
 *
 * Every request is `POST /__fs/<op>` with a JSON body, except the two that
 * carry bytes: `read` answers with the file, and `write?dir=&path=` takes it.
 * Paths inside a folder are relative and '/'-joined, exactly as the page
 * derives them from a listing.
 *
 *     pick        { kind: 'folder' | 'file', slot?, prompt?, extensions? }
 *                 → { dir, name, size?, modified? } or { cancelled: true }
 *     stored      { slot }                  → { dir, name } or { dir: null }
 *     forget      { slot }                  → {}
 *     list        { dir }                   → { files: [{ path, name, size, modified }] }
 *     stat        { dir, path }             → { name, size, modified }
 *     exists      { dir, path }             → { exists }
 *     read        { dir, path }             → the bytes
 *     read-json   { dir, path }             → { data, rev } or { missing: true }
 *     write-json  { dir, path, data }       → { rev }
 *     write       ?dir=&path=  + the bytes  → { path, rev }
 *
 * Three things keep this from being "any web page can write my disk":
 *
 *   - The server binds to loopback, so nothing off this machine reaches it.
 *   - Every call must carry an `x-rehearsal-studio` header. A custom header
 *     forces a browser to ask first (a CORS preflight), and this server never
 *     says yes to a stranger — so a page on some other site cannot even make
 *     a browser send the request, let alone read the answer. A request whose
 *     Origin is not this server's own page (or the dev server's) is refused
 *     outright, whatever headers it carries.
 *   - Only folders the user has picked can be touched: the two remembered
 *     slots, plus anything chosen through the dialog while this server has
 *     been up. A path is resolved and held against that list before any
 *     read or write, and one that climbs out of its folder is refused.
 *
 * The remembered folders live in the suite's own profile folder, on the
 * server's side of the line. That is what does away with "needs to be
 * reopened": a path remembered by the server is a path it can still open
 * tomorrow, where a browser handle had to be granted afresh each session.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * `songs` is read and written; `publish` is the band's folder; `resources`
 * is a folder a set's samples live in when they are not inside the project
 * — a click, a bank of spoken cues — and is only ever read.
 */
export const SLOTS = new Set(['songs', 'publish', 'resources']);

/** The set copies the studio and Lyrics Studio make, and may make again. */
export const OWN_SET_COPY = /( \((slates|chords|rehearsaltool)\)| Lyrics)\.als$/i;

/**
 * Besides its own page, the one other place a call may come from: the dev
 * server (`npm run dev:studio`), which passes `/__fs` along to this one.
 */
const DEV_ORIGINS = new Set(['http://localhost:5174', 'http://127.0.0.1:5174']);

export const STATE_FILE = join(
  homedir(),
  'Library',
  'Application Support',
  'Rehearsal Tool Studio',
  'studio-folders.json',
);

/*
 * Where the folders were remembered before the studio had a folder of its
 * own name. Carried over once, so nobody has to pick their folders again
 * for the sake of a rename; the old file is left where it was.
 */
const LEGACY_STATE_FILE = join(homedir(), 'Library', 'Application Support', 'Rehearsal Tool Suite', 'studio-folders.json');
try {
  if (!existsSync(STATE_FILE) && existsSync(LEGACY_STATE_FILE)) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    copyFileSync(LEGACY_STATE_FILE, STATE_FILE);
  }
} catch {
  // Nowhere to write, as under a sandbox: the folders are simply asked for again.
}

const MIME = {
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The folder dialog, as macOS draws it. `osascript` owns the panel, so this
 * works from a server with no window of its own — and from any browser that
 * happens to be showing the studio, not just the Mac app. The prompt goes in
 * as an AppleScript string literal, escaped, and nothing else on the wire
 * reaches the script.
 */
export function nativePick({ kind, prompt, startIn }) {
  const quote = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;
  const verb = kind === 'file' ? 'choose file' : 'choose folder';
  const where = startIn ? ` default location (POSIX file ${quote(startIn)})` : '';
  const script = `POSIX path of (${verb} with prompt ${quote(prompt)}${where})`;
  return new Promise((done, fail) => {
    execFile('osascript', ['-e', script], { encoding: 'utf8' }, (err, out, stderr) => {
      // -128 is AppleScript for "the user pressed Cancel", which is an answer.
      if (err) return /-128/.test(stderr) ? done(null) : fail(new Error(stderr.trim() || err.message));
      done(out.trim().replace(/\/+$/, ''));
    });
  });
}

/**
 * Make the API. `pick` is injectable so the self-test can answer the dialog
 * itself; `stateFile` so it never touches the real remembered folders.
 * Returns a handler that answers `true` when the request was its business.
 */
export function fileApi({ stateFile = STATE_FILE, pick = nativePick } = {}) {
  /** Slot → folder path, as remembered across restarts. */
  let slots = {};
  /** Folders picked while this server has been up, remembered or not. */
  const roots = new Set();
  /** Single files picked on their own, readable but not their neighbours. */
  const files = new Set();

  const loaded = readFile(stateFile, 'utf8')
    .then((text) => {
      slots = JSON.parse(text).slots ?? {};
      for (const dir of Object.values(slots)) roots.add(resolve(dir));
    })
    .catch(() => {
      /* nothing remembered yet, which is the first run */
    });

  const save = async () => {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ slots }, null, 2) + '\n');
  };

  /** A folder the user has picked, or a subfolder of one. */
  const permitted = (dir) => {
    const base = resolve(dir);
    for (const root of roots) if (base === root || base.startsWith(root + sep)) return base;
    throw new Refusal(403, `${dir} is not a folder the studio was given`);
  };

  /** The absolute path of `rel` inside `dir`, refusing anything that climbs out. */
  const inside = (dir, rel, { file = false } = {}) => {
    if (typeof rel !== 'string' || !rel) throw new Refusal(400, 'path is required');
    /*
     * A set names a sample outside its project by its absolute path. Such a
     * path can be read — never written — when it lies inside any folder the
     * user has picked, the resources folder being the one meant for it.
     */
    if (rel.startsWith('abs:')) {
      if (!file) throw new Refusal(400, 'only a folder of your own can be written to');
      const full = resolve(rel.slice(4));
      for (const root of roots) if (full === root || full.startsWith(root + sep)) return full;
      if (files.has(full)) return full;
      throw new Refusal(403, `${dirname(full)} is not a folder the studio was given`);
    }
    const clean = rel.replace(/^\/+/, '');
    // A lone file was picked on its own: its folder was never granted, only it.
    if (file) {
      const guess = resolve(dir, clean);
      if (files.has(guess)) return guess;
    }
    const base = permitted(dir);
    const full = resolve(base, clean);
    if (full !== base && !full.startsWith(base + sep)) throw new Refusal(400, 'path escapes its folder');
    return full;
  };

  const modified = (st) => Math.round(st.mtimeMs);
  const rev = (st) => `${modified(st)}-${st.size}`;

  const ops = {
    async pick({ kind = 'folder', slot, prompt, extensions, startIn: suggested }) {
      if (slot !== undefined && !SLOTS.has(slot)) throw new Refusal(400, 'no such slot');
      // Open where the page suggests, else where that slot was last chosen,
      // when that is still a folder.
      const isDir = async (p) => typeof p === 'string' && !!(await stat(p).catch(() => null))?.isDirectory();
      const last = slot && slots[slot];
      const startIn = (await isDir(suggested)) ? suggested : (await isDir(last)) ? last : undefined;
      const chosen = await pick({
        kind,
        prompt: prompt || (kind === 'file' ? 'Choose a file' : 'Choose a folder'),
        startIn,
      });
      if (!chosen) return { cancelled: true };

      const st = await stat(chosen);
      if (kind === 'file') {
        if (!st.isFile()) throw new Refusal(400, 'that is not a file');
        const ext = extname(chosen).slice(1).toLowerCase();
        if (Array.isArray(extensions) && extensions.length && !extensions.includes(ext)) {
          throw new Refusal(400, `Not a ${extensions.map((e) => `.${e}`).join(' or ')} file: ${basename(chosen)}`);
        }
        files.add(resolve(chosen));
        return { dir: dirname(chosen), name: basename(chosen), size: st.size, modified: modified(st) };
      }
      if (!st.isDirectory()) throw new Refusal(400, 'that is not a folder');
      roots.add(resolve(chosen));
      if (slot) {
        slots[slot] = chosen;
        await save();
      }
      return { dir: chosen, name: basename(chosen) };
    },

    async stored({ slot }) {
      if (!SLOTS.has(slot)) throw new Refusal(400, 'no such slot');
      const dir = slots[slot];
      // A folder that has gone is not a folder to offer.
      if (!dir || !(await stat(dir).catch(() => null))?.isDirectory()) return { dir: null };
      return { dir, name: basename(dir) };
    },

    async forget({ slot }) {
      if (!SLOTS.has(slot)) throw new Refusal(400, 'no such slot');
      delete slots[slot];
      await save();
      return {};
    },

    async list({ dir }) {
      const base = permitted(dir);
      const out = [];
      const walk = async (at, relative) => {
        for (const entry of await readdir(at, { withFileTypes: true })) {
          // The dotfiles Dropbox and macOS scatter around are nobody's songs.
          if (entry.name.startsWith('.')) continue;
          const full = join(at, entry.name);
          const rel = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(full, rel);
          else if (entry.isFile()) {
            const st = await stat(full);
            out.push({ path: rel, name: entry.name, size: st.size, modified: modified(st) });
          }
        }
      };
      await walk(base, '');
      return { files: out };
    },

    async stat({ dir, path }) {
      const full = inside(dir, path, { file: true });
      const st = await stat(full).catch(() => null);
      if (!st?.isFile()) throw new Refusal(404, `not found: ${path}`);
      return { name: basename(full), size: st.size, modified: modified(st) };
    },

    async exists({ dir, path }) {
      // A file that is nowhere is missing, whether or not its folder was
      // ever allowed — a set's stale path to another machine says "missing",
      // not "allow that folder". Reading it would still be refused.
      if (typeof path === 'string' && path.startsWith('abs:')) {
        const there = await stat(resolve(path.slice(4))).catch(() => null);
        if (!there?.isFile()) return { exists: false };
      }
      const st = await stat(inside(dir, path, { file: true })).catch(() => null);
      return { exists: !!st?.isFile() };
    },

    async 'read-json'({ dir, path }) {
      const full = inside(dir, path, { file: true });
      const st = await stat(full).catch(() => null);
      if (!st?.isFile()) return { missing: true };
      return { data: JSON.parse(await readFile(full, 'utf8')), rev: rev(st) };
    },

    async 'write-json'({ dir, path, data }) {
      const full = inside(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, JSON.stringify(data, null, 2));
      return { rev: rev(await stat(full)) };
    },
  };

  /** The page this server served, or the dev server's; nothing else. */
  const refuseStrangers = (req) => {
    if (!('x-rehearsal-studio' in req.headers)) throw new Refusal(403, 'not the studio');
    const origin = req.headers.origin;
    if (!origin || DEV_ORIGINS.has(origin)) return;
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      /* not even a URL, then */
    }
    if (host !== req.headers.host) throw new Refusal(403, 'not the studio');
  };

  const json = (req) =>
    new Promise((done, fail) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        text += chunk;
        // A library file is a few megabytes at the outside; this is not a stem.
        if (text.length > 64 * 1024 * 1024) fail(new Refusal(413, 'too much'));
      });
      req.on('end', () => {
        try {
          done(text ? JSON.parse(text) : {});
        } catch {
          fail(new Refusal(400, 'body is not JSON'));
        }
      });
      req.on('error', fail);
    });

  const answer = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/__fs/')) return false;
    const op = url.pathname.slice('/__fs/'.length);

    try {
      // A preflight from a page that is not ours gets no allowance at all —
      // which is the whole point of demanding the header.
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
      }
      if (req.method !== 'POST') throw new Refusal(405, 'POST only');
      refuseStrangers(req);
      await loaded;

      if (op === 'read') {
        const { dir, path, start, end } = await json(req);
        const full = inside(dir, path, { file: true });
        const st = await stat(full).catch(() => null);
        if (!st?.isFile()) throw new Refusal(404, `not found: ${path}`);
        /*
         * A byte range, when asked for: a frozen track's file runs the length
         * of the set, and a song wants only its own stretch of it. `end` is
         * exclusive, and both are clipped to the file rather than refused.
         */
        const from = Number.isFinite(start) ? Math.max(0, Math.min(st.size, Math.floor(start))) : 0;
        const to = Number.isFinite(end) ? Math.max(from, Math.min(st.size, Math.floor(end))) : st.size;
        res.writeHead(200, {
          'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
          'content-length': to - from,
          'x-file-size': st.size,
          'cache-control': 'no-store',
        });
        if (to === from) {
          res.end();
          return true;
        }
        await pipeline(createReadStream(full, { start: from, end: to - 1 }), res);
        return true;
      }

      if (op === 'write') {
        const full = inside(url.searchParams.get('dir') ?? '', url.searchParams.get('path') ?? '');
        /*
         * An Ableton set is never overwritten. Everything the studio does to
         * a set — slates, chords, rig patches, lyrics — goes into a copy
         * beside it, named for what was added, and those copies are the only
         * .als files this will write over. The rule sits here, below every
         * caller, so no page can break it by mistake.
         */
        if (extname(full).toLowerCase() === '.als' && !OWN_SET_COPY.test(basename(full))) {
          const there = await stat(full).catch(() => null);
          if (there) throw new Refusal(403, `${basename(full)} is an Ableton set; the studio writes copies, never over one`);
        }
        await mkdir(dirname(full), { recursive: true });
        // Written beside its destination and moved in whole, so a write that
        // dies halfway leaves the old file, never half a new one.
        const part = `${full}.part`;
        try {
          await pipeline(req, createWriteStream(part));
          await rename(part, full);
        } catch (err) {
          await rm(part, { force: true });
          throw err;
        }
        answer(res, 200, { path: url.searchParams.get('path'), rev: rev(await stat(full)) });
        return true;
      }

      const handler = ops[op];
      if (!handler) throw new Refusal(404, `no such operation: ${op}`);
      answer(res, 200, await handler(await json(req)));
    } catch (err) {
      const status = err instanceof Refusal ? err.status : 500;
      if (res.headersSent) res.destroy();
      else answer(res, status, { error: String(err?.message ?? err).slice(0, 500) });
    }
    return true;
  };
}

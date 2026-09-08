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
import { copyFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * `songs` is read and written; `publish` is the band's folder; `resources`
 * is a folder a set's samples live in when they are not inside the project
 * — a click, a bank of spoken cues — and is only ever read.
 */
export const SLOTS = new Set(['songs', 'publish', 'resources']);

/** Where the launcher writes, and where the page's own errors go too. */
const LAUNCH_LOG = join(dirname(fileURLToPath(import.meta.url)), '..', '.studio-build.log');

/** The set copies the studio and Lyrics Studio make, and may make again. */
export const OWN_SET_COPY = /( \((slates|chords|info|rig|lyrics|rehearsaltool)\)| Lyrics)\.als$/i;

/**
 * The running order AbleSet is playing right now, from its own log.
 *
 * AbleSet writes a setlist file only when asked to save one; the order on
 * screen lives inside it until then. But every change goes from its page
 * to its server as a request, and the request is logged in full — each
 * song by id, position in beats, last name and place in the order. The
 * newest such line is the order as AbleSet has it at this moment, saved or
 * not, and this reads it back. A log is not a promise, so the line is
 * dated and the caller decides whether it is newer than what was saved.
 */
/**
 * The order AbleSet has right now, asked of AbleSet itself.
 *
 * Its own server answers on this machine while it is running, and what it
 * says is the truth — where the log is only a record of the requests it
 * happened to write down, and a setlist reordered on screen does not always
 * make one. Read liberally: any array of cues with a time and a name, in
 * whatever the answer is wrapped in, so a change to AbleSet's shape leaves
 * the log to fall back on rather than breaking this.
 */
export async function liveSetlistFromApi(ports = [80, 3000, 3001]) {
  for (const port of ports) {
    let doc;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/setlist`, {
        signal: AbortSignal.timeout(700),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) continue;
      doc = await res.json();
    } catch {
      continue; // not there, or not answering: the log will do
    }
    const found = cuesIn(doc);
    if (found?.entries.length) return { at: new Date().toISOString(), ...found };
  }
  return null;
}

/** The first array of cues anywhere in a document, with the name beside it. */
export function cuesIn(doc, name = '', depth = 0) {
  if (!doc || typeof doc !== 'object' || depth > 4) return null;
  const named = typeof doc.name === 'string' ? doc.name : typeof doc.setlistName === 'string' ? doc.setlistName : name;
  const asCues = (list) => {
    const entries = list
      .filter((m) => m && typeof m === 'object' && typeof m.time === 'number')
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((m) => ({
        time: m.time,
        // AbleSet's own answer carries the locator's name under the cue, and
        // a tidied one beside it; its log carries `lastKnownName`. The raw
        // name is the one the set's locators actually have.
        lastKnownName:
          [m.lastKnownName, m.cue?.name, m.meta?.raw, m.meta?.name, m.name].find((n) => typeof n === 'string' && n) ?? '',
      }));
    return entries.length ? { setlistName: named, entries } : null;
  };
  if (Array.isArray(doc)) return asCues(doc) ?? doc.reduce((found, item) => found ?? cuesIn(item, named, depth + 1), null);
  for (const key of ['songs', 'cues', 'items', 'entries', 'metaMap', 'setlist', 'data', 'value']) {
    const child = doc[key];
    if (Array.isArray(child)) {
      const cues = asCues(child);
      if (cues) return cues;
    }
    const deeper = child && typeof child === 'object' ? cuesIn(child, named, depth + 1) : null;
    if (deeper) return deeper;
  }
  return null;
}

export function liveSetlistFromLog(text) {
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.includes('/api/setlist/setCueMeta')) continue;
    try {
      const entry = JSON.parse(line);
      const map = entry?.body?.metaMap;
      if (!Array.isArray(map) || !map.length) continue;
      const entries = map
        .filter((m) => m && typeof m.time === 'number')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((m) => ({ time: m.time, lastKnownName: typeof m.lastKnownName === 'string' ? m.lastKnownName : '' }));
      if (entries.length) found = { at: entry.timestamp ?? null, setlistName: entry.body.setlistName ?? '', entries };
    } catch {
      /* a line that is not JSON is not the one */
    }
  }
  return found;
}

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

  /**
   * The folders a set's samples may live in outside its project, in the order
   * they were allowed. A set can name samples in several places — a shared
   * click library, last year's session, a folder of one-shots — so this is a
   * list, not a slot. `slots.resources` stays as the last one allowed, which
   * is where the picker opens.
   */
  let resourceDirs = [];

  const loaded = readFile(stateFile, 'utf8')
    .then((text) => {
      const saved = JSON.parse(text);
      slots = saved.slots ?? {};
      resourceDirs = Array.isArray(saved.resources) ? saved.resources.filter((d) => typeof d === 'string') : [];
      // A folder allowed before this was a list is still allowed.
      if (slots.resources && !resourceDirs.includes(slots.resources)) resourceDirs.unshift(slots.resources);
      for (const dir of [...Object.values(slots), ...resourceDirs]) roots.add(resolve(dir));
    })
    .catch(() => {
      /* nothing remembered yet, which is the first run */
    });

  const save = async () => {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ slots, resources: resourceDirs }, null, 2) + '\n');
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
  const there = async (p) => !!(await stat(p).catch(() => null));

  /** Where a prepare's previous files are kept, inside the set's folder; listings never look there. */
  const UNDO = '.undo';
  const MANIFEST = 'set.json';
  /** A prepared set's folder — `Sets/<name>` inside a granted folder — and nothing else. */
  const preparedSetPath = (dir, set) => {
    if (typeof set !== 'string' || !/^Sets\/[^/]+$/i.test(set) || /(^|\/)\.\.?(\/|$)/.test(set)) {
      throw new Refusal(400, 'not a prepared set');
    }
    return inside(dir, set);
  };
  const songName = (name) => {
    if (typeof name !== 'string' || !name || name.includes('/') || name.startsWith('.')) {
      throw new Refusal(400, 'not a song folder');
    }
    return name;
  };

  const ops = {
    async pick({ kind = 'folder', slot, prompt, extensions, startIn: suggested }) {
      if (slot !== undefined && !SLOTS.has(slot)) throw new Refusal(400, 'no such slot');
      // Open where the page suggests, else where that slot was last chosen,
      // when that is still a folder.
      const isDir = async (p) => typeof p === 'string' && !!(await stat(p).catch(() => null))?.isDirectory();
      const last = slot && slots[slot];
      // A place inside a remembered folder — `{ slot: 'publish', sub: 'Sets' }` —
      // which the page can name without knowing where that folder is.
      let fallback = last;
      if (suggested && typeof suggested === 'object') {
        const { slot: inSlot, sub } = suggested;
        const home = SLOTS.has(inSlot) ? slots[inSlot] : undefined;
        suggested = home ? resolve(home, typeof sub === 'string' ? sub : '.') : undefined;
        // The place inside it gone, the folder itself will do.
        fallback = home ?? last;
      }
      const startIn = (await isDir(suggested)) ? suggested : (await isDir(fallback)) ? fallback : undefined;
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
        // Samples can be in several places, so allowing one adds to the list.
        if (slot === 'resources' && !resourceDirs.includes(chosen)) resourceDirs.push(chosen);
        await save();
      }
      return { dir: chosen, name: basename(chosen) };
    },

    /**
     * A path the Mac app was handed rather than one chosen in a dialog: a
     * folder or a set dropped on the window or the Dock icon. Granted as a
     * choice in the dialog is, a drop being the same gesture by another
     * route. For a set it is the set's folder that is granted — and made
     * the songs folder when a slot is named — with the set named alongside.
     */
    async open({ path, slot }) {
      if (typeof path !== 'string' || !path) throw new Refusal(400, 'path is required');
      if (slot !== undefined && !SLOTS.has(slot)) throw new Refusal(400, 'no such slot');
      const st = await stat(path).catch(() => null);
      if (!st) throw new Refusal(404, `${path} is not there`);
      let dir = resolve(path);
      let file;
      if (st.isFile()) {
        if (extname(path).toLowerCase() !== '.als') {
          throw new Refusal(400, `Not an Ableton set or a folder: ${basename(path)}`);
        }
        file = basename(path);
        dir = dirname(dir);
      } else if (!st.isDirectory()) {
        throw new Refusal(400, 'that is neither a file nor a folder');
      }
      roots.add(dir);
      if (slot) {
        slots[slot] = dir;
        await save();
      }
      return { dir, name: basename(dir), ...(file ? { file } : {}) };
    },

    /** Show a file or folder of a granted folder in the Finder. */
    async reveal({ dir, path }) {
      const full = inside(dir, path);
      if (!(await stat(full).catch(() => null))) throw new Refusal(404, `${path} is not there`);
      await new Promise((done, fail) => execFile('open', ['-R', full], (err) => (err ? fail(err) : done())));
      return { ok: true };
    },

    /*
     * Undoing a prepare. Before a run writes a song's folder again, the
     * folder is moved aside into the set's `.undo`, where a listing never
     * looks, so the band's app never sees it; the manifest is copied there
     * as the run begins. A run stopped halfway, or regretted, is then put
     * back: the run's folders removed, the kept ones moved home, and the
     * manifest as it was. One level, cleared as the next run begins — and
     * only inside a prepared set, Sets/<name>, is any of this allowed.
     */
    async 'undo-begin'({ dir, set }) {
      const full = preparedSetPath(dir, set);
      // A first prepare's set folder is not there yet; the run is about to make it anyway.
      await mkdir(full, { recursive: true });
      await rm(join(full, UNDO), { recursive: true, force: true });
      await mkdir(join(full, UNDO), { recursive: true });
      if (await there(join(full, MANIFEST))) await copyFile(join(full, MANIFEST), join(full, UNDO, MANIFEST));
      return { ok: true };
    },

    async 'undo-keep'({ dir, set, song }) {
      const full = preparedSetPath(dir, set);
      const name = songName(song);
      const current = join(full, name);
      if (!(await there(current))) return { kept: false };
      const aside = join(full, UNDO, name);
      await mkdir(join(full, UNDO), { recursive: true });
      await rm(aside, { recursive: true, force: true });
      await rename(current, aside);
      return { kept: true };
    },

    async 'undo-restore'({ dir, set, songs }) {
      const full = preparedSetPath(dir, set);
      if (!Array.isArray(songs)) throw new Refusal(400, 'songs is required');
      if (!(await there(join(full, UNDO)))) throw new Refusal(409, 'nothing to undo');
      let restored = 0;
      let removed = 0;
      for (const entry of songs) {
        const name = songName(entry?.folder);
        const current = join(full, name);
        const aside = join(full, UNDO, name);
        if (await there(aside)) {
          await rm(current, { recursive: true, force: true });
          await rename(aside, current);
          restored++;
        } else if (entry.kept === false && (await there(current))) {
          // Written by the run into a folder that was not there before.
          await rm(current, { recursive: true, force: true });
          removed++;
        }
      }
      const kept = join(full, UNDO, MANIFEST);
      if (await there(kept)) await copyFile(kept, join(full, MANIFEST));
      else await rm(join(full, MANIFEST), { force: true });
      await rm(join(full, UNDO), { recursive: true, force: true });
      return { restored, removed };
    },

    /**
     * Start Lyrics Studio — the transcriber, its own Python server in this
     * repo — when the page finds it is not running. Detached, its output
     * kept in a log, the way the launcher starts it from the Dock; the page
     * then looks for it by port. Nothing is done when uv is not installed.
     */
    async 'lyrics-studio-start'({ restart, port } = {}) {
      const home = homedir();
      /*
       * One started elsewhere — from a Terminal, or an app without leave to
       * read Downloads — cannot read a set that this server can: macOS grants
       * a folder per app, and a child of this server has the studio's leave.
       * So on request the one on `port` is stopped and another started here.
       */
      if (restart && Number.isInteger(port)) {
        const pids = await new Promise((done) =>
          execFile('lsof', ['-ti', `tcp:${port}`], (err, out) => done(err ? [] : String(out).split(/\s+/).filter(Boolean))),
        );
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGTERM');
          } catch {
            /* already gone */
          }
        }
        if (pids.length) await new Promise((r) => setTimeout(r, 1500));
      }
      const uv = ['/opt/homebrew/bin/uv', join(home, '.local', 'bin', 'uv'), '/usr/local/bin/uv'].find((p) => existsSync(p));
      if (!uv) throw new Refusal(500, 'uv, which runs Lyrics Studio, is not installed. In Terminal: brew install uv');
      const cwd = join(dirname(fileURLToPath(import.meta.url)), '..', 'lyrics-studio');
      const logDir = join(home, 'Library', 'Logs', 'Rehearsal Tool Studio');
      mkdirSync(logDir, { recursive: true });
      const log = join(logDir, 'lyrics-studio.log');
      const out = openSync(log, 'a');
      // An app's PATH has no Homebrew on it, and Lyrics Studio needs ffmpeg from there.
      const path = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin'].join(':');
      const child = spawn(uv, ['run', 'server.py'], { cwd, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PATH: path } });
      child.unref();
      return { started: true, log };
    },

    /** A file's absolute path, for handing to another app on this Mac that reads it itself. */
    async 'abs-path'({ dir, path }) {
      return { path: inside(dir, path, { file: true }) };
    },

    /** Whether Ableton Live is running on this Mac, so the page can say who it is watching. */
    async 'live-running'() {
      const running = await new Promise((done) => execFile('pgrep', ['-f', 'Ableton Live'], (err) => done(!err)));
      return { running };
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
      if (slot === 'resources') resourceDirs = [];
      await save();
      return {};
    },

    /**
     * Remove a submix nobody needs any more.
     *
     * The one thing the studio deletes rather than moves aside, and only
     * this: a submix is a sum of files that are all still there, so nothing
     * is lost with it, and a folder that keeps every list anybody ever had is
     * a folder the band downloads twice over. The name has to say it is one —
     * the rule is here, under every caller, so no page can widen it.
     */
    async 'remove-submix'({ dir, path }) {
      const full = inside(dir, path, { file: true });
      if (!/\[\s*submix\b[^\]]*\]/i.test(basename(full))) {
        throw new Refusal(400, `${basename(full)} is not a submix; the studio deletes nothing else`);
      }
      await rm(full, { force: true });
      return { removed: basename(full) };
    },

    /**
     * Remove one part of a prepared song, after somebody has looked at it.
     *
     * Only a part the studio itself wrote: a file with a `[label]` in its
     * name, ending in `.mp3`, under a `Sets/` folder. That is the shape of
     * everything a prepare makes and of nothing a person keeps, so a page
     * asking for anything else — a stem in the project, a set, a folder — is
     * refused here, under every caller, where no page can widen it.
     *
     * Used for a part that came out silent. Nothing is lost that the set
     * cannot make again: the source is still in the arrangement, and the next
     * prepare writes it back if it has something in it.
     */
    async 'remove-part'({ dir, path }) {
      const full = inside(dir, path, { file: true });
      const name = basename(full);
      const relative = String(path ?? '').replace(/^\/+/, '');
      if (!/^sets\//i.test(relative)) {
        throw new Refusal(400, 'only a part of a prepared set can be removed');
      }
      if (!/\.mp3$/i.test(name) || !/\[[^\]]+\]/.test(name)) {
        throw new Refusal(400, `${name} is not a part the studio wrote`);
      }
      await rm(full, { force: true });
      return { removed: name };
    },

    /** Every folder samples may be read from, in the order they were allowed. */
    async resources() {
      const out = [];
      for (const dir of resourceDirs) {
        if ((await stat(dir).catch(() => null))?.isDirectory()) out.push({ dir, name: basename(dir) });
      }
      return { folders: out };
    },

    /** Take one away: it stops being readable now, not at the next launch. */
    async 'forget-resource'({ dir }) {
      if (typeof dir !== 'string' || !dir) throw new Refusal(400, 'dir is required');
      const gone = resolve(dir);
      resourceDirs = resourceDirs.filter((d) => resolve(d) !== gone);
      if (slots.resources && resolve(slots.resources) === gone) {
        slots.resources = resourceDirs[resourceDirs.length - 1];
        if (!slots.resources) delete slots.resources;
      }
      /*
       * It stops being readable now, not at the next launch — but only it:
       * rebuilding the whole set of granted folders would take away the ones
       * granted by a set dropped on the window, which nothing here asked to
       * forget.
       */
      if (!Object.values(slots).some((kept) => resolve(kept) === gone)) roots.delete(gone);
      await save();
      return { folders: resourceDirs.map((d) => ({ dir: d, name: basename(d) })) };
    },

    /**
     * The Ableton sessions sitting in a folder, newest save first.
     *
     * The launch chooser offers the sessions in the folder it last read
     * without opening any of them, and a project folder holds its sets at
     * the top: a shallow look, not the whole walk `list` does through every
     * stem in it.
     */
    async sessions({ dir }) {
      const base = permitted(dir);
      const out = [];
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        if (extname(entry.name).toLowerCase() !== '.als') continue;
        const st = await stat(join(base, entry.name)).catch(() => null);
        if (st) out.push({ name: entry.name, modified: modified(st) });
      }
      out.sort((a, b) => b.modified - a.modified);
      return { dir: base, name: basename(base), files: out };
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

    /**
     * AbleSet's current order for the set at `path`, from its log — see
     * liveSetlistFromLog. `applies` says whether AbleSet's open project is
     * this set's, by folder: the file it has open may be a saved-as copy of
     * the same project, and the order is the project's, not the file's.
     */
    async 'ableset-live'({ dir, path }) {
      const full = inside(dir, path, { file: true });
      const support = join(homedir(), 'Library', 'Application Support');
      let projectFile = null;
      for (const name of ['AbleSet', 'ableset']) {
        try {
          projectFile = JSON.parse(await readFile(join(support, name, 'last-project-file.json'), 'utf8')).lastProjectFile ?? null;
          if (projectFile) break;
        } catch {
          /* not here */
        }
      }
      const applies = !!projectFile && dirname(resolve(projectFile)) === dirname(full);
      // AbleSet itself first, while it is running: what it says is now.
      const live = await liveSetlistFromApi();
      if (live) return { found: true, ...live, from: 'ableset', projectFile, applies };

      // Otherwise the newest order it happened to write down, across launches.
      let best = null;
      for (const name of ['ableset', 'AbleSet']) {
        const logs = join(support, name, 'logs');
        let names;
        try {
          names = (await readdir(logs)).filter((n) => n.endsWith('.log'));
        } catch {
          continue;
        }
        const dated = await Promise.all(names.map(async (n) => ({ n, st: await stat(join(logs, n)).catch(() => null) })));
        dated.sort((a, b) => (b.st?.mtimeMs ?? 0) - (a.st?.mtimeMs ?? 0));
        // The newest few launches: a setlist changed today is in today's log,
        // but a launch that has written none leaves the last one standing.
        for (const { n } of dated.slice(0, 5)) {
          const found = liveSetlistFromLog(await readFile(join(logs, n), 'utf8').catch(() => ''));
          if (!found) continue;
          if (!best || Date.parse(found.at ?? 0) > Date.parse(best.at ?? 0)) best = found;
        }
      }
      if (best) return { found: true, ...best, from: 'log', projectFile, applies };
      return { found: false, projectFile };
    },

    /**
     * A line from the page into the launch log: an error it caught, said
     * beside the launcher's own lines where somebody can read it. Bounded,
     * so a page in a loop cannot fill a disk.
     */
    async note({ text }) {
      if (typeof text !== 'string' || !text.trim()) throw new Refusal(400, 'text is required');
      const line = `${new Date().toISOString()} page: ${text.slice(0, 4000).replace(/\r?\n/g, '\n    ')}\n`;
      await appendFile(LAUNCH_LOG, line).catch(() => {});
      return { ok: true };
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

/**
 * The studio, served from this machine.
 *
 * Rehearsal Tool Studio is an offline tool: it reads Ableton sets off this
 * disk and writes beside them. The Mac app builds it when the source has
 * moved and serves the result from here — loopback only, plain files,
 * nothing clever. Everything is
 * served no-store: a local file needs no cache, and a cache is one more way
 * to be shown last week's build.
 *
 *     node scripts/serve-studio.mjs        (http://localhost:5177)
 *
 * `/__rehearsal-studio` answers so the launcher can tell this server from any
 * stranger that happens to be squatting on the port. `/__fs/*` is the file
 * API — the window has no way to the disk of its own, so the page asks this
 * server to read its sets and write beside them (see studio-files.mjs).
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileApi } from './studio-files.mjs';

const PORT = Number(process.env.STUDIO_PORT ?? 5177);
// fileURLToPath, not .pathname: this repo's path has spaces, and a URL keeps
// them percent-encoded where the filesystem wants them literal.
const ROOT = fileURLToPath(new URL('../dist', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

// STUDIO_STATE_FILE points the remembered folders somewhere else — for trying
// the server against a scratch folder without touching the real ones.
/** The build this server *is*: the stamp on disk when it started. */
const readStamp = () => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'build.json'), 'utf8')).build ?? null;
  } catch {
    return null;
  }
};
const STARTED_WITH = readStamp();

const files = fileApi(process.env.STUDIO_STATE_FILE ? { stateFile: process.env.STUDIO_STATE_FILE } : {});

const server = createServer(async (req, res) => {
  if (await files(req, res)) return;
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);

  if (path === '/__rehearsal-studio') {
    /*
     * Two builds: `build` is what sits on disk right now, read fresh, and
     * `server` is what this process started with. They part when the
     * launcher rebuilds underneath a running server — and this server's
     * own code, the file API included, is as old as `server`. The launcher
     * replaces a server whose `server` is behind the disk; an open page
     * compares `server` with its own stamp to learn it has gone stale.
     * Answering only with the fresh stamp once let a server with a
     * year-old file API look current forever.
     */
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(
      JSON.stringify({ ok: true, serving: 'rehearsal-tool-studio', build: readStamp(), server: STARTED_WITH, files: true }),
    );
  }

  // Normalised and rooted, so no path can climb out of the build folder.
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, safe);
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
  } catch {
    // Hash routing means any real navigation is /, so an unknown path is the
    // app asking for itself under another name.
    file = extname(safe) ? '' : join(ROOT, 'index.html');
  }

  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not here');
  }
});

server.on('error', (err) => {
  // A port already taken is the one failure worth spelling out: something
  // else is squatting, and serving nothing beats serving the wrong thing.
  console.error(`studio server could not start: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`studio at http://localhost:${PORT}, serving dist/`);
});

/**
 * The studio's voice: a helper that turns text into spoken WAV files.
 *
 * The browser cannot write its own speech to a file, and the best voices on a
 * Mac — the downloadable premium ones — only speak through `say`. So Studio
 * asks this instead: a loopback-only HTTP server wrapping `say` + `afconvert`.
 * Start it when you want slates, stop it when you don't:
 *
 *     npm run slates:helper
 *
 * GET  /voices          → { voices: [{ name, lang }] }
 * POST /speak           → audio/wav (mono 16-bit 44.1 kHz)
 *      { text, voice }
 *
 * Only the studio's own origins may call it, it binds to 127.0.0.1 alone, and
 * the voice name must be one `say` itself reported — so nothing on the wire
 * ever reaches a shell.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.SLATE_HELPER_PORT ?? 5175);
const MAX_TEXT = 200;

const ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5177',
]);

function voices() {
  const out = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.match(/^(.+?)\s+([a-z]{2}[_-][A-Za-z]+)\s+#/))
    .filter(Boolean)
    .map((m) => ({ name: m[1].trim(), lang: m[2] }));
}

function speak(text, voice) {
  const caf = join(tmpdir(), `slate-${process.pid}.caf`);
  const wav = join(tmpdir(), `slate-${process.pid}.wav`);
  try {
    // Premium voices refuse AIFF; CAF takes anything, and afconvert makes it
    // the plain mono WAV an Ableton cue track wants. The text goes in on
    // stdin, where nothing in it can read as an option.
    execFileSync('say', ['-v', voice, '-o', caf, '--data-format=LEF32@22050', '-f', '-'], { input: text });
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', '-c', '1', caf, wav]);
    const out = readFileSync(wav);
    /*
     * A premium voice macOS has evicted still answers `say -v ?` and exits
     * cleanly — producing eleven milliseconds of nothing. Refusing loudly here
     * beats fourteen silent files nobody catches until the show. 0.2s is well
     * under any spoken word and well over the ghost's empty buffer.
     */
    if ((out.length - 44) / 2 / 44100 < 0.2) {
      throw new Error(
        `"${voice}" produced no audio — its download was likely evicted by macOS. ` +
          'Re-download it in System Settings → Accessibility → Spoken Content, or pick another voice.',
      );
    }
    return out;
  } finally {
    rmSync(caf, { force: true });
    rmSync(wav, { force: true });
  }
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) reject(new Error('too much'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  const headers = {
    'Access-Control-Allow-Origin': ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'content-type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }
  // A browser page that isn't the studio gets nothing.
  if (origin && !ORIGINS.has(origin)) {
    res.writeHead(403, headers);
    return res.end('not the studio');
  }

  try {
    if (req.method === 'GET' && req.url === '/voices') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ voices: voices() }));
    }
    if (req.method === 'POST' && req.url === '/speak') {
      const { text, voice } = JSON.parse(await body(req));
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
        res.writeHead(400, headers);
        return res.end(`text must be 1–${MAX_TEXT} characters`);
      }
      if (!voices().some((v) => v.name === voice)) {
        res.writeHead(400, headers);
        return res.end('no such voice');
      }
      const wav = speak(text.trim(), voice);
      res.writeHead(200, { ...headers, 'content-type': 'audio/wav' });
      return res.end(wav);
    }
    res.writeHead(404, headers);
    res.end();
  } catch (err) {
    res.writeHead(500, headers);
    res.end(String(err?.message ?? err).slice(0, 300));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const best = voices().find((v) => /premium|enhanced/i.test(v.name));
  console.log(`slate helper on http://127.0.0.1:${PORT}`);
  console.log(best ? `best voice installed: ${best.name}` : 'no premium voice installed — Samantha it is');
  console.log('leave this running while Studio generates slates; ctrl-C when done');
});

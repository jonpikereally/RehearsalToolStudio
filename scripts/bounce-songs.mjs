/**
 * Bounce every song in an Ableton set to its own audio file, offline.
 *
 * Reads the set the way the app does — locators mark songs — then renders each
 * one by mixing the arrangement's audio clips: tempo automation is integrated
 * so bars land where Live would put them, warped clips follow their warp
 * markers, looping clips loop, fades fade, and track, group and clip gains all
 * multiply through. What it does not do is run devices — sends, reverbs and
 * plugins are silent — so the result is the honest sum of the printed audio,
 * which in a playback rig is usually the show.
 *
 *     node scripts/bounce-songs.mjs <set.als> [out dir] [--exclude Click,Cues]
 *
 * Tracks are excluded by their own name or any enclosing group's name.
 * Defaults exclude the performance-only furniture: Click, Cues, VIDEO.
 * Decoding and encoding go through afconvert, so it is macOS-only.
 */
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseAlsXml } from '../src/lib/alsParser.ts';

const SR = 44100;

const fail = (msg) => {
  console.error(`bounce-songs: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const ALS = args[0] ?? fail('usage: node scripts/bounce-songs.mjs <set.als> [out dir] [--exclude a,b]');
const OUT = args[1] ?? join(process.env.HOME, 'Downloads', basename(ALS).replace(/\.als$/i, '') + ' - Songs');
const EXCLUDE = (flags.find((f) => f.startsWith('--exclude='))?.slice(10) ?? 'Click,Cues,VIDEO')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (!existsSync(ALS)) fail(`no such set: ${ALS}`);
const xml = gunzipSync(readFileSync(ALS)).toString('utf8');
const project = parseAlsXml(xml);

/* --------------------------------- tracks --------------------------------- */

const num = (chunk, re, dflt = NaN) => {
  const v = parseFloat((chunk.match(re) ?? [])[1] ?? '');
  return Number.isNaN(v) ? dflt : v;
};

const trackChunks = xml
  .split(/(?=<(?:MidiTrack|AudioTrack|GroupTrack|ReturnTrack) Id=)/)
  .slice(1)
  .map((chunk) => ({
    kind: (chunk.match(/^<(\w+)/) ?? [])[1],
    id: (chunk.match(/^<\w+ Id="(\d+)"/) ?? [])[1],
    groupId: (chunk.match(/<TrackGroupId Value="(-?\d+)"/) ?? [])[1] ?? '-1',
    name: (chunk.match(/<EffectiveName Value="([^"]*)"/) ?? [])[1] ?? '',
    on: (chunk.match(/<Speaker>[\s\S]{0,200}?<Manual Value="(true|false)"/) ?? [])[1] !== 'false',
    volume: num(chunk, /<Volume>[\s\S]{0,200}?<Manual Value="([^"]+)"/, 1),
    chunk,
  }));
const byId = new Map(trackChunks.map((t) => [t.id, t]));

/** The gain a track really plays at: its own fader times every parent's. */
function chainGain(track) {
  let gain = track.volume;
  for (let t = track, i = 0; t.groupId !== '-1' && i < 8; i++) {
    t = byId.get(t.groupId);
    if (!t) break;
    if (!t.on) return 0;
    gain *= t.volume;
  }
  return gain;
}

function isExcluded(track) {
  for (let t = track, i = 0; t && i < 9; i++, t = byId.get(t.groupId)) {
    if (EXCLUDE.includes(t.name.trim().toLowerCase())) return true;
    if (t.groupId === '-1') break;
  }
  return false;
}

/* ---------------------------------- clips ---------------------------------- */

function clipsOf(track) {
  const clips = [];
  for (const m of track.chunk.matchAll(/<AudioClip Id="\d+"[^>]*>([\s\S]*?)<\/AudioClip>/g)) {
    const c = m[1];
    const start = num(c, /<CurrentStart Value="([-\d.]+)"/);
    const end = num(c, /<CurrentEnd Value="([-\d.]+)"/);
    if (!(end > start)) continue;
    if ((c.match(/<Disabled Value="(true|false)"/) ?? [])[1] === 'true') continue;
    const path = (c.match(/<RelativePath Value="([^"]+)"/) ?? c.match(/<Path Value="([^"]+)"/) ?? [])[1];
    if (!path) continue;
    const abs = (c.match(/<Path Value="([^"]+)"/) ?? [])[1] ?? path;
    const fades = (c.match(/<Fade Value="(true|false)"/) ?? [])[1] === 'true';
    const warped = /<IsWarped Value="true"/.test(c);
    const markers = [...c.matchAll(/<WarpMarker Id="\d+" SecTime="([-\d.]+)" BeatTime="([-\d.]+)"/g)]
      .map((w) => ({ sec: parseFloat(w[1]), beat: parseFloat(w[2]) }))
      .sort((a, b) => a.beat - b.beat);
    clips.push({
      start,
      end,
      loopOn: (c.match(/<LoopOn Value="(true|false)"/) ?? [])[1] === 'true',
      loopStart: num(c, /<LoopStart Value="([-\d.]+)"/, 0),
      loopEnd: num(c, /<LoopEnd Value="([-\d.]+)"/, 0),
      startRelative: num(c, /<StartRelative Value="([-\d.]+)"/, 0),
      fadeIn: fades ? num(c, /<FadeInLength Value="([-\d.]+)"/, 0) : 0,
      fadeOut: fades ? num(c, /<FadeOutLength Value="([-\d.]+)"/, 0) : 0,
      gain: num(c, /<SampleVolume Value="([-\d.]+)"/, 1),
      warped,
      markers,
      file: abs,
    });
  }
  return clips;
}

const playable = trackChunks.filter((t) => t.kind === 'AudioTrack' && t.on && !isExcluded(t));
const silenced = trackChunks.filter((t) => t.kind === 'AudioTrack' && (!t.on || isExcluded(t)));
console.log(`mixing ${playable.length} tracks; leaving out: ${silenced.map((t) => t.name).join(', ')}`);

/* -------------------------------- tempo map -------------------------------- */

/*
 * Beats to seconds under automation. Between two envelope points Live ramps
 * the tempo linearly over beats, so time is the integral of 60/bpm — a log
 * for a ramp, a division for a plateau. Live's step changes arrive as two
 * points at the same beat, which fall out of the maths on their own.
 */
const tempoTargetId = (xml.match(/<Tempo>[\s\S]{0,700}?<AutomationTarget Id="(\d+)"/) ?? [])[1];
let events = [];
if (tempoTargetId) {
  const env = xml.match(
    new RegExp(
      `<AutomationEnvelope Id="\\d+">\\s*<EnvelopeTarget>\\s*<PointeeId Value="${tempoTargetId}"[\\s\\S]*?</AutomationEnvelope>`,
    ),
  );
  if (env) {
    events = [...env[0].matchAll(/<FloatEvent Id="\d+" Time="([-\d.]+)" Value="([\d.]+)"/g)]
      .map((m) => ({ beat: Math.max(0, parseFloat(m[1])), bpm: parseFloat(m[2]) }))
      .sort((a, b) => a.beat - b.beat);
  }
}
if (!events.length) events = [{ beat: 0, bpm: project.tempo }];

const segStarts = [events[0] && { beat: 0, bpm: events[0].bpm }, ...events].filter(Boolean);
const segTimes = [0];
for (let i = 1; i < segStarts.length; i++) {
  const a = segStarts[i - 1];
  const b = segStarts[i];
  const db = b.beat - a.beat;
  let dt = 0;
  if (db > 0) {
    dt =
      Math.abs(b.bpm - a.bpm) < 1e-9
        ? (db * 60) / a.bpm
        : ((60 * db) / (b.bpm - a.bpm)) * Math.log(b.bpm / a.bpm);
  }
  segTimes.push(segTimes[i - 1] + dt);
}

function secAt(beat) {
  let i = segStarts.length - 1;
  while (i > 0 && segStarts[i].beat > beat) i--;
  const a = segStarts[i];
  const next = segStarts[i + 1];
  const db = beat - a.beat;
  if (db <= 0) return segTimes[i];
  const slope = next && next.beat > a.beat ? (next.bpm - a.bpm) / (next.beat - a.beat) : 0;
  if (Math.abs(slope) < 1e-9) return segTimes[i] + (db * 60) / a.bpm;
  const bpmHere = a.bpm + slope * db;
  return segTimes[i] + (60 / slope) * Math.log(bpmHere / a.bpm);
}

/** Every beat where the tempo curve bends, for cutting clips into segments. */
const tempoBreaks = segStarts.map((s) => s.beat);

/* -------------------------------- decoding --------------------------------- */

const scratch = join(tmpdir(), `bounce-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const decoded = new Map();
let decodeSerial = 0;

/** The file as stereo float frames at SR, via afconvert. */
function decode(path) {
  if (decoded.has(path)) return decoded.get(path);
  if (!existsSync(path)) {
    console.warn(`  missing file, playing silence: ${path}`);
    decoded.set(path, null);
    return null;
  }
  const tmp = join(scratch, `${decodeSerial++}.wav`);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEF32@${SR}`, '-c', '2', path, tmp], { stdio: 'pipe' });
  const buf = readFileSync(tmp);
  rmSync(tmp);
  const data = buf.indexOf(Buffer.from('data'));
  if (data < 0) fail(`afconvert produced no data chunk for ${path}`);
  const bytes = buf.readUInt32LE(data + 4);
  const from = data + 8;
  const floats = new Float32Array(buf.buffer, buf.byteOffset + from, Math.floor(Math.min(bytes, buf.length - from) / 4));
  const out = { left: new Float32Array(floats.length / 2), right: new Float32Array(floats.length / 2) };
  for (let i = 0; i < out.left.length; i++) {
    out.left[i] = floats[2 * i];
    out.right[i] = floats[2 * i + 1];
  }
  decoded.set(path, out);
  return out;
}

/* -------------------------------- rendering -------------------------------- */

/** File seconds for a clip-content beat, through the warp markers. */
function warpSec(markers, beat) {
  if (markers.length < 2) return beat; // degenerate: treat beats as seconds
  let i = markers.length - 2;
  while (i > 0 && markers[i].beat > beat) i--;
  const a = markers[i];
  const b = markers[i + 1];
  const rate = b.beat > a.beat ? (b.sec - a.sec) / (b.beat - a.beat) : 0;
  return a.sec + (beat - a.beat) * rate;
}

function renderClip(clip, gain, songStartBeat, songEndBeat, songStartSec, left, right) {
  const source = decode(clip.file);
  if (!source) return;

  const from = Math.max(clip.start, songStartBeat);
  const to = Math.min(clip.end, songEndBeat);
  if (to <= from) return;

  const clipStartSec = secAt(clip.start);
  const loopLen = clip.loopEnd - clip.loopStart;

  /*
   * Cut the span wherever the mapping bends — tempo events, warp markers, loop
   * wraps — so that between cuts the file position moves linearly and the
   * inner loop is plain arithmetic.
   */
  const cuts = new Set([from, to]);
  for (const b of tempoBreaks) if (b > from && b < to) cuts.add(b);
  if (clip.warped) {
    for (const m of clip.markers) {
      const arr = clip.start + (m.beat - clip.loopStart - clip.startRelative);
      if (arr > from && arr < to) cuts.add(arr);
    }
  }
  if (clip.loopOn && loopLen > 0 && clip.warped) {
    for (let k = 1; k < 10000; k++) {
      const arr = clip.start + k * loopLen - clip.startRelative;
      if (arr >= to) break;
      if (arr > from) cuts.add(arr);
    }
  }
  const edges = [...cuts].sort((a, b) => a - b);

  const fadeInEnd = clipStartSec + clip.fadeIn;
  const clipEndSec = secAt(clip.end);
  const fadeOutStart = clipEndSec - clip.fadeOut;

  for (let e = 0; e < edges.length - 1; e++) {
    const bA = edges[e];
    const bB = edges[e + 1];
    const tA = secAt(bA);
    const tB = secAt(bB);
    if (tB - tA <= 0) continue;

    let fileA;
    let fileStep; // file seconds per output second
    if (clip.warped) {
      const content = (beat) => {
        let cb = clip.loopStart + clip.startRelative + (beat - clip.start);
        if (clip.loopOn && loopLen > 0 && cb >= clip.loopEnd) {
          cb = clip.loopStart + ((cb - clip.loopStart) % loopLen);
        }
        return cb;
      };
      const mid = (bA + bB) / 2; // sample inside the segment, away from wraps
      const secMid = warpSec(clip.markers, content(mid));
      const secA2 = warpSec(clip.markers, content(bA + (mid - bA) / 1000));
      fileStep = ((secMid - secA2) / (secAt(mid) - secAt(bA + (mid - bA) / 1000))) || 0;
      fileA = secMid - (secAt(mid) - tA) * fileStep;
    } else {
      // Unwarped: the file runs at its own speed from a seconds offset.
      let off = clip.loopStart + clip.startRelative + (tA - clipStartSec);
      if (clip.loopOn && loopLen > 0 && off >= clip.loopEnd) {
        off = clip.loopStart + ((off - clip.loopStart) % loopLen);
      }
      fileA = off;
      fileStep = 1;
    }

    const outA = Math.max(0, Math.round((tA - songStartSec) * SR));
    const outB = Math.min(left.length, Math.round((tB - songStartSec) * SR));
    for (let i = outA; i < outB; i++) {
      const tAbs = songStartSec + i / SR;
      const filePos = (fileA + (tAbs - tA) * fileStep) * SR;
      const f0 = Math.floor(filePos);
      if (f0 < 0 || f0 + 1 >= source.left.length) continue;
      const frac = filePos - f0;
      let g = gain * clip.gain;
      if (clip.fadeIn > 0 && tAbs < fadeInEnd) g *= (tAbs - clipStartSec) / clip.fadeIn;
      if (clip.fadeOut > 0 && tAbs > fadeOutStart) g *= Math.max(0, (clipEndSec - tAbs) / clip.fadeOut);
      left[i] += g * (source.left[f0] * (1 - frac) + source.left[f0 + 1] * frac);
      right[i] += g * (source.right[f0] * (1 - frac) + source.right[f0 + 1] * frac);
    }
  }
}

/* --------------------------------- songs ----------------------------------- */

const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
const toBeat = (bar) => (bar - 1) * beatsPerBar;

// Consecutive spans with one name are one song — a count-in locator repeats
// the title just ahead of the downbeat.
const spans = [];
for (const s of project.songs) {
  const prev = spans[spans.length - 1];
  if (prev && prev.title === s.title && Math.abs(prev.endBar - s.startBar) < 1e-6) prev.endBar = s.endBar;
  else spans.push({ title: s.title, startBar: s.startBar, endBar: s.endBar });
}

const safeName = (t) => t.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
mkdirSync(OUT, { recursive: true });

const trackClips = playable.map((t) => ({ gain: chainGain(t), clips: clipsOf(t) }));

for (const [index, span] of spans.entries()) {
  const startBeat = toBeat(span.startBar);
  const endBeat = toBeat(span.endBar);
  const startSec = secAt(startBeat);
  const durSec = secAt(endBeat) - startSec;
  const frames = Math.ceil(durSec * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  let used = 0;
  for (const t of trackClips) {
    if (t.gain <= 0) continue;
    for (const clip of t.clips) {
      if (clip.end <= startBeat || clip.start >= endBeat) continue;
      renderClip(clip, t.gain, startBeat, endBeat, startSec, left, right);
      used++;
    }
  }

  // Stems are per-song, so the decode cache would only grow from here.
  decoded.clear();

  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const scale = peak > 0.98 ? 0.98 / peak : 1;

  const pcm = Buffer.alloc(44 + frames * 8);
  pcm.write('RIFF', 0);
  pcm.writeUInt32LE(36 + frames * 8, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(3, 20); // IEEE float
  pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(SR, 24);
  pcm.writeUInt32LE(SR * 8, 28);
  pcm.writeUInt16LE(8, 32);
  pcm.writeUInt16LE(32, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    pcm.writeFloatLE(left[i] * scale, 44 + i * 8);
    pcm.writeFloatLE(right[i] * scale, 48 + i * 8);
  }
  const tmpWav = join(scratch, 'mix.wav');
  const name = `${String(index + 1).padStart(2, '0')} ${safeName(span.title)}`;
  const out = join(OUT, `${name}.m4a`);
  writeFileSync(tmpWav, pcm);
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '256000', tmpWav, out], { stdio: 'pipe' });
  console.log(
    `${name}.m4a  ${(durSec / 60).toFixed(1)} min, ${used} clips${scale < 1 ? `, peak tamed ${peak.toFixed(2)}→0.98` : ''}`,
  );
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${spans.length} songs in:\n  ${OUT}`);

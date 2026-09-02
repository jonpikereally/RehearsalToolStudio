/**
 * Build a synthetic Ableton set for exercising Prepare without the real 4 GB.
 *
 * Three short songs on one timeline, the way a real set is laid out: a
 * metadata-bearing locator starts each song, AUTOSTOP ends it, a group track
 * named after the song holds its stems, +SECTIONS and +LYRICS tracks carry the
 * text. The stems are synthesized here — clicks for drums, sines for the rest —
 * so each part is recognisable by ear and the whole thing is a few megabytes.
 *
 * The document is real Live 12 format, so Ableton itself opens it. Nobody can
 * write that schema from scratch and be believed, so every structural piece —
 * track skeletons, a clip, the master track, the whole document wrapper — is
 * harvested from the genuine Coldplay set at run time and patched, rather than
 * invented. What Live reads is a document it (almost entirely) wrote.
 *
 *     node scripts/make-test-set.mjs [destination folder] [template .als]
 *
 * Default destination: ~/Library/CloudStorage/Dropbox/Apps/Rehearsal Tool
 * Studio/Test Set Project — the studio's own folder, beside the Coldplay set,
 * which is also where the default template comes from.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseAlsXml } from '../src/lib/alsParser.ts';

const SR = 44100;
const SET_NAME = 'Test Set 2026.08.27.als';

const STUDIO = join(homedir(), 'Library/CloudStorage/Dropbox/Apps/Rehearsal Tool Studio');
const DEST = process.argv[2] ?? join(STUDIO, 'Test Set Project');
const TEMPLATE =
  process.argv[3] ?? join(STUDIO, 'Coldplay ALS/Coldplay Covers Live Set/Coldplay Cover Band 2026.06.22.als');

/* --------------------------------- songs --------------------------------- */

/*
 * Every song is 32 beats of 4/4 with an 8-beat gap before the next, so the
 * timeline is: song one at beat 0, two at 40, three at 80. The gap matters:
 * a real set has count-off space between songs, and clips must not bleed
 * across it.
 */
const SONGS = [
  {
    locator: 'Test Song One / 0:16 / C / 120BPM',
    title: 'Test Song One',
    start: 0,
    bpm: 120,
    bass: 65.41, // C2
    keys: [261.63, 329.63, 392.0], // C4 E4 G4
    vox: null,
  },
  {
    locator: 'Test Song Two / 0:20 / Am / 96BPM',
    title: 'Test Song Two',
    start: 40,
    bpm: 96,
    bass: 55.0, // A1
    keys: null,
    vox: [440.0, 523.25, 493.88, 440.0], // A4 C5 B4 A4, one per bar
  },
  {
    locator: 'Test Song Three / 0:14 / G / 140BPM',
    title: 'Test Song Three',
    start: 80,
    bpm: 140,
    bass: null,
    keys: [196.0, 246.94, 293.66], // G3 B3 D4
    vox: null,
  },
];
const BEATS = 32;

/* ----------------------------- audio synthesis ---------------------------- */

const secondsFor = (bpm) => (BEATS * 60) / bpm;
const frames = (bpm) => Math.round(secondsFor(bpm) * SR);

/** 5 ms edges on every note so nothing clicks. */
function env(buf, from, to, attack = 0.005, release = 0.005) {
  const a = Math.round(attack * SR);
  const r = Math.round(release * SR);
  for (let i = 0; i < a && from + i < to; i++) buf[from + i] *= i / a;
  for (let i = 0; i < r && to - 1 - i >= from; i++) buf[to - 1 - i] *= i / r;
}

function tone(buf, freq, startSec, durSec, amp, vibrato = 0) {
  const from = Math.round(startSec * SR);
  const to = Math.min(buf.length, from + Math.round(durSec * SR));
  for (let i = from; i < to; i++) {
    const t = (i - from) / SR;
    const f = vibrato ? freq * (1 + vibrato * Math.sin(2 * Math.PI * 5 * t)) : freq;
    buf[i] += amp * Math.sin(2 * Math.PI * f * t);
  }
  env(buf, from, to);
}

/** Deterministic noise, so the same set is byte-identical every run. */
function makeNoise() {
  let seed = 0x2f6e2b1;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x40000000 - 1;
  };
}

function drums(bpm) {
  const buf = new Float32Array(frames(bpm));
  const noise = makeNoise();
  const beatSec = 60 / bpm;
  for (let b = 0; b < BEATS; b++) {
    const accent = b % 4 === 0;
    const from = Math.round(b * beatSec * SR);
    const len = Math.round(0.08 * SR);
    for (let i = 0; i < len && from + i < buf.length; i++) {
      buf[from + i] += (accent ? 0.5 : 0.28) * noise() * Math.exp(-i / (0.012 * SR));
    }
    // A low thump under the downbeats, so bars are audible without counting.
    if (accent) tone(buf, 90, b * beatSec, 0.1, 0.4);
  }
  return buf;
}

function bass(root, bpm) {
  const buf = new Float32Array(frames(bpm));
  const beatSec = 60 / bpm;
  for (let b = 0; b < BEATS * 2; b++) {
    // Eighth notes on the root, the fifth on beat three of each bar.
    const freq = b % 8 === 4 ? root * 1.5 : root;
    tone(buf, freq, b * beatSec * 0.5, beatSec * 0.4, 0.35);
  }
  return buf;
}

function keys(triad, bpm) {
  const buf = new Float32Array(frames(bpm));
  const barSec = (4 * 60) / bpm;
  for (let bar = 0; bar < BEATS / 4; bar++) {
    // Alternate I and IV so the harmony moves.
    const lift = bar % 2 ? 4 / 3 : 1;
    for (const f of triad) tone(buf, f * lift, bar * barSec, barSec * 0.95, 0.12);
  }
  return buf;
}

function vox(melody, bpm) {
  const buf = new Float32Array(frames(bpm));
  const barSec = (4 * 60) / bpm;
  for (let bar = 0; bar < BEATS / 4; bar++) {
    tone(buf, melody[bar % melody.length], bar * barSec, barSec * 0.9, 0.3, 0.004);
  }
  return buf;
}

function wavBytes(samples) {
  const data = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    data[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  }
  const header = Buffer.alloc(44);
  const body = Buffer.from(data.buffer);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

/* ----------------------- harvesting the real format ----------------------- */

const fail = (msg) => {
  console.error(`make-test-set: ${msg}`);
  process.exit(1);
};

if (!existsSync(TEMPLATE)) fail(`template set not found: ${TEMPLATE}`);
const real = gunzipSync(readFileSync(TEMPLATE)).toString('utf8');

/**
 * Cut one whole element out of the document, from the tag `startRe` matches to
 * its balanced closing tag. Balanced, because <Locators> nests inside itself.
 */
function extractBlock(xml, startRe, from = 0) {
  const m = xml.slice(from).match(startRe);
  if (!m) return null;
  const start = from + m.index;
  if (m[0].endsWith('/>')) return { start, end: start + m[0].length, text: m[0] };
  const tag = (m[0].match(/^<(\w+)/) ?? [])[1];
  if (!tag) return null;
  const scan = new RegExp(`<${tag}(?=[\\s>/])[^>]*?(/?)>|</${tag}>`, 'g');
  scan.lastIndex = start;
  let depth = 0;
  for (let mm; (mm = scan.exec(xml)); ) {
    if (mm[0].startsWith('</')) {
      if (--depth === 0) return { start, end: scan.lastIndex, text: xml.slice(start, scan.lastIndex) };
    } else if (!mm[1]) {
      depth++;
    }
  }
  return null;
}

const tracksOpen = real.indexOf('<Tracks>');
const tracksClose = real.indexOf('</Tracks>');
if (tracksOpen < 0 || tracksClose < 0) fail('template has no Tracks section');

const header = real.slice(0, tracksOpen + '<Tracks>'.length);
const tail = real.slice(tracksClose);

const returnsAt = real.indexOf('<ReturnTrack Id=');
if (returnsAt < 0 || returnsAt > tracksClose) fail('template has no return tracks before </Tracks>');
// Kept whole: every plain track's sends point at these, and dropping them
// would leave the send topology dangling.
const returnsBlock = real.slice(real.lastIndexOf('\n', returnsAt) + 1, tracksClose);

const audioTrackT = extractBlock(real, /<AudioTrack Id="\d+"[^>]*>/)?.text;
const groupTrackT = extractBlock(real, /<GroupTrack Id="\d+"[^>]*>/)?.text;
const audioClipT = extractBlock(real, /<AudioClip Id="\d+"[^>]*>/)?.text;
/*
 * The MIDI templates come from the first track holding an *arrangement* clip —
 * anchoring on ClipTimeable's own events, so a clip sitting in a session slot
 * (a different animal in the same clothes) can't be picked up by mistake.
 */
const arrangedMidiAt = real.search(/<ClipTimeable>\s*<ArrangerAutomation>\s*<Events>\s*<MidiClip/);
const midiTrackT =
  arrangedMidiAt >= 0
    ? extractBlock(real, /<MidiTrack Id="\d+"[^>]*>/, real.lastIndexOf('<MidiTrack Id=', arrangedMidiAt))?.text
    : null;
const midiClipT =
  arrangedMidiAt >= 0 ? extractBlock(real, /<MidiClip Id="\d+"[^>]*>/, arrangedMidiAt)?.text : null;
for (const [name, chunk] of Object.entries({ audioTrackT, groupTrackT, midiTrackT, midiClipT, audioClipT })) {
  if (!chunk) fail(`could not harvest ${name} from the template`);
}
if (!midiTrackT.includes(midiClipT)) fail('harvested MidiTrack does not hold the clip');

/* ------------------------------ patching helpers --------------------------- */

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Replace only the first match, and insist there was one. */
function sub(chunk, re, replacement, what) {
  if (!re.test(chunk)) fail(`nothing to patch for ${what}`);
  return chunk.replace(re, replacement);
}

/*
 * Fresh ids for everything Ableton points at globally. Automation and
 * modulation targets share one namespace across the document (NextPointeeId
 * caps it), so cloned tracks must not repeat the template's numbers.
 */
let nextPointee = 200000;
const NEXT_POINTEE = 400000;

function freshTargets(chunk) {
  // <Pointee> is in the namespace too — Live refuses the file over a duplicate.
  // And tag names can carry dots (ControllerTargets.4), which \w+ won't span.
  return chunk.replace(/<([\w.]*Target[\w.]*|Pointee) Id="\d+"/g, (_, tag) => `<${tag} Id="${nextPointee++}"`);
}

function patchTrack(chunk, { id, name, groupId }) {
  let out = chunk.replace(/^(\s*<(?:Audio|Midi|Group)Track) Id="\d+"/, `$1 Id="${id}"`);
  out = sub(out, /<EffectiveName Value="[^"]*"/, `<EffectiveName Value="${esc(name)}"`, 'track name');
  out = sub(out, /<UserName Value="[^"]*"/, `<UserName Value="${esc(name)}"`, 'track user name');
  out = sub(out, /<TrackGroupId Value="-?\d+"/, `<TrackGroupId Value="${groupId}"`, 'track group');
  // The template track may be muted or pulled down; a stem track plays flat out.
  out = sub(out, /(<Speaker>[\s\S]{0,200}?<Manual Value=")(?:true|false)/, '$1true', 'speaker');
  out = sub(out, /(<Volume>[\s\S]{0,200}?<Manual Value=")[^"]+/, '$11', 'volume');
  // Stale handles and envelopes belong to the template's objects, not ours.
  out = out.replace(/<LomId Value="\d+"/g, '<LomId Value="0"');
  out = out.replace(/<AutomationEnvelopes>[\s\S]*?<\/AutomationEnvelopes>/, '<AutomationEnvelopes>\n\t\t\t\t\t<Envelopes />\n\t\t\t\t</AutomationEnvelopes>');
  return freshTargets(out);
}

/**
 * Put arrangement clips into the track's arranger Events. Anchored on the
 * timeline holder (Sample for audio, ClipTimeable for MIDI) rather than the
 * first Events in sight, because a session clip's envelopes hold Events too.
 */
function withClips(chunk, clipsXml) {
  const at = chunk.search(/<(?:Sample|ClipTimeable)>\s*<ArrangerAutomation>/);
  if (at < 0) fail('track without an arranger timeline');
  const events = extractBlock(chunk, /<Events(?: \/)?>/, at);
  if (!events) fail('no Events container to fill');
  return chunk.slice(0, events.start) + `<Events>${clipsXml}\n</Events>` + chunk.slice(events.end);
}

let clipId = 1;
const injected = { audio: 0, midi: 0 };

function audioClip({ start, end, srcBeat, name, file, bpm, wavPath }) {
  injected.audio++;
  const stat = statSync(wavPath);
  const loopEnd = end - start + srcBeat;
  const lenSec = secondsFor(bpm);
  let c = audioClipT.replace(/^(\s*)<AudioClip Id="\d+" Time="[\d.]+">/, `$1<AudioClip Id="${clipId++}" Time="${start}">`);
  c = sub(c, /<CurrentStart Value="[\d.]+"/, `<CurrentStart Value="${start}"`, 'clip start');
  c = sub(c, /<CurrentEnd Value="[\d.]+"/, `<CurrentEnd Value="${end}"`, 'clip end');
  c = sub(
    c,
    /<Loop>[\s\S]*?<\/Loop>/,
    `<Loop>
											<LoopStart Value="${srcBeat}" />
											<LoopEnd Value="${loopEnd}" />
											<StartRelative Value="0" />
											<LoopOn Value="false" />
											<OutMarker Value="${loopEnd}" />
											<HiddenLoopStart Value="${srcBeat}" />
											<HiddenLoopEnd Value="${loopEnd}" />
										</Loop>`,
    'clip loop',
  );
  c = sub(c, /<Name Value="[^"]*"/, `<Name Value="${esc(name)}"`, 'clip name');
  c = sub(c, /<RelativePathType Value="\d+"/, '<RelativePathType Value="3"', 'path type');
  c = sub(c, /<RelativePath Value="[^"]*"/, `<RelativePath Value="Samples/Imported/${esc(file)}"`, 'relative path');
  c = sub(c, /<Path Value="[^"]*"/, `<Path Value="${esc(wavPath)}"`, 'absolute path');
  c = sub(c, /<OriginalFileSize Value="\d+"/, `<OriginalFileSize Value="${stat.size}"`, 'file size');
  c = sub(c, /<LastModDate Value="\d+"/, `<LastModDate Value="${Math.floor(stat.mtimeMs / 1000)}"`, 'mod date');
  c = sub(c, /<DefaultDuration Value="\d+"/, `<DefaultDuration Value="${frames(bpm)}"`, 'duration');
  c = sub(c, /<DefaultSampleRate Value="\d+"/, `<DefaultSampleRate Value="${SR}"`, 'sample rate');
  c = sub(
    c,
    /<WarpMarkers>[\s\S]*?<\/WarpMarkers>/,
    `<WarpMarkers>
											<WarpMarker Id="0" SecTime="0" BeatTime="0" />
											<WarpMarker Id="1" SecTime="${lenSec}" BeatTime="${BEATS}" />
										</WarpMarkers>`,
    'warp markers',
  );
  c = sub(c, /<IsSongTempoLeader Value="(?:true|false)"/, '<IsSongTempoLeader Value="false"', 'tempo leader');
  return '\n' + freshTargets(c);
}

function midiClip(beat, text) {
  injected.midi++;
  let c = midiClipT.replace(/^(\s*)<MidiClip Id="\d+" Time="[\d.]+">/, `$1<MidiClip Id="${clipId++}" Time="${beat}">`);
  c = sub(c, /<CurrentStart Value="[\d.]+"/, `<CurrentStart Value="${beat}"`, 'clip start');
  c = sub(c, /<CurrentEnd Value="[\d.]+"/, `<CurrentEnd Value="${beat + 1}"`, 'clip end');
  c = sub(
    c,
    /<Loop>[\s\S]*?<\/Loop>/,
    `<Loop>
											<LoopStart Value="0" />
											<LoopEnd Value="1" />
											<StartRelative Value="0" />
											<LoopOn Value="false" />
											<OutMarker Value="1" />
											<HiddenLoopStart Value="0" />
											<HiddenLoopEnd Value="1" />
										</Loop>`,
    'clip loop',
  );
  c = sub(c, /<Name Value="[^"]*"/, `<Name Value="${esc(text)}"`, 'clip name');
  // The template clip's notes belong to its song; a text clip carries none.
  c = sub(c, /<KeyTracks>[\s\S]*?<\/KeyTracks>|<KeyTracks \/>/, '<KeyTracks />', 'notes');
  return '\n' + freshTargets(c);
}

/* ------------------------------ building the set --------------------------- */

mkdirSync(join(DEST, 'Samples/Imported'), { recursive: true });

// The WAVs first: the clips need their real sizes and dates.
const wavs = new Map();
let bytes = 0;
for (const s of SONGS) {
  const short = s.title.replace('Test Song ', '');
  const files = {
    [`${short} Drums.wav`]: drums(s.bpm),
    ...(s.bass ? { [`${short} Bass.wav`]: bass(s.bass, s.bpm) } : {}),
    ...(s.keys ? { [`${short} Keys.wav`]: keys(s.keys, s.bpm) } : {}),
    ...(s.vox ? { [`${short} Vocals.wav`]: vox(s.vox, s.bpm) } : {}),
  };
  for (const [name, samples] of Object.entries(files)) {
    const wav = wavBytes(samples);
    const path = join(DEST, 'Samples/Imported', name);
    writeFileSync(path, wav);
    wavs.set(name, path);
    bytes += wav.length;
  }
}

const tracks = [];
for (const s of SONGS) {
  const groupId = nextPointee++;
  tracks.push(patchTrack(groupTrackT, { id: groupId, name: s.title, groupId: -1 }));

  const short = s.title.replace('Test Song ', '');
  const end = s.start + BEATS;
  const stem = (part, clips) =>
    tracks.push(withClips(patchTrack(audioTrackT, { id: nextPointee++, name: part, groupId }), clips.join('')));
  const clip = (start, stop, srcBeat, file) =>
    audioClip({ start, end: stop, srcBeat, name: file.replace('.wav', ''), file, bpm: s.bpm, wavPath: wavs.get(file) });

  stem('Drums', [clip(s.start, end, 0, `${short} Drums.wav`)]);
  if (s.bass) stem('Bass', [clip(s.start, end, 0, `${short} Bass.wav`)]);
  if (s.keys) {
    // Song three's keys sit out bars 3–4 and 7–8: two clips with a gap, the
    // second starting part way into its file, which is what forces a render.
    const clips =
      s.title === 'Test Song Three'
        ? [clip(s.start, s.start + 8, 0, `${short} Keys.wav`), clip(s.start + 16, s.start + 24, 16, `${short} Keys.wav`)]
        : [clip(s.start, end, 0, `${short} Keys.wav`)];
    stem('Keys', clips);
  }
  if (s.vox) stem('Vocals', [clip(s.start, end, 0, `${short} Vocals.wav`)]);
}

const midi = (name, clips) =>
  tracks.push(withClips(patchTrack(midiTrackT, { id: nextPointee++, name, groupId: -1 }), clips.join('')));

midi('+SECTIONS', [
  midiClip(0, 'Intro'),
  midiClip(8, 'Verse'),
  midiClip(16, 'Chorus'),
  midiClip(24, 'Outro'),
  midiClip(40, 'Verse'),
  midiClip(56, 'Chorus'),
  midiClip(80, 'Riff'),
  midiClip(96, 'Riff again'),
]);
midi('Lead +LYRICS', [
  midiClip(0, 'This is the first test song'),
  midiClip(8, 'Every part is a simple tone'),
  midiClip(16, 'The chorus lands on bar five'),
  midiClip(40, 'Second song, slower now'),
  midiClip(44, '[Am]'), // a chord written on the lyric track, AbleSet-style
  midiClip(56, 'And this one has a vocal line'),
]);
midi('Chords +LYRICS', [
  midiClip(0, 'C'),
  midiClip(4, 'F'),
  midiClip(16, 'G'),
  midiClip(40, 'Am'),
  midiClip(48, 'F'),
  midiClip(80, 'G'),
  midiClip(88, 'C'),
]);

/* ------------------------- the wrapper, made ours -------------------------- */

let head = sub(header, /<NextPointeeId Value="\d+"/, `<NextPointeeId Value="${NEXT_POINTEE}"`, 'pointee counter');

let foot = sub(tail, /(<Tempo>[\s\S]{0,200}?<Manual Value=")[\d.]+/, '$1120', 'main tempo');

// The tempo envelope: pairs of events make each change a step, not a glide.
const tempoTargetId = (foot.match(/<Tempo>[\s\S]{0,700}?<AutomationTarget Id="(\d+)"/) ?? [])[1];
if (!tempoTargetId) fail('no tempo automation target in the template');
const tempoEnvelope = extractBlock(foot, new RegExp(`<AutomationEnvelope Id="\\d+">\\s*<EnvelopeTarget>\\s*<PointeeId Value="${tempoTargetId}"`));
if (!tempoEnvelope) fail('no tempo envelope in the template');
const tempoEvents = extractBlock(tempoEnvelope.text, /<Events>/);
if (!tempoEvents) fail('tempo envelope has no events');
let ev = 300000;
const step = (time, bpm) => `\n								<FloatEvent Id="${ev++}" Time="${time}" Value="${bpm}" />`;
const newEnvelope =
  tempoEnvelope.text.slice(0, tempoEvents.start) +
  `<Events>${step(-63072000, 120)}${step(40, 120)}${step(40, 96)}${step(80, 96)}${step(80, 140)}\n							</Events>` +
  tempoEnvelope.text.slice(tempoEvents.end);
foot = foot.slice(0, tempoEnvelope.start) + newEnvelope + foot.slice(tempoEnvelope.end);

const locatorList = [];
// Locators live in the pointee namespace too: ids 1..6 collided with the main
// track's mixer targets, and Live called the whole file corrupt over it.
const locator = (beat, name) =>
  locatorList.push(`				<Locator Id="${nextPointee++}">
					<LomId Value="0" />
					<Time Value="${beat}" />
					<Name Value="${esc(name)}" />
					<Annotation Value="" />
					<IsSongStart Value="false" />
				</Locator>`);
for (const s of SONGS) {
  locator(s.start, s.locator);
  locator(s.start + BEATS, 'AUTOSTOP');
}
const oldLocators = extractBlock(foot, /<Locators>/);
if (!oldLocators) fail('no locators block in the template');
foot =
  foot.slice(0, oldLocators.start) +
  `<Locators>
			<Locators>
${locatorList.join('\n')}
			</Locators>
		</Locators>` +
  foot.slice(oldLocators.end);

const xml = `${head}\n${tracks.join('\n')}\n${returnsBlock}${foot}`;

/* ------------------------------ verify & write ----------------------------- */

const parsed = parseAlsXml(xml);
if (parsed.songs.length !== 3) fail(`expected 3 songs, parsed ${parsed.songs.length}`);
for (const [i, song] of parsed.songs.entries()) {
  const want = SONGS[i];
  if (song.title !== want.title) fail(`song ${i + 1} titled "${song.title}"`);
  if (song.bpm !== want.bpm) fail(`${song.title} at ${song.bpm} BPM`);
  if (!song.stems.length) fail(`${song.title} has no stems`);
  if (song.stems.some((st) => !st.path.startsWith('Samples/Imported/'))) {
    fail(`${song.title} has a stem with a stray path`);
  }
  if (song.stems.some((st) => st.regions?.length === 0)) fail(`${song.title} has a muted stem`);
}
if (parsed.tempo !== 120) fail(`main tempo parsed as ${parsed.tempo}`);
if (parsed.songs[0].sections.length !== 4) fail('song one lost its sections');
if (!parsed.songs[1].chords.some((c) => c.text === 'Am')) fail('the bracketed Am went missing');
if (parsed.songs[1].tempoChanges.some((t) => t.bpm !== 96)) fail('song two tempo automation is wrong');
const gappedKeys = parsed.songs[2].stems.find((s) => s.name === 'Keys');
if (!gappedKeys || gappedKeys.regions?.length !== 2) fail('song three keys should have two regions');
if (parsed.warnings.length) fail(parsed.warnings.join('; '));

/*
 * Exactly the clips that were put in, and none of the template's. A session
 * clip smuggled along inside a cloned slot would play the Coldplay set's
 * material out of nowhere, so it is worth a hard count.
 */
const audioClips = (xml.match(/<AudioClip Id=/g) ?? []).length;
const midiClips = (xml.match(/<MidiClip Id=/g) ?? []).length;
if (audioClips !== injected.audio) fail(`${audioClips} audio clips in the set, injected ${injected.audio}`);
if (midiClips !== injected.midi) fail(`${midiClips} MIDI clips in the set, injected ${injected.midi}`);

/*
 * Live's pointee namespace is bigger than any list worth hard-coding — it has
 * already turned out to hold targets, <Pointee>, and the locators. So instead
 * of naming its members, hold the generated document to the template's own id
 * discipline: any id-bearing element kind that never repeats an id in the
 * template must not repeat one here, and two kinds that never share an id
 * there must not share one here. Every violation so far would have been
 * caught by exactly this.
 */
function idsByTag(doc) {
  const byTag = new Map();
  for (const m of doc.matchAll(/<([\w.]+) Id="(\d+)"/g)) {
    if (!byTag.has(m[1])) byTag.set(m[1], []);
    byTag.get(m[1]).push(Number(m[2]));
  }
  return byTag;
}
const realIds = idsByTag(real);
const genIds = idsByTag(xml);
const uniqueTags = [...genIds.keys()].filter((t) => {
  const ids = realIds.get(t);
  return ids && new Set(ids).size === ids.length;
});
for (const tag of uniqueTags) {
  const ids = genIds.get(tag);
  if (new Set(ids).size !== ids.length) fail(`duplicate ${tag} ids in the document`);
  if (ids.some((id) => id >= NEXT_POINTEE)) fail(`a ${tag} id passed NextPointeeId`);
}
for (let i = 0; i < uniqueTags.length; i++) {
  for (let j = i + 1; j < uniqueTags.length; j++) {
    const [a, b] = [uniqueTags[i], uniqueTags[j]];
    const realA = new Set(realIds.get(a));
    if (realIds.get(b).some((id) => realA.has(id))) continue; // distinct namespaces in the template too
    const genA = new Set(genIds.get(a));
    if (genIds.get(b).some((id) => genA.has(id))) fail(`${a} and ${b} share an id, which the template never does`);
  }
}

// Well-formedness matters to Live, not just to our forgiving parser.
try {
  execFileSync('xmllint', ['--noout', '-'], { input: xml });
} catch (e) {
  if (e.code === 'ENOENT') console.warn('xmllint not found; skipping well-formedness check');
  else fail(`the document is not well-formed XML: ${e.stderr ?? e.message}`);
}

const gz = gzipSync(Buffer.from(xml));
if (gunzipSync(gz).toString() !== xml) fail('gzip round trip broke');
writeFileSync(join(DEST, SET_NAME), gz);

console.log(
  `Wrote ${SET_NAME} (${(xml.length / 1e6).toFixed(1)} MB of XML, from the template's format) ` +
    `and ${(bytes / 1e6).toFixed(1)} MB of stems to:\n  ${DEST}`,
);

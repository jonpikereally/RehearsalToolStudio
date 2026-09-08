import type { Bus, Device } from '../types';
/**
 * Reading an Ableton Live set.
 *
 * A `.als` is gzipped XML, which the browser can unpack natively, so no library
 * is involved. Songs come from **locators**, following AbleSet's convention:
 * a plain locator starts a song, `>` marks a section, `*` hides one, and
 * `STOP` / `AUTOSTOP` end playback.
 *
 * The set is one long timeline holding every song end to end, so each song runs
 * from its locator to the next stop marker, and everything inside — sections,
 * chords, lyrics, tempo changes — is reported relative to that song's own bar 1.
 */

import { isRigLocator } from './alsPatch.ts';
import { rigTrackMember, sendsPatches, withoutPatchFlag } from './rigTrack.ts';
import { transposeKey } from './nashville.ts';

export interface TempoChange {
  /** Beats from the start of the set. */
  beat: number;
  bpm: number;
}

export interface AlsEvent {
  /** 1-based bar within the song. */
  bar: number;
  text: string;
  /**
   * How many bars the clip it came from runs, when the set said — a chord
   * held for two bars is a two-bar clip. Kept so anything writing these back
   * into a set can draw them as they were drawn; the library keeps only the
   * bar and the text.
   */
  bars?: number;
}

export interface AlsSong {
  /** Title with metadata stripped off. */
  title: string;
  /** The locator name exactly as written. */
  raw: string;
  startBar: number;
  endBar: number;
  /** Read from the locator name where present. */
  bpm: number | null;
  key: string | null;
  /**
   * Key changes marked inside the song, in song-relative bars: a clip named
   * `Key: A` or `Key change: F#m` on any MIDI track — the song info clips
   * the studio writes carry one at the top, and a modulation is marked by
   * another later on. Sorted; the first may restate the song's own key.
   */
  keyChanges: { bar: number; key: string }[];
  durationText: string | null;
  tags: string[];
  /** AbleSet flags the locator carried — LOOP, PAUSE, SKIP, END. */
  flags: string[];
  /**
   * Whether a STOP/AUTOSTOP locator ends this song, as opposed to it running
   * straight into the next song — or, for the last one, off the end of the set.
   */
  endsAtStop: boolean;
  /**
   * The tempo actually in force where the song starts: the last automation
   * point at or before its locator, else the set tempo. `bpm` is only what the
   * locator *says*; live playback follows this.
   */
  startBpm: number;
  /** Bars (song-relative) where a clip on a Slate track starts. */
  slateBars: number[];
  sections: AlsEvent[];
  chords: AlsEvent[];
  lyrics: AlsEvent[];
  /** Every text track the set carries, each kept separate and named. */
  lanes: AlsLane[];
  /** Tempo changes inside this song, in song-relative bars. */
  tempoChanges: { bar: number; bpm: number }[];
  /** Locators the app wrote for the rig, still as names. */
  rigMarks: { bar: number; name: string }[];
  /** The time signature in force where the song starts. */
  timeSigNum: number;
  timeSigDen: number;
  /**
   * What this app cannot play as Ableton does: a time signature change
   * partway through, say. Shown with the song, so nobody is surprised.
   */
  caveats: string[];
  /**
   * What the set says about the song: the info text on the group track named
   * after it, as typed in Live. "Piano intro", "watch the drummer for the
   * stop" — the things a band writes to itself. Empty when there is none.
   */
  notes: string;
  /**
   * The set's own rig tracks — MIDI to a pedalboard or the lights, a video
   * track, a timecode track — cut down to what plays inside this song.
   */
  rigTracks: AlsRigTrack[];
  /** Patch changes the rig tracks' MIDI clips send inside this song. */
  rigPatches: AlsRigPatch[];
  /**
   * Audio files Ableton has on this song's tracks, when it has its own group.
   * `regions` is null when the track plays throughout, which is the usual case.
   */
  stems: {
    name: string;
    /** The track's Id in the set, for another tool that reads the set itself; none for a part the studio made up, like the click. */
    trackId?: string;
    /**
     * A reference recording rather than a part of the band's own mix: the
     * finished record to play against, or a piece of it. True when the track
     * says so itself or sits in a REF folder inside the song's group.
     */
    reference: boolean;
    /** The track's fader times every group's above it, as a linear gain. */
    gain: number;
    /** The track's pan with its groups' added, -1..1. */
    pan: number;
    /**
     * Frozen in Live: what plays is Live's render of the track, so the
     * clips are its freeze file and the track's own devices are inside it.
     * The groups' devices are not, and are still listed.
     */
    frozen: boolean;
    /** The devices on the track and then on each group above it, in order. */
    devices: Device[];
    /** Return buses the signal is sent into on its way, by index. */
    sends: { bus: number; level: number }[];
    /** Whether the signal reaches an output on its own, or only through sends. */
    direct: boolean;
    path: string;
    regions: { startBar: number; endBar: number }[] | null;
    /** Every clip this track plays inside this song, in order. */
    clips: AlsClip[];
  }[];
}

/** A track that drives the rig rather than the band, and its clips in one song. */
export interface AlsRigTrack {
  name: string;
  kind: 'midi' | 'audio' | 'video';
  clips: { name: string; startBar: number; endBar: number }[];
}

/**
 * A patch change a MIDI clip sends, as Live would send it.
 *
 * A clip on a rig track carries a program change and bank in its own box,
 * and control changes as envelopes; when it starts, Live sends the program
 * and every envelope's value, and each later step of an envelope as it
 * comes. All on the channel the track is routed to. That is how a set
 * drives a Quad Cortex or a Helix without a locator in sight, and it is
 * read here as what goes down the wire — bank and program as the bytes,
 * not as Live's one-based display of them.
 */
export interface AlsRigPatch {
  /** Song-relative, 1-based, fractional where an envelope steps mid-bar. */
  bar: number;
  /** The clip's name, for saying what the change is. */
  name: string;
  track: string;
  /** 1–16, from the track's MIDI output routing. */
  channel: number;
  /** Whose change it is, when the track is named `RIG <member> (<rig>)`. */
  member?: string;
  rig?: string;
  program?: number;
  /** MSB × 128 + LSB, as the two bank-select messages carry it. */
  bank?: number;
  controls?: { cc: number; value: number }[];
}

/**
 * One `+LYRICS` track's worth of text.
 *
 * A set may carry several — lead lyrics, chords, backing-vocal cues, notes to
 * the drummer — and which of those are worth looking at depends on who is
 * reading, so they stay separate all the way to the screen rather than being
 * flattened into one lyric line and one chord line here.
 */
/** A clip as the set stores it, still in project beats. */
interface RawClip {
  path: string;
  startBeat: number;
  endBeat: number;
  /** Where in the file the clip begins, in the file's own beats. */
  sourceStartBeat: number;
  disabled: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  /** Beats of the file per second of it, or null when the clip isn't warped. */
  warpBps: number | null;
  sampleRate: number | null;
  /** The clip's own transposition, in semitones, as set in Live. */
  semitones: number;
  /** The clip's own gain, linear: 1 for none. */
  gain: number;
  /** The file's absolute path as Live also writes it, for one outside the project. */
  absPath: string | null;
  /**
   * A clip of the track's freeze file rather than of its own: Live's render
   * of the track, with its warping, its transposition and its devices already
   * in it. Plays at its own pitch and speed, and never through the devices.
   */
  frozen: boolean;
}

/**
 * One clip of a track, cut to a song and expressed in that song's bars.
 *
 * This is what a renderer needs: which file, which slice of it, where it lands,
 * and how it fades. `sourceStartSec` is already in seconds, so nothing
 * downstream has to know about Ableton's beat-based sample positions.
 */
export interface AlsClip {
  path: string;
  startBar: number;
  endBar: number;
  /** Offset into the file where this clip starts playing. */
  sourceStartSec: number;
  disabled: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  /** False means the file plays at its own speed and ignores the set's tempo. */
  warped: boolean;
  /** The clip's own transposition in Live, in semitones; 0 for none. */
  semitones: number;
  /**
   * How much faster than its own file the clip plays, from its warp: 1 when
   * the file was made at the song's tempo, which is the usual case for a
   * stem; 1.1 for a file warped up a tenth to match.
   */
  speed: number;
  /** The clip's own gain in Live, linear; 1 for none. */
  gain: number;
  /**
   * The clip plays Live's own render of the track — a frozen track's file —
   * so it is already at pitch and speed, through its devices. The studio and
   * the preparer shift nothing and imitate nothing for such a clip.
   */
  frozen?: true;
  /**
   * The file's absolute path, when Live wrote one. A sample outside the
   * project — a click, a bank of cues — is found by this when the relative
   * path leads out of the folder.
   */
  absPath?: string;
  /**
   * For a clip born of a MIDI note on a drum rack: the note, its velocity as
   * Live had it (1..127), and the pad's own level times the track's, apart
   * from that velocity. `gain` folds all three for the renderer; a sampler
   * part wants them separately, since its player applies velocity itself.
   */
  note?: number;
  velocity?: number;
  padGain?: number;
  /** For a set part's clip: the track it came from, since Cues sums several. */
  track?: string;
}

export interface AlsLane {
  /** Stable across scans, derived from the track name. */
  id: string;
  /** The track name with its AbleSet flags stripped off. */
  name: string;
  kind: 'lyrics' | 'chords';
  items: AlsEvent[];
}

export interface AlsProject {
  /** The set's return buses, in order; what a track's sends name. */
  buses?: Bus[];
  creator: string;
  tempo: number;
  timeSigNum: number;
  timeSigDen: number;
  songs: AlsSong[];
  /** Songs the set defines but which carry no audio we can find. */
  warnings: string[];
}

/* ------------------------------ decompression ----------------------------- */

/** `.als` files are gzipped XML; DecompressionStream handles that natively. */
export async function inflateAls(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/* -------------------------------- locators -------------------------------- */

const STOP_NAMES = /^(auto)?stop$|^song end$/i;

/**
 * Pull the metadata written into locator names.
 *
 * AbleSet's own syntax covers `{description}`, `[3:20]`, `#tags` and `[nosong]`.
 * On top of that these sets use a loose slash-separated form —
 * `Fix You / 5:00 / Eb / 136BPM` — with the fields in no fixed order and
 * occasional missing separators, so each field is recognised by its shape
 * rather than its position.
 */
export function parseLocatorName(raw: string): {
  title: string;
  bpm: number | null;
  key: string | null;
  durationText: string | null;
  tags: string[];
  flags: string[];
} {
  let rest = raw.trim();
  const tags: string[] = [];
  const flags: string[] = [];
  let bpm: number | null = null;
  let key: string | null = null;
  let durationText: string | null = null;

  /*
   * AbleSet's own flags on a locator — how it loops, pauses or skips. They say
   * nothing about which song this is, and left in they become part of its name;
   * but the set checker wants to know a song was marked +END or +PAUSE, so they
   * are kept as flags rather than merely dropped.
   */
  rest = rest.replace(/\s*\+(LOOPFULL|LOOP(:\d+)?|PAUSE|SKIP|END)\b/gi, (_, flag: string) => {
    flags.push(flag.toUpperCase());
    return ' ';
  });

  // AbleSet's pinned duration: "Follow Night [3:20]".
  rest = rest.replace(/\[\s*(\d{1,2}:\d{2})\s*\]/, (_, d: string) => {
    durationText = d;
    return ' ';
  });

  // #tags — must follow whitespace, or the sharp in a key like C#m is eaten.
  rest = rest.replace(/(^|\s)#([\w-]+)/g, (_, lead, t) => {
    tags.push(t);
    return lead;
  });

  // AbleSet's bracketed attributes: [nosong], [blue], [.bold]
  rest = rest.replace(/\[(nosong|\.[\w-]+|[a-z]+)\]/gi, ' ');

  // {description} — treated as more metadata fields
  let inner = '';
  rest = rest.replace(/\{([^}]*)\}?/g, (_, body) => {
    inner = body;
    return ' ';
  });

  const takeFrom = (text: string, isTitleField: boolean): string => {
    let out = text;
    const dur = out.match(/\b(\d{1,2}:\d{2})\b/);
    if (dur && !durationText) {
      durationText = dur[1];
      out = out.replace(dur[0], ' ');
    }
    const tempo = out.match(/([\d.]+)\s*bpm/i);
    if (tempo && bpm == null) {
      const n = parseFloat(tempo[1]);
      if (n >= 20 && n <= 300) bpm = n;
      out = out.replace(tempo[0], ' ');
    }
    // Said outright — "{Key: C}" — it counts wherever it appears.
    if (key == null) {
      const said = out.match(/\bkey\s*[:=]\s*([A-G])([#b]?)\s*(m|min|maj|major|minor)?\b/i);
      if (said) {
        key = said[1].toUpperCase() + said[2].toLowerCase() + (said[3] ? said[3].toLowerCase() : '');
        out = out.replace(said[0], ' ');
      }
    }
    // "Play in Bb" says the key outright, wherever it sits in the name.
    if (key == null) {
      const played = out.match(/\bplay in ([A-G])([#b]?)\s*(m|min|minor)?\b/i);
      if (played) {
        key = played[1].toUpperCase() + played[2].toLowerCase() + (played[3] ? 'm' : '');
      }
    }
    // A key only counts on its own, so a title word is never mistaken for one.
    if (!isTitleField && key == null) {
      const k = out.trim().match(/^([A-G])([#b]?)\s*(m|min|maj|major|minor)?$/i);
      if (k) {
        // Only the note letter is capitalised — "eb" is E flat, not E and B.
        key = k[1].toUpperCase() + k[2].toLowerCase() + (k[3] ? k[3].toLowerCase() : '');
        out = out.replace(k[0], ' ');
      }
    }
    return out;
  };

  const fields = (rest + ' / ' + inner).split('/');
  const cleaned = fields.map((f, i) => takeFrom(f, i === 0));

  const title = cleaned[0].replace(/\s{2,}/g, ' ').replace(/^[\s\-–—_.]+|[\s\-–—_]+$/g, '').trim();
  return { title: title || raw.trim(), bpm, key, durationText, tags, flags };
}

/* --------------------------------- parsing -------------------------------- */

interface Track {
  kind: string;
  id: string;
  groupId: string;
  name: string;
  chunk: string;
  /** The track's info text, as Live's Annotation field. */
  annotation: string;
  /** The fader, as a linear gain: 1 is 0 dB. */
  gain: number;
  /** -1 hard left, 0 centre, 1 hard right. */
  pan: number;
  devices: Device[];
  output: 'main' | 'group' | 'none' | 'external';
  sends: { bus: number; level: number }[];
}

/**
 * The devices on a track, in order, with the knobs this app can read.
 *
 * Only the track's own chain is read — a rack's inner chains are flattened
 * into it, which is a rough reading of a rack but a true list of what is
 * on the track. Every device is named, so what cannot be imitated is still
 * said; the imitation itself lives in fx.ts.
 */
const DEVICE_KINDS =
  'Eq8|GlueCompressor|Compressor2|Limiter|Utility|Reverb|HybridReverb|Delay|Echo|AutoFilter|Saturator|Gate|MultibandDynamics|AudioEffectGroupDevice|MxDeviceAudioEffect|PluginDevice|AuPluginDevice|Vst3PluginDevice|Vst2PluginDevice|Overdrive|Pedal|Redux|Erosion|Amp|Cabinet|Chorus2|PhaserNew|FlangerNew|Corpus|Resonator|Vocoder|Roar|DrumBuss|Shifter|AutoPan|BeatRepeat|FilterDelay|GrainDelay|Looper|Tuner|Spectrum|StereoGain|ChannelEq|Eq3';
const SUPPORTED_KINDS = new Set(['Eq8', 'GlueCompressor', 'Compressor2', 'Limiter', 'Utility', 'Reverb', 'AutoFilter', 'Saturator']);
const DEVICE_PARAMS: Record<string, string[]> = {
  Eq8: ['GlobalGain', 'Scale'],
  GlueCompressor: ['Threshold', 'Ratio', 'Attack', 'Release', 'Makeup', 'DryWet', 'Range'],
  Compressor2: ['Threshold', 'Ratio', 'Attack', 'Release', 'Knee', 'Gain', 'DryWet', 'Model'],
  Limiter: ['Gain', 'Ceiling', 'Release'],
  Utility: ['Gain', 'Mute', 'StereoWidth'],
  Reverb: ['DecayTime', 'PreDelay', 'RoomSize', 'DryWet'],
  AutoFilter: ['Cutoff', 'Frequency', 'Resonance', 'FilterType'],
  Saturator: ['PreDrive', 'DryWet'],
};

function devicesOf(chunk: string): Device[] {
  const chain = chunk.match(/<DeviceChain>[\s\S]*?<Devices>([\s\S]*?)<\/Devices>/)?.[1] ?? '';
  const out: Device[] = [];
  const re = new RegExp(`<(${DEVICE_KINDS}) Id="\\d+">([\\s\\S]*?)</\\1>`, 'g');
  for (const m of chain.matchAll(re)) {
    const kind = m[1];
    const body = m[2];
    const manual = (name: string): number | boolean | null => {
      const raw = body.match(new RegExp(`<${name}>\\s*<LomId[^>]*>\\s*<Manual Value="([^"]*)"`))?.[1];
      if (raw === undefined) return null;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    };
    const params: Record<string, number | boolean> = {};
    for (const key of DEVICE_PARAMS[kind] ?? []) {
      const v = manual(key);
      if (v !== null) params[key] = v;
    }
    const on = manual('On');
    let name = '';
    if (/Plugin/.test(kind)) {
      name = decodeXml(body.match(/<(?:Name|PlugName) Value="([^"]+)"/)?.[1] ?? '');
    } else if (kind === 'MxDeviceAudioEffect') {
      const file = body.match(/<RelativePath Value="([^"]+)"/)?.[1] ?? '';
      name = decodeXml(file.split('/').pop()?.replace(/\.amxd$/i, '') ?? '');
    } else {
      name = decodeXml(body.match(/<UserName Value="([^"]+)"/)?.[1] ?? '');
    }
    const device: Device = { kind, name, on: on === null ? true : on === true, supported: SUPPORTED_KINDS.has(kind), params };
    if (kind === 'Eq8') {
      device.bands = [];
      for (let b = 0; b < 8; b++) {
        const band = body.match(new RegExp(`<Bands\\.${b}>[\\s\\S]*?<ParameterA>([\\s\\S]*?)</ParameterA>`))?.[1];
        if (!band) continue;
        const read = (key: string, fallback: number) => {
          const v = parseFloat(band.match(new RegExp(`<${key}>\\s*<LomId[^>]*>\\s*<Manual Value="([^"]*)"`))?.[1] ?? '');
          return Number.isFinite(v) ? v : fallback;
        };
        device.bands.push({
          on: /<IsOn>\s*<LomId[^>]*>\s*<Manual Value="true"/.test(band),
          mode: read('Mode', 3),
          freq: read('Freq', 1000),
          gain: read('Gain', 0),
          q: read('Q', 0.7071),
        });
      }
    }
    out.push(device);
  }
  return out;
}

/** Where a track's output goes, and what it sends to the return buses. */
function routingOf(chunk: string): { output: 'main' | 'group' | 'none' | 'external'; sends: { bus: number; level: number }[] } {
  const target = chunk.match(/<AudioOutputRouting>[\s\S]*?<Target Value="([^"]*)"/)?.[1] ?? 'AudioOut/Main';
  const output = /GroupTrack/.test(target)
    ? 'group'
    : /None/.test(target)
      ? 'none'
      : /External/.test(target)
        ? 'external'
        : 'main';
  const block = chunk.match(/<Sends>([\s\S]*?)<\/Sends>/)?.[1] ?? '';
  const sends: { bus: number; level: number }[] = [];
  [...block.matchAll(/<TrackSendHolder Id="\d+">([\s\S]*?)<\/TrackSendHolder>/g)].forEach((m, index) => {
    const level = parseFloat(m[1].match(/<Send>\s*<LomId[^>]*>\s*<Manual Value="([^"]*)"/)?.[1] ?? '0');
    const active = !/<Active Value="false"/.test(m[1]);
    // Live's send floor is -70 dB, written as 0.000316: off, not a whisper.
    if (active && Number.isFinite(level) && level > 0.002) sends.push({ bus: index, level });
  });
  return { output, sends };
}

/**
 * A drum rack's pads: which note plays which sample, at what level and
 * from where in the file. Live stores the pad's note as 128 minus it.
 */
interface Pad {
  path: string;
  absPath: string | null;
  gain: number;
  startSec: number;
}

function drumPads(chunk: string): Map<number, Pad> {
  const pads = new Map<number, Pad>();
  const rack = chunk.match(/<DrumGroupDevice Id="\d+">[\s\S]*?<\/DrumGroupDevice>/)?.[0];
  if (!rack) return pads;
  for (const m of rack.matchAll(/<DrumBranch Id="\d+">([\s\S]*?)<\/DrumBranch>/g)) {
    const body = m[1];
    const recv = parseInt(body.match(/<ReceivingNote Value="(\d+)"/)?.[1] ?? '', 10);
    const sample = body.match(/<SampleRef>[\s\S]*?<\/SampleRef>/)?.[0];
    if (!Number.isFinite(recv) || !sample) continue;
    const path = decodeXml(sample.match(/<RelativePath Value="([^"]+)"/)?.[1] ?? sample.match(/<Path Value="([^"]+)"/)?.[1] ?? '');
    if (!path) continue;
    const absPath = decodeXml(sample.match(/<Path Value="([^"]+)"/)?.[1] ?? '') || null;
    const rate = parseFloat(sample.match(/<DefaultSampleRate Value="(\d+)"/)?.[1] ?? '48000') || 48000;
    const startFrames = parseFloat(body.match(/<SampleStart Value="([-\d.]+)"/)?.[1] ?? '0') || 0;
    // The pad's Simpler has its own volume, in dB.
    const db = parseFloat(body.match(/<Volume>\s*<LomId[^>]*>\s*<Manual Value="([-\d.]+)"/)?.[1] ?? '0') || 0;
    pads.set(128 - recv, { path, absPath, gain: 10 ** (db / 20), startSec: startFrames / rate });
  }
  return pads;
}

/**
 * The notes a MIDI track plays, laid out in set beats: each clip's notes,
 * repeated through its loop for as long as the clip runs. A rack track's
 * whole part is these, each note become its pad's sample.
 */
function midiNotes(chunk: string): { beat: number; key: number; velocity: number }[] {
  const out: { beat: number; key: number; velocity: number }[] = [];
  for (const m of chunk.matchAll(/<MidiClip Id="\d+"[^>]*>([\s\S]*?)<\/MidiClip>/g)) {
    const body = m[1];
    const num = (re: RegExp, fallback: number) => {
      const v = parseFloat(body.match(re)?.[1] ?? '');
      return Number.isFinite(v) ? v : fallback;
    };
    if (/<Disabled Value="true"/.test(body)) continue;
    const start = num(/<CurrentStart Value="([-\d.]+)"/, NaN);
    const end = num(/<CurrentEnd Value="([-\d.]+)"/, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const loopStart = num(/<LoopStart Value="([-\d.]+)"/, 0);
    const loopEnd = num(/<LoopEnd Value="([-\d.]+)"/, end - start + loopStart);
    const loopOn = /<LoopOn Value="true"/.test(body);
    const startRel = num(/<StartRelative Value="([-\d.]+)"/, 0);
    const length = loopEnd - loopStart;
    if (length <= 0) continue;
    const notes: { time: number; key: number; velocity: number }[] = [];
    for (const k of body.matchAll(/<KeyTrack Id="\d+">([\s\S]*?)<\/KeyTrack>/g)) {
      const key = parseInt(k[1].match(/<MidiKey Value="(\d+)"/)?.[1] ?? '', 10);
      if (!Number.isFinite(key)) continue;
      for (const n of k[1].matchAll(/<MidiNoteEvent ([^>]*)\/>/g)) {
        const attrs = n[1];
        if (/IsEnabled="false"/.test(attrs)) continue;
        const time = parseFloat(attrs.match(/\bTime="([-\d.]+)"/)?.[1] ?? '');
        const velocity = parseFloat(attrs.match(/Velocity="([-\d.]+)"/)?.[1] ?? '100');
        if (Number.isFinite(time)) notes.push({ time, key, velocity: Number.isFinite(velocity) ? velocity : 100 });
      }
    }
    if (!notes.length) continue;
    // The clip shows its loop from `startRel` in; a looping clip goes round
    // until it ends, a one-shot clip plays its loop once.
    const passes = loopOn ? Math.ceil((end - start + startRel) / length) + 1 : 1;
    for (let pass = 0; pass < passes; pass++) {
      for (const note of notes) {
        const beat = start + pass * length + (note.time - loopStart) - startRel;
        if (beat < start - 1e-6 || beat >= end - 1e-6) continue;
        out.push({ beat, key: note.key, velocity: note.velocity });
      }
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

/** A track's own fader and pan, from its mixer section. */
function mixerOf(chunk: string): { gain: number; pan: number } {
  const mixer = chunk.match(/<Mixer>[\s\S]*?<\/Mixer>/)?.[0] ?? '';
  const gain = parseFloat((mixer.match(/<Volume>\s*<LomId[^>]*>\s*<Manual Value="([-\d.]+)"/) ?? [])[1] ?? '1');
  const pan = parseFloat((mixer.match(/<Pan>\s*<LomId[^>]*>\s*<Manual Value="([-\d.]+)"/) ?? [])[1] ?? '0');
  return { gain: Number.isFinite(gain) ? gain : 1, pan: Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0 };
}

/**
 * Live writes a time signature as one number: the numerator less one, plus
 * 99 for each doubling of the denominator — 201 is 4/4, 199 is 2/4.
 */
function decodeSignature(value: number): { num: number; den: number } {
  return { num: (value % 99) + 1, den: 2 ** Math.floor(value / 99) };
}

interface Clip {
  beat: number;
  /** Where the clip ends; NaN when the set did not say. */
  endBeat: number;
  name: string;
}

/**
 * The clips on a track. A text track's clips are their names, so an unnamed
 * one is nothing; a rig track's clip is what it sends, name or no name, and
 * `unnamed` is what to call one when it comes.
 */
function clipsOf(chunk: string, tag: 'MidiClip' | 'AudioClip', unnamed?: string): Clip[] {
  const re = new RegExp(`<${tag} Id="\\d+"[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  return [...chunk.matchAll(re)]
    .map((m) => ({
      beat: parseFloat((m[1].match(/<CurrentStart Value="([-\d.]+)"/) ?? [])[1] ?? 'NaN'),
      endBeat: parseFloat((m[1].match(/<CurrentEnd Value="([-\d.]+)"/) ?? [])[1] ?? 'NaN'),
      name: decodeXml((m[1].match(/<Name Value="([^"]*)"/) ?? [])[1] ?? '') || (unnamed ?? ''),
    }))
    .filter((c) => c.name && !Number.isNaN(c.beat))
    .sort((a, b) => a.beat - b.beat);
}

/** Keep only the last value at each bar, which is the one that takes effect. */
function dedupeByBar(points: { bar: number; bpm: number }[]): { bar: number; bpm: number }[] {
  const byBar = new Map<number, number>();
  for (const p of points) byBar.set(p.bar, p.bpm);
  return [...byBar.entries()].map(([bar, bpm]) => ({ bar, bpm })).sort((a, b) => a.bar - b.bar);
}

/** Find a track by an AbleSet-style flag in its name, e.g. `+LYRICS`. */
function trackByFlag(tracks: Track[], flag: RegExp): Track | undefined {
  return tracks.find((t) => flag.test(t.name ?? ''));
}

/**
 * The stretches of a track that actually sound, in song-relative bars.
 *
 * A stem's file is usually the full length of the song, but the arrangement may
 * say otherwise: a clip can be trimmed, split, deactivated, or the track muted
 * outright. Playing the file straight through would then be louder than the set
 * — a part you had deliberately dropped would come back.
 *
 * `null` means "no restriction", which is the ordinary case and lets everything
 * downstream skip the work entirely.
 */
/**
 * Every clip on a track, read in full.
 *
 * Reading only the first clip was enough while each stem track held exactly
 * one, but it is wrong the moment a track carries a clip per song — the cues
 * track does, so every song was being handed the first cue in the whole set.
 * It is also the groundwork for rendering an arrangement, which needs to know
 * not just that a clip exists but which slice of which file it plays.
 */
/** What Live wrote into an attribute, read back: `&amp;` is an ampersand. */
export function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * A song's name as a group track and a locator would both spell it.
 *
 * The two are typed separately and drift: "Forever & Always" against
 * "Forever and Always", a locator carrying "- Play in F" that the group
 * never did, a stray bracket. Neither is wrong, so both are flattened
 * before they are compared.
 */
export function songKey(name: string): string {
  return decodeXml(name)
    .toLowerCase()
    .replace(/\s*[-–—(]\s*play(ed)?\s+in\s+[a-g][#b♯♭]?m?(inor|ajor)?\s*\)?\s*$/i, '')
    .replace(/&/g, ' and ')
    // A key or a version in brackets is a note on the name, not the name.
    .replace(/\s*[\[{(][^\]})]*[\]})]/g, ' ')
    .replace(/["'’‘.,!?:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A patch change at a beat of the set, as a rig track's clip sends it. */
interface RawRigPatch {
  beat: number;
  name: string;
  channel: number;
  program?: number;
  bank?: number;
  controls: { cc: number; value: number }[];
}

/**
 * The channel a MIDI track sends on: "Ch. 3" in its output routing. A track
 * routed nowhere still gets 1, so its clips read as something rather than
 * nothing — the routing is a thing to fix in Live, not a reason to hide them.
 */
function midiChannelOf(chunk: string): number {
  const routing = section(chunk, 'MidiOutputRouting') ?? '';
  const shown = routing.match(/<LowerDisplayString Value="Ch\. (\d+)"/)?.[1];
  if (shown) return Math.min(16, Math.max(1, parseInt(shown, 10)));
  const target = routing.match(/<Target Value="[^"]*\/(\d+)"/)?.[1];
  return target ? Math.min(16, Math.max(1, parseInt(target, 10) + 1)) : 1;
}

/**
 * Live numbers a clip's controller envelopes with pitch bend and channel
 * pressure first, so envelope 45 is CC 43. The numbering lives on the
 * track, and each clip's envelope points into it by id.
 */
function controllerIndexes(chunk: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of chunk.matchAll(/<ControllerTargets\.(\d+) Id="(\d+)"/g)) out.set(m[2], parseInt(m[1], 10));
  return out;
}

function midiPatchesOf(track: Track): RawRigPatch[] {
  const channel = midiChannelOf(track.chunk);
  const indexes = controllerIndexes(track.chunk);
  const timeline = section(track.chunk, 'ClipTimeable') ?? track.chunk;
  const out: RawRigPatch[] = [];
  const num = (body: string, tag: string): number | null => {
    const v = body.match(new RegExp(`<${tag} Value="([-\\d.]+)"`))?.[1];
    return v === undefined ? null : parseFloat(v);
  };
  for (const m of timeline.matchAll(/<MidiClip Id="\d+"[^>]*>([\s\S]*?)<\/MidiClip>/g)) {
    const body = m[1];
    const start = num(body, 'CurrentStart');
    const end = num(body, 'CurrentEnd');
    if (start === null || end === null || end <= start) continue;
    if (/<Disabled Value="true"/.test(body)) continue;
    const name = decodeXml(body.match(/<Name Value="([^"]*)"/)?.[1] ?? '');

    // Live's box shows these one-based; the file, and the wire, are zero-based. -1 is none.
    const programRaw = num(body, 'ProgramChange');
    const coarse = num(body, 'BankSelectCoarse');
    const fine = num(body, 'BankSelectFine');
    const program = programRaw !== null && programRaw >= 0 ? Math.round(programRaw) : undefined;
    const bank =
      (coarse !== null && coarse >= 0) || (fine !== null && fine >= 0)
        ? Math.max(0, Math.round(coarse ?? 0)) * 128 + Math.max(0, Math.round(fine ?? 0))
        : undefined;

    // Each envelope: its value as the clip starts, and every step after.
    const atStart: { cc: number; value: number }[] = [];
    const later = new Map<number, { cc: number; value: number }[]>();
    for (const e of body.matchAll(/<ClipEnvelope Id="\d+">([\s\S]*?)<\/ClipEnvelope>/g)) {
      const pointee = e[1].match(/<PointeeId Value="(\d+)"/)?.[1];
      const index = pointee ? indexes.get(pointee) : undefined;
      if (index === undefined || index < 2) continue; // pitch bend and pressure are not patch changes
      const cc = index - 2;
      const events = [...e[1].matchAll(/<FloatEvent Id="\d+" Time="([-\d.]+)" Value="([-\d.]+)"/g)]
        .map((f) => ({ time: parseFloat(f[1]), value: parseFloat(f[2]) }))
        .sort((a, b) => a.time - b.time);
      if (!events.length) continue;
      const opening = events.filter((f) => f.time <= 1e-9).pop();
      if (opening) atStart.push({ cc, value: Math.min(127, Math.max(0, Math.round(opening.value))) });
      for (const f of events) {
        if (f.time <= 1e-9 || start + f.time >= end) continue;
        const key = Math.round(f.time * 1e6) / 1e6;
        const list = later.get(key) ?? [];
        // The last value written at one time is the one that stands.
        const value = Math.min(127, Math.max(0, Math.round(f.value)));
        const same = list.find((c) => c.cc === cc);
        if (same) same.value = value;
        else list.push({ cc, value });
        later.set(key, list);
      }
    }
    if (program !== undefined || bank !== undefined || atStart.length) {
      out.push({ beat: start, name, channel, program, bank, controls: atStart });
    }
    for (const [time, controls] of [...later.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({ beat: start + time, name, channel, controls });
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

/** One named element of a track's chunk, or null when it has none. */
function section(chunk: string, tag: string): string | null {
  const at = chunk.indexOf(`<${tag}>`);
  if (at < 0) return null;
  const end = chunk.indexOf(`</${tag}>`, at);
  return end < 0 ? null : chunk.slice(at, end);
}

/** Whether the track is frozen: Live plays its render, not its clips. */
function isFrozen(track: Track): boolean {
  return /<Freeze Value="true"\s*\/>/.test(track.chunk);
}

/**
 * Every clip on a track, read in full — from the right list.
 *
 * A track's chunk holds two lists of clips. `MainSequencer` is the
 * arrangement as you see it; `FreezeSequencer` is what Live wrote when the
 * track was frozen — clips of a file it rendered itself, warping,
 * transposition and devices included, sitting at the same beats. Live plays
 * the second whenever the track is frozen, so that is what is read then, and
 * it is read as already finished: at its own pitch and speed. Reading every
 * clip in the chunk, as this once did, gave a frozen track both lists and
 * played the song twice over.
 */
function clipsOfTrack(track: Track): RawClip[] {
  const frozen = isFrozen(track);
  const freeze = frozen ? section(track.chunk, 'FreezeSequencer') : null;
  const useFreeze = !!freeze && /<AudioClip /.test(freeze);
  const from = useFreeze ? freeze : (section(track.chunk, 'MainSequencer') ?? track.chunk);
  return rawClipsIn(from, useFreeze);
}

function rawClipsIn(chunk: string, frozen: boolean): RawClip[] {
  const clips: RawClip[] = [];
  for (const m of chunk.matchAll(/<AudioClip Id="\d+"[^>]*>([\s\S]*?)<\/AudioClip>/g)) {
    const body = m[1];
    const num = (re: RegExp): number =>
      parseFloat((body.match(re) ?? [])[1] ?? 'NaN');
    const flag = (re: RegExp): boolean => (body.match(re) ?? [])[1] === 'true';

    const start = num(/<CurrentStart Value="([-\d.]+)"/);
    const end = num(/<CurrentEnd Value="([-\d.]+)"/);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;

    // Read back as Live wrote it: a folder called "Forever & Always" is
    // "Forever &amp; Always" in the file, and matches no file by that name.
    const path = decodeXml(
      (body.match(/<RelativePath Value="([^"]+)"/) ??
        body.match(/<Path Value="([^"]+)"/) ??
        [])[1] ?? '',
    );
    const absPath = decodeXml((body.match(/<Path Value="([^"]+)"/) ?? [])[1] ?? '') || null;

    /*
     * Which slice of the file plays. Ableton counts this in beats from the
     * sample's own start, so it needs the clip's own tempo to become seconds —
     * see `warpRate` below.
     */
    const loopStart = num(/<LoopStart Value="([-\d.]+)"/);
    const startRelative = num(/<StartRelative Value="([-\d.]+)"/);
    const sourceStartBeat =
      (Number.isNaN(loopStart) ? 0 : loopStart) +
      (Number.isNaN(startRelative) ? 0 : startRelative);

    const fades = flag(/<Fade Value="(true|false)"/);
    const fadeIn = num(/<FadeInLength Value="([-\d.]+)"/);
    const fadeOut = num(/<FadeOutLength Value="([-\d.]+)"/);

    clips.push({
      path,
      startBeat: start,
      endBeat: end,
      sourceStartBeat,
      disabled: flag(/<Disabled Value="(true|false)"/),
      fadeInSec: fades && !Number.isNaN(fadeIn) ? fadeIn : 0,
      fadeOutSec: fades && !Number.isNaN(fadeOut) ? fadeOut : 0,
      warpBps: warpRate(body),
      sampleRate: num(/<DefaultSampleRate Value="(\d+)"/) || null,
      gain: (() => {
        const g = num(/<SampleVolume Value="([-\d.]+)"/);
        return Number.isNaN(g) ? 1 : g;
      })(),
      absPath,
      // Coarse in semitones, fine in cents — the clip's own transposition.
      // A freeze clip's is already in its file.
      semitones: frozen
        ? 0
        : (Number.isNaN(num(/<PitchCoarse Value="([-\d.]+)"/)) ? 0 : num(/<PitchCoarse Value="([-\d.]+)"/)) +
          (Number.isNaN(num(/<PitchFine Value="([-\d.]+)"/)) ? 0 : num(/<PitchFine Value="([-\d.]+)"/) / 100),
      frozen,
    });
  }
  return clips.sort((a, b) => a.startBeat - b.startBeat);
}

/**
 * How many beats of the file pass per second of it, from the warp markers.
 *
 * Two markers describe a straight line, which is all a stem exported at the
 * song's own tempo needs — and in practice that is what they are. The widest
 * pair is the truest; Live also writes a hairline pair a few milliseconds
 * apart, and when that is all there is, it still states the clip's tempo
 * exactly — a file dropped onto a warped track at 85 BPM carries 0.03125
 * beats over 22 ms — so it is used rather than the clip taken as unwarped,
 * which turned its beat offsets into seconds and started it in the wrong
 * place. Null means unwarped: the file plays at its own speed and beats
 * don't enter into it.
 */
function warpRate(body: string): number | null {
  if (!/<IsWarped Value="true"/.test(body)) return null;
  const markers = [...body.matchAll(/<WarpMarker Id="\d+" SecTime="([-\d.]+)" BeatTime="([-\d.]+)"/g)]
    .map((m) => ({ sec: parseFloat(m[1]), beat: parseFloat(m[2]) }))
    .sort((a, b) => a.sec - b.sec);
  if (markers.length < 2) return null;

  const first = markers[0];
  // The widest pair that isn't hairline, when there is one.
  for (let i = markers.length - 1; i > 0; i--) {
    const sec = markers[i].sec - first.sec;
    const beat = markers[i].beat - first.beat;
    if (sec >= 0.5 && beat > 0) return beat / sec;
  }
  // Only the hairline pair: still a rate, as long as it is one at all.
  const last = markers[markers.length - 1];
  const spanSec = last.sec - first.sec;
  const spanBeat = last.beat - first.beat;
  return spanSec > 1e-6 && spanBeat > 0 ? spanBeat / spanSec : null;
}

/**
 * Where in the file a clip starts playing, in seconds.
 *
 * Ableton keeps the offset in the file's own beats, so a warped clip converts
 * through the rate its markers imply; an unwarped one is already in seconds.
 * `trimmedBeats` covers a clip that begins before the song does — only the part
 * inside the song is wanted, so the offset moves along with it.
 */
function sourceStartSec(clip: RawClip, trimmedBeats: number): number {
  const beats = clip.sourceStartBeat + trimmedBeats;
  if (clip.warpBps && clip.warpBps > 0) return beats / clip.warpBps;
  return beats;
}

/** True when the track's activator is off, so it sounds nowhere. */
function trackIsMuted(track: Track): boolean {
  const speaker = track.chunk.match(/<Speaker>[\s\S]{0,200}?<Manual Value="(true|false)"/);
  return speaker?.[1] === 'false';
}

/**
 * The stretches of a track that actually sound, in song-relative bars.
 *
 * A stem's file is usually the full length of the song, but the arrangement may
 * say otherwise: a clip can be trimmed, split, deactivated, or the track muted
 * outright. Playing the file straight through would then be louder than the set
 * — a part you had deliberately dropped would come back.
 *
 * `null` means "no restriction", which is the ordinary case and lets everything
 * downstream skip the work entirely.
 */
function audibleRegions(
  clips: RawClip[],
  muted: boolean,
  songStartBeat: number,
  songEndBeat: number,
  relBar: (beat: number) => number,
): { startBar: number; endBar: number }[] | null {
  if (muted) return [];
  if (!clips.length) return null;

  const live: { startBar: number; endBar: number }[] = [];
  for (const clip of clips) {
    if (clip.disabled) continue;
    // Only the part of the clip that falls inside this song.
    const from = Math.max(clip.startBeat, songStartBeat);
    const to = Math.min(clip.endBeat, songEndBeat);
    if (to <= from) continue;
    live.push({ startBar: relBar(from), endBar: relBar(to) });
  }

  // Covering the whole song is the same as no restriction at all.
  const covers =
    live.length === 1 && live[0].startBar <= 1.001 && live[0].endBar >= relBar(songEndBeat) - 0.001;
  return covers ? null : live;
}

/** Strip the AbleSet flags and trailing option block from a track name. */
function laneName(raw: string): string {
  const clean = raw
    .replace(/\+\s*[A-Z]+\b/g, '')
    .replace(/\[[^\]]*\]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return clean || 'Lyrics';
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lane';
}

/** Names in square brackets are chords, per AbleSet's notation. */
const BRACKETED = /^\[.*\]$/;

/**
 * Every `+LYRICS` track, in set order, as a lane.
 *
 * Chord names written in brackets on a lyric track are pulled out and gathered
 * into a chord lane, which is how AbleSet lets one track carry both.
 */
interface LaneDef {
  id: string;
  name: string;
  kind: AlsLane['kind'];
  /** Raw clips, still in project beats. */
  clips: Clip[];
}

function laneDefinitions(tracks: Track[]): LaneDef[] {
  const lanes: LaneDef[] = [];
  const strays: Clip[] = [];
  const used = new Set<string>();

  for (const track of tracks.filter((t) => /\+\s*LYRICS\b/i.test(t.name ?? ''))) {
    const name = laneName(track.name);
    const kind: AlsLane['kind'] = /chord/i.test(name) ? 'chords' : 'lyrics';
    const clips = clipsOf(track.chunk, 'MidiClip');

    // Keep ids unique when two tracks clean up to the same name.
    let id = slug(name);
    for (let n = 2; used.has(id); n++) id = `${slug(name)}-${n}`;
    used.add(id);

    if (kind === 'chords') {
      lanes.push({ id, name, kind, clips: clips.map(unbracket) });
      continue;
    }
    lanes.push({ id, name, kind, clips: clips.filter((c) => !BRACKETED.test(c.name.trim())) });
    strays.push(...clips.filter((c) => BRACKETED.test(c.name.trim())).map(unbracket));
  }

  if (strays.length) {
    const chordLane = lanes.find((l) => l.kind === 'chords');
    if (chordLane) chordLane.clips = [...chordLane.clips, ...strays].sort((a, b) => a.beat - b.beat);
    else lanes.push({ id: 'chords', name: 'Chords', kind: 'chords', clips: strays });
  }
  return lanes;
}

function unbracket(clip: Clip): Clip {
  return { ...clip, name: clip.name.trim().replace(/^\[|\]$/g, '') };
}

/**
 * Cut the lanes down to one song's stretch of the timeline.
 *
 * `lyrics` and `chords` stay alongside as the merged view of the same data, so
 * anything wanting just "the words" or "the chords" needn't know about lanes.
 */
/**
 * A key written in a clip's name: `Key: A`, `KEY CHANGE Bb`, `key = F#m`,
 * `Key change → Eb major`. The letter, its accidental, and m for a minor.
 * The word must be there — a chord clip `[A]` is a chord, not a key — and
 * must stand on its own, so a lyric about a monkey says nothing.
 */
const KEY_MARK = /\bkey(?:\s*change)?\s*[:=\-–—>→]*\s*([A-G])([#b♯♭]?)(?:\s*(m|min|minor|maj|major))?\b/i;

/**
 * A key change written as a move rather than a key: `KEY CHANGE +2`, `key
 * change up 2`, `KEY CHANGE -1`, `key change down a semitone`. Answers the
 * semitones, which the song's own key turns into a key.
 */
// No hyphen among the separators: in `KEY CHANGE -1` the hyphen is the sign.
const KEY_SHIFT = /\bkey(?:\s*change)?\s*[:=–—>→]*\s*(?:(up|down)\s*)?([+-]?\d{1,2})\s*(?:semitones?|semis?|half\s*steps?|st|hs)?\b/i;

export function keyShiftIn(text: string): number | null {
  if (!/\bkey\b/i.test(text)) return null;
  const m = KEY_SHIFT.exec(text);
  if (!m) return null;
  const size = parseInt(m[2], 10);
  if (!Number.isFinite(size) || size === 0 || Math.abs(size) > 12) return null;
  const down = /down/i.test(m[1] ?? '') || m[2].startsWith('-');
  return down ? -Math.abs(size) : Math.abs(size);
}

export function keyMarkIn(text: string): string | null {
  const m = KEY_MARK.exec(text);
  if (!m) return null;
  const accidental = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
  const minor = /^m(in(or)?)?$/i.test(m[3] ?? '');
  return `${m[1].toUpperCase()}${accidental}${minor ? 'm' : ''}`;
}

/**
 * Every key mark on the timeline, from the clips of every MIDI track.
 *
 * A mark either names the new key (`Key: Eb`) or says how far the song
 * moves (`KEY CHANGE +2`), which is how a band that thinks in semitones
 * writes it; the move is turned into a key later, against whatever key is
 * in force by then.
 */
function keyMarkClips(tracks: Track[]): { beat: number; key?: string; shift?: number }[] {
  const out: { beat: number; key?: string; shift?: number }[] = [];
  for (const track of tracks) {
    for (const clip of clipsOf(track.chunk, 'MidiClip')) {
      const key = keyMarkIn(clip.name);
      if (key) {
        out.push({ beat: clip.beat, key });
        continue;
      }
      const shift = keyShiftIn(clip.name);
      if (shift !== null) out.push({ beat: clip.beat, shift });
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

function songLanes(
  defs: LaneDef[],
  within: (c: Clip) => boolean,
  relBar: (beat: number) => number,
): Pick<AlsSong, 'lanes' | 'lyrics' | 'chords'> {
  const lanes: AlsLane[] = defs.map(({ clips, ...lane }) => ({
    ...lane,
    items: clips
      .filter(within)
      .sort((a, b) => a.beat - b.beat)
      .map((c) => {
        const bar = relBar(c.beat);
        // relBar is a straight line from beats to bars, so the difference is
        // the clip's length in bars; a set that didn't say leaves it out.
        const bars = Number.isFinite(c.endBeat) ? Math.round((relBar(c.endBeat) - bar) * 1000) / 1000 : NaN;
        return bars > 0 ? { bar, text: c.name, bars } : { bar, text: c.name };
      }),
  }));
  const merge = (kind: AlsLane['kind']) =>
    lanes
      .filter((l) => l.kind === kind)
      .flatMap((l) => l.items)
      .sort((a, b) => a.bar - b.bar);
  return { lanes, lyrics: merge('lyrics'), chords: merge('chords') };
}

export async function parseAls(bytes: ArrayBuffer): Promise<AlsProject> {
  const xml = await inflateAls(bytes);
  return parseAlsXml(xml);
}

/** Split out so tests can work from the XML directly. */
export function parseAlsXml(xml: string): AlsProject {
  const creator = (xml.match(/Creator="([^"]*)"/) ?? [])[1] ?? 'unknown';
  const tempo = parseFloat((xml.match(/<Tempo>[\s\S]*?<Manual Value="([\d.]+)"/) ?? [])[1] ?? '120');
  const sig = xml.match(
    /<RemoteableTimeSignature[^>]*>[\s\S]*?<Numerator Value="(\d+)"[\s\S]*?<Denominator Value="(\d+)"/,
  );
  const timeSigNum = sig ? Number(sig[1]) : 4;
  const timeSigDen = sig ? Number(sig[2]) : 4;
  const beatsPerBar = timeSigNum * (4 / timeSigDen);
  const toBar = (beat: number) => beat / beatsPerBar + 1;

  const tracks: Track[] = xml
    .split(/(?=<(?:MidiTrack|AudioTrack|GroupTrack) Id=)/)
    .slice(1)
    .map((chunk) => ({
      kind: (chunk.match(/^<(\w+)/) ?? [])[1] ?? '',
      id: (chunk.match(/^<\w+ Id="(\d+)"/) ?? [])[1] ?? '',
      groupId: (chunk.match(/<TrackGroupId Value="(-?\d+)"/) ?? [])[1] ?? '-1',
      name: decodeXml((chunk.match(/<EffectiveName Value="([^"]*)"/) ?? [])[1] ?? ''),
      // The track's own comes first in the element, before its clips' and devices'.
      annotation: decodeXml((chunk.match(/<Annotation Value="([^"]*)"/) ?? [])[1] ?? ''),
      chunk,
      ...mixerOf(chunk),
      devices: devicesOf(chunk),
      ...routingOf(chunk),
    }));

  /*
   * The return buses, in order — which is how a track's sends name them.
   * A bus sums whatever is sent to it, runs it through its own devices,
   * and goes to an output or on into another bus.
   */
  const buses: Bus[] = [...xml.matchAll(/<ReturnTrack Id="\d+"[^>]*>([\s\S]*?)<\/ReturnTrack>/g)].map((m) => {
    const body = m[1];
    const routing = routingOf(body);
    return {
      name: decodeXml(body.match(/<EffectiveName Value="([^"]*)"/)?.[1] ?? ''),
      ...mixerOf(body),
      devices: devicesOf(body),
      direct: routing.output === 'main' || routing.output === 'external',
      sends: routing.sends,
    };
  });

  // Tempo automation, so a song that changes tempo can be described honestly.
  const targetId = (xml.match(/<Tempo>[\s\S]*?<AutomationTarget Id="(\d+)"/) ?? [])[1];
  let tempoChanges: TempoChange[] = [];
  if (targetId) {
    const envelope = xml.match(
      new RegExp(
        `<AutomationEnvelope Id="\\d+">\\s*<EnvelopeTarget>\\s*<PointeeId Value="${targetId}"[\\s\\S]*?</AutomationEnvelope>`,
      ),
    );
    if (envelope) {
      tempoChanges = [...envelope[0].matchAll(/<FloatEvent Id="\d+" Time="([-\d.]+)" Value="([\d.]+)"/g)]
        .map((m) => ({ beat: parseFloat(m[1]), bpm: parseFloat(m[2]) }))
        .filter((e) => !Number.isNaN(e.beat) && e.bpm >= 20 && e.bpm <= 300)
        .sort((a, b) => a.beat - b.beat);
    }
  }

  /**
   * Seconds along the set between two beats, through the tempo automation.
   *
   * A freeze file is rendered in real time along the arrangement, so where
   * a song begins inside it is a matter of seconds elapsed on the timeline
   * — not of beats at any one tempo. Steps, as the tempo map is read
   * everywhere else here: each change holds until the next.
   */
  const secondsBetween = (fromBeat: number, toBeat: number): number => {
    if (!(toBeat > fromBeat)) return 0;
    let bpm = tempoChanges.filter((t) => t.beat <= fromBeat + 1e-9).pop()?.bpm ?? tempo;
    let at = fromBeat;
    let sec = 0;
    for (const t of tempoChanges) {
      if (t.beat <= fromBeat + 1e-9) continue;
      if (t.beat >= toBeat) break;
      sec += ((t.beat - at) * 60) / bpm;
      at = t.beat;
      bpm = t.bpm;
    }
    return sec + ((toBeat - at) * 60) / bpm;
  };

  /**
   * Where in a frozen clip's file a beat of the set falls, in seconds. The
   * file's own start is the clip's start less whatever the clip skips.
   */
  const frozenSourceSec = (c: RawClip, atBeat: number): number =>
    secondsBetween(c.startBeat - c.sourceStartBeat, atBeat);

  const sections = clipsOf(trackByFlag(tracks, /\+\s*SECTIONS\b|^sections\b/i)?.chunk ?? '', 'MidiClip');

  /*
   * Time signature changes, from the main track's automation: one encoded
   * number per event. A song takes the signature in force where it starts;
   * a change inside it is something this app cannot follow.
   */
  const signatureTarget = (xml.match(
    /<TimeSignature>\s*<LomId[^>]*>\s*<Manual Value="\d+"[^>]*>\s*<AutomationTarget Id="(\d+)"/,
  ) ?? [])[1];
  let signatureChanges: { beat: number; num: number; den: number }[] = [];
  if (signatureTarget) {
    const envelope = xml.match(
      new RegExp(
        `<AutomationEnvelope Id="\\d+">\\s*<EnvelopeTarget>\\s*<PointeeId Value="${signatureTarget}"[\\s\\S]*?</AutomationEnvelope>`,
      ),
    );
    if (envelope) {
      signatureChanges = [...envelope[0].matchAll(/<EnumEvent Id="\d+" Time="([-\d.]+)" Value="(\d+)"/g)]
        .map((m) => ({ beat: parseFloat(m[1]), ...decodeSignature(Number(m[2])) }))
        .filter((e) => !Number.isNaN(e.beat) && e.num > 0 && e.num < 64 && e.den >= 1 && e.den <= 32)
        .sort((a, b) => a.beat - b.beat);
    }
  }

  /*
   * The rig's tracks: what the set sends out rather than plays to the band.
   * A MIDI track to a pedalboard, a lighting desk or a tuner; a video or a
   * timecode track.
   *
   * A track marked `+PATCH` says outright that it sends patch changes, and
   * is taken at its word wherever it sits and whatever else it is called.
   * The rest are known as they always were — by the words in their names,
   * outside any song's group, never one of the set's own text or click
   * tracks — which is a guess, and the mark is how a set stops guessing.
   */
  const RIG_TRACK = /\b(midi|rig|patch(es)?|program|pc|video|vid|timecode|tc|ltc|smpte|light(s|ing)?|cortex|helix|kemper|axe|autotune|tuner)\b/i;
  const NOT_RIG = /^(song|arrangement|tempo track|click|cue|cues)$|\+\s*(lyrics|sections)\b|\bslates?\b/i;
  const VIDEO_FILE = /\.(mp4|mov|m4v|avi|mkv|webm)$/i;
  const rigTrackDefs = tracks
    .filter((t) => t.kind === 'MidiTrack' || t.kind === 'AudioTrack')
    .filter((t) => {
      if (sendsPatches(t.name)) return true;
      if (NOT_RIG.test(t.name.trim())) return false;
      const parent = t.groupId === '-1' ? undefined : tracks.find((g) => g.id === t.groupId);
      const top = parent ? parent.groupId === '-1' && RIG_TRACK.test(parent.name) : true;
      return top && (RIG_TRACK.test(t.name) || (parent ? RIG_TRACK.test(parent.name) : false));
    })
    .map((t) => {
      // The mark says what the track is; it is not part of what it is called.
      const name = withoutPatchFlag(t.name);
      if (t.kind === 'MidiTrack') {
        return { name, kind: 'midi' as const, clips: clipsOf(t.chunk, 'MidiClip', 'clip'), patches: midiPatchesOf(t) };
      }
      const raw = clipsOfTrack(t);
      const kind = raw.some((c) => VIDEO_FILE.test(c.path)) || /\b(video|vid)\b/i.test(t.name) ? 'video' as const : 'audio' as const;
      return {
        name,
        kind,
        clips: raw.map((c) => ({ beat: c.startBeat, endBeat: c.endBeat, name: c.path.split('/').pop() ?? c.path })),
      };
    });

  /*
   * Where the slates sit. The slate track spans the whole set rather than
   * living in any song's group, so its clips are gathered once here and each
   * song later keeps the ones inside its own stretch — that is how the set
   * checker knows which songs still lack a spoken title.
   */
  const slateClips = tracks
    .filter((t) => t.kind === 'AudioTrack' && /\bslates?\b/i.test(t.name))
    .flatMap((t) => clipsOfTrack(t))
    .filter((c) => !c.disabled);

  /*
   * A second place a song says what it is: regions on a track called SONG,
   * named exactly as a locator would be. Sets carry the facts in one place or
   * the other and not always both — this one has locators reading only "In My
   * Place" while the region gives its key and tempo — so the locator is read
   * first and this fills what it left out.
   */
  const songRegions = clipsOf(
    tracks.find((t) => /^song$/i.test((t.name ?? '').trim()))?.chunk ?? '',
    'MidiClip',
  );
  const laneDefs = laneDefinitions(tracks);
  const keyMarks = keyMarkClips(tracks);

  /* ------------------------------- locators ------------------------------- */

  const locators = [...xml.matchAll(/<Locator Id="\d+">([\s\S]*?)<\/Locator>/g)]
    .map((m) => ({
      beat: parseFloat((m[1].match(/<Time Value="([-\d.]+)"/) ?? [])[1] ?? 'NaN'),
      name: decodeXml((m[1].match(/<Name Value="([^"]*)"/) ?? [])[1] ?? ''),
    }))
    .filter((l) => !Number.isNaN(l.beat))
    .sort((a, b) => a.beat - b.beat);

  const stops = locators.filter((l) => STOP_NAMES.test(l.name.trim()));
  const songLocators = locators.filter((l) => {
    const n = l.name.trim();
    if (!n) return false;
    if (n.startsWith('*')) return false; // AbleSet: hidden
    if (n.startsWith('>')) return false; // AbleSet: a section, not a song
    if (STOP_NAMES.test(n)) return false;
    if (/\[nosong\]/i.test(n)) return false;
    return true;
  });

  /* --------------------------- per-song assembly -------------------------- */

  const songGroups = tracks.filter(
    (t) => t.kind === 'GroupTrack' && t.groupId === '-1' && !t.name.startsWith('*'),
  );
  const byId = new Map(tracks.map((t) => [t.id, t]));
  /**
   * A reference track, by its own name or by the folder holding it.
   *
   * Sets keep the finished record beside the band's parts — usually a REF
   * folder per song, holding a "Ref Master" and sometimes a REF VOX or REF
   * PIANO to check a line against. A track in there is a reference whatever
   * it calls itself: one set has plain "Lead Vox 1" inside REF, which is the
   * record's lead vocal, not the band's.
   *
   * Deliberately not the app's isReferenceName, which counts "master" too —
   * here that would brand the band's own master mix a reference.
   */
  const REF_RE = /\bref(erence)?\b/i;

  const rootOf = (t: Track): Track | undefined => {
    let cur: Track | undefined = t;
    for (let i = 0; i < 8 && cur && cur.groupId !== '-1'; i++) cur = byId.get(cur.groupId);
    return cur;
  };

  /*
   * The group track that is this song's. By name first, the way both were
   * meant to agree; then by a name one of them only began ("22" for "22
   * Song"), when only one group could; and failing both, by position — the
   * group whose clips mostly sit inside the song's bars, which is what a
   * group being a song's means in the arrangement whatever it was called.
   */
  const claimed = new Set<Track>();
  const groupFor = (title: string, startBeat: number, endBeat: number): Track | undefined => {
    const key = songKey(title);
    const free = songGroups.filter((g) => !claimed.has(g));
    let found = free.find((g) => songKey(g.name) === key);
    if (!found && key) {
      const partial = free.filter((g) => {
        const gk = songKey(g.name);
        return gk && (key.startsWith(gk + ' ') || gk.startsWith(key + ' '));
      });
      if (partial.length === 1) found = partial[0];
    }
    if (!found) {
      const inside = (g: Track) => {
        const clips = tracks
          .filter((t) => t.kind === 'AudioTrack' && rootOf(t) === g)
          .flatMap(clipsOfTrack);
        if (!clips.length) return 0;
        const within = clips.filter((c) => c.startBeat >= startBeat - 1e-6 && c.startBeat < endBeat).length;
        return within / clips.length;
      };
      const scored = free.map((g) => ({ g, share: inside(g) })).filter((x) => x.share > 0.5);
      scored.sort((a, b) => b.share - a.share);
      found = scored[0]?.g;
    }
    if (found) claimed.add(found);
    return found;
  };

  const warnings: string[] = [];
  const songs: AlsSong[] = songLocators.map((loc, index) => {
    const meta = parseLocatorName(loc.name);
    const nextSong = songLocators[index + 1];
    const stop = stops.find((s) => s.beat > loc.beat + 1e-6);
    // A song ends at its stop marker, or where the next one begins.
    const endBeat = Math.min(stop?.beat ?? Infinity, nextSong?.beat ?? Infinity);
    const endsAtStop = !!stop && stop.beat <= (nextSong?.beat ?? Infinity) + 1e-6;
    // The tempo in force where this song starts — automation runs on from
    // wherever its last point was, however many songs back that is.
    const lastTempo = tempoChanges.filter((t) => t.beat <= loc.beat + 1e-6).pop();
    const startBpm = lastTempo?.bpm ?? tempo;

    /*
     * This song's region on the SONG track: the one naming it, else one
     * starting where it starts. Deliberately not "any region inside the
     * song" — a set keeps a template region lying around, and a stray one
     * three minutes in would hand a song someone else's key.
     */
    const named = songRegions.find(
      (r) => parseLocatorName(r.name).title.trim().toLowerCase() === meta.title.trim().toLowerCase(),
    );
    const atStart = songRegions.find((r) => Math.abs(r.beat - loc.beat) <= beatsPerBar);
    const region = named || atStart ? parseLocatorName((named ?? atStart)!.name) : null;
    const within = (c: Clip) => c.beat >= loc.beat - 1e-6 && c.beat < endBeat;
    /**
     * Locators aren't always exactly on the grid — this set has them a
     * ten-thousandth of a beat out — which would otherwise report bar 3 as
     * 2.9996. Snap anything within a thousandth of a bar to the whole number.
     */
    // The song's own signature, for counting its bars.
    const signature = signatureChanges.filter((e) => e.beat <= loc.beat + 1e-6).pop() ?? {
      num: timeSigNum,
      den: timeSigDen,
    };
    const songBeatsPerBar = signature.num * (4 / signature.den);
    const relBar = (beat: number) => {
      const bar = (beat - loc.beat) / songBeatsPerBar + 1;
      const rounded = Math.round(bar);
      return Math.abs(bar - rounded) < 0.001 ? rounded : Math.round(bar * 1000) / 1000;
    };

    // Match a group track to the song by name, so stems can be attributed.
    const group = groupFor(meta.title, loc.beat, endBeat);
    const stems: AlsSong['stems'] = group
      ? tracks
          .filter((t) => t.kind === 'AudioTrack' && rootOf(t) === group)
          .map((t) => {
            // Every group between the track and the song's own group; the
            // song group itself is not a folder the track was filed under.
            const folders: string[] = [];
            let gain = t.gain;
            let pan = t.pan;
            // A frozen track's own devices are in its render already; its
            // groups' are not, and are gathered below as for any track.
            const frozen = isFrozen(t);
            const devices: Device[] = frozen ? [] : [...t.devices];
            const sends = [...t.sends];
            let output = t.output;
            for (let c = byId.get(t.groupId), i = 0; c && c !== group && i < 8; i++) {
              folders.push(c.name);
              gain *= c.gain;
              pan += c.pan;
              // The signal only carries on up when the track feeds its group.
              if (output === 'group') {
                devices.push(...c.devices);
                sends.push(...c.sends);
                output = c.output;
              }
              c = byId.get(c.groupId);
            }
            // The song's own group is a fader over everything in it, too.
            gain *= group.gain;
            pan = Math.max(-1, Math.min(1, pan + group.pan));
            if (output === 'group') {
              devices.push(...group.devices);
              sends.push(...group.sends);
              output = group.output;
            }
            const direct = output === 'main' || output === 'external' || output === 'group';
            const reference = REF_RE.test(t.name) || folders.some((f) => REF_RE.test(f));
            const all = clipsOfTrack(t);
            const muted = trackIsMuted(t);
            /*
             * Only the clips inside this song. Taking the first clip on the
             * track was fine while each held one, and wrong for a track with a
             * clip per song — the cues track gave every song the set's first
             * cue.
             */
            const mine = all.filter((c) => c.endBeat > loc.beat && c.startBeat < endBeat);
            const clips: AlsClip[] = mine.map((c) => ({
              path: c.path,
              startBar: relBar(Math.max(c.startBeat, loc.beat)),
              endBar: relBar(Math.min(c.endBeat, endBeat)),
              sourceStartSec: c.frozen
                ? frozenSourceSec(c, Math.max(c.startBeat, loc.beat))
                : sourceStartSec(c, Math.max(0, loc.beat - c.startBeat)),
              disabled: c.disabled,
              fadeInSec: c.fadeInSec,
              fadeOutSec: c.fadeOutSec,
              warped: c.warpBps !== null,
              semitones: c.semitones,
              gain: c.gain,
              absPath: c.absPath ?? undefined,
              // A warped file at another tempo is stretched to this song's:
              // its beats per second against the song's, where they differ.
              // A freeze file was rendered along the timeline and needs none.
              speed:
                !c.frozen && c.warpBps && Math.abs(startBpm / 60 / c.warpBps - 1) > 0.005
                  ? startBpm / 60 / c.warpBps
                  : 1,
              ...(c.frozen ? { frozen: true as const } : {}),
            }));
            const sounding = mine.find((c) => !c.disabled) ?? mine[0];
            return {
              name: t.name,
              trackId: t.id,
              reference,
              frozen: frozen && mine.some((c) => c.frozen),
              gain,
              pan,
              devices,
              sends,
              direct,
              path: sounding?.path ?? '',
              regions: audibleRegions(mine, muted, loc.beat, endBeat, relBar),
              clips,
            };
          })
          .filter((s) => s.path)
      : [];

    /*
     * The set's own click and cues, which live outside any song's group and
     * run the length of the set. Each becomes one part of every song they
     * play in — every cue track summed into "Cues", every click track into
     * one "Click" — cut to the clips inside the song, with each track's
     * fader folded into its clips. A MIDI click makes no audio and adds
     * nothing. A set's click *is* the click: the player's own metronome
     * steps aside for it, so there is one click channel either way.
     */
    // Members of the click and cue groups the studio cannot make sound.
    const setPartCaveats = new Set<string>();
    for (const [label, match] of [
      ['Click', /^click/i],
      // Slates — the spoken titles the studio writes — are cues too.
      ['Cues', /^(cues?|slates?)$/i],
    ] as const) {
      const groups = tracks.filter((t) => t.kind === 'GroupTrack' && t.groupId === '-1' && match.test(t.name.trim()));
      const members = tracks.filter(
        (t) =>
          (t.kind === 'AudioTrack' || t.kind === 'MidiTrack') &&
          !trackIsMuted(t) &&
          (groups.some((g) => rootOf(t) === g) || (t.groupId === '-1' && match.test(t.name.trim()))),
      );
      const clips: AlsClip[] = [];
      for (const t of members) {
        let level = t.gain;
        for (let c = byId.get(t.groupId), i = 0; c && i < 8; i++) {
          level *= c.gain;
          c = byId.get(c.groupId);
        }
        /*
         * A MIDI track playing a drum rack: every note becomes its pad's
         * sample, laid at the note, at the pad's level scaled a little by
         * velocity. A one-shot plays the whole sample whatever the note's
         * length, so each is given room and the render stops at the file's
         * end.
         */
        if (t.kind === 'MidiTrack') {
          const pads = drumPads(t.chunk);
          if (!pads.size) {
            // A synth, or a rack with no samples: nothing here can render an
            // instrument, so it is named rather than silently left out.
            setPartCaveats.add(`${t.name.trim()} is a MIDI track playing an instrument, which cannot be rendered here — bounce it to audio in Live`);
            continue;
          }
          for (const note of midiNotes(t.chunk)) {
            if (note.beat < loc.beat - 1e-6 || note.beat >= endBeat) continue;
            const pad = pads.get(note.key);
            if (!pad) continue;
            const bar = relBar(note.beat);
            clips.push({
              path: pad.path,
              absPath: pad.absPath ?? undefined,
              startBar: bar,
              endBar: bar + 16,
              sourceStartSec: pad.startSec,
              disabled: false,
              fadeInSec: 0,
              fadeOutSec: 0,
              warped: false,
              semitones: 0,
              gain: pad.gain * level * (0.65 + (0.35 * Math.min(127, Math.max(1, note.velocity))) / 127),
              speed: 1,
              note: note.key,
              velocity: Math.min(127, Math.max(1, Math.round(note.velocity))),
              padGain: pad.gain * level,
              track: t.name.trim(),
            });
          }
          continue;
        }
        for (const c of clipsOfTrack(t)) {
          if (c.disabled || c.endBeat <= loc.beat || c.startBeat >= endBeat) continue;
          clips.push({
            path: c.path,
            startBar: relBar(Math.max(c.startBeat, loc.beat)),
            endBar: relBar(Math.min(c.endBeat, endBeat)),
            sourceStartSec: c.frozen
              ? frozenSourceSec(c, Math.max(c.startBeat, loc.beat))
              : sourceStartSec(c, Math.max(0, loc.beat - c.startBeat)),
            disabled: false,
            fadeInSec: c.fadeInSec,
            fadeOutSec: c.fadeOutSec,
            warped: c.warpBps !== null,
            semitones: c.semitones,
            gain: c.gain * level,
            absPath: c.absPath ?? undefined,
            speed:
              !c.frozen && c.warpBps && Math.abs(startBpm / 60 / c.warpBps - 1) > 0.005
                ? startBpm / 60 / c.warpBps
                : 1,
            track: t.name.trim(),
            ...(c.frozen ? { frozen: true as const } : {}),
          });
        }
      }
      if (!clips.length) continue;
      clips.sort((a, b) => a.startBar - b.startBar);
      stems.push({
        name: label,
        reference: false,
        frozen: false,
        gain: 1,
        pan: 0,
        devices: [],
        sends: [],
        direct: true,
        path: clips[0].path,
        regions: null,
        clips,
      });
    }

    if (!stems.length) warnings.push(`No audio tracks found for “${meta.title}”.`);

    /*
     * What cannot be played as Ableton plays it. A time signature change
     * inside the song: this app counts one signature per song, so bars
     * after the change land in the wrong place, though the audio plays on.
     */
    const caveats: string[] = [...setPartCaveats];
    const inside = signatureChanges.filter((c) => c.beat > loc.beat + 1e-6 && c.beat < endBeat);
    const fmt = (b: number) => (Number.isInteger(b) ? String(b) : b.toFixed(1));
    for (let i = 0; i < inside.length; i++) {
      const change = inside[i];
      // Only a stretch in another meter; a change back is the end of one.
      if (change.num === signature.num && change.den === signature.den) continue;
      const before = inside[i - 1];
      if (before && before.num === change.num && before.den === change.den) continue;
      const from = relBar(change.beat);
      const after = inside.slice(i + 1).find((c) => c.num !== change.num || c.den !== change.den);
      const to = after ? relBar(after.beat) : null;
      const where =
        to !== null && to - from <= 1.001 ? `Bar ${fmt(from)} is` : `Bars from ${fmt(from)}${to !== null ? ` to ${fmt(to)}` : ' on'} are`;
      caveats.push(
        `${where} in ${change.num}/${change.den}; bars, loops and the click here are counted in ` +
          `${signature.num}/${signature.den} throughout.`,
      );
    }

    // The key marks inside this song, the last at any bar winning.
    const marksHere = new Map<number, { key?: string; shift?: number }>();
    for (const k of keyMarks) {
      if (k.beat >= loc.beat - 1e-6 && k.beat < endBeat) marksHere.set(relBar(k.beat), k);
    }
    const marks = [...marksHere.entries()]
      .map(([bar, mark]) => ({ bar, ...mark }))
      .sort((a, b) => a.bar - b.bar);
    // A mark at the top of the song names its key when the locator did not.
    const openingKey = marks.find((m) => m.bar <= 1 + 1e-6 && m.key)?.key ?? null;
    /*
     * A mark that says +2 rather than a key is worked out from the key in
     * force where it sits — the song's own, or whatever an earlier mark made
     * it. With no key to move, there is nothing to say, so it is left out.
     */
    let running = meta.key ?? region?.key ?? openingKey;
    const keyChanges: { bar: number; key: string }[] = [];
    for (const mark of marks) {
      const key = mark.key ?? (mark.shift !== undefined && running ? transposeKey(running, mark.shift) : null);
      if (!key) continue;
      running = key;
      keyChanges.push({ bar: mark.bar, key });
    }

    return {
      title: meta.title,
      raw: loc.name,
      notes: group?.annotation.trim() ?? '',
      startBar: toBar(loc.beat),
      endBar: Number.isFinite(endBeat) ? toBar(endBeat) : toBar(loc.beat),
      bpm: meta.bpm ?? region?.bpm ?? null,
      key: meta.key ?? region?.key ?? openingKey,
      keyChanges,
      durationText: meta.durationText ?? region?.durationText ?? null,
      tags: meta.tags,
      flags: meta.flags,
      endsAtStop,
      startBpm,
      slateBars: slateClips
        .filter((c) => c.startBeat >= loc.beat - 1e-6 && c.startBeat < endBeat)
        .map((c) => relBar(c.startBeat)),
      sections: sections.filter(within).map((c) => ({ bar: relBar(c.beat), text: c.name })),
      ...songLanes(laneDefs, within, relBar),
      // Ableton writes a step change as two points at the same instant; the
      // second is the new tempo, so only that one is worth keeping.
      tempoChanges: dedupeByBar(
        tempoChanges
          .filter((t) => t.beat >= loc.beat - 1e-6 && t.beat < endBeat)
          .map((t) => ({ bar: relBar(t.beat), bpm: t.bpm })),
      ),
      // Patch changes the app wrote in. Reported raw; turning a name back into
      // a message is the importer's job, not the parser's.
      rigMarks: locators
        .filter((l) => isRigLocator(l.name) && l.beat >= loc.beat - 1e-6 && l.beat < endBeat)
        .map((l) => ({ bar: relBar(l.beat), name: l.name })),
      timeSigNum: signature.num,
      timeSigDen: signature.den,
      caveats,
      rigTracks: rigTrackDefs
        .map((t) => ({
          name: t.name,
          kind: t.kind,
          clips: t.clips
            .filter((c) => c.beat < endBeat && (Number.isNaN(c.endBeat) ? c.beat >= loc.beat - 1e-6 : c.endBeat > loc.beat))
            .map((c) => ({
              name: c.name,
              startBar: relBar(Math.max(c.beat, loc.beat)),
              endBar: Number.isNaN(c.endBeat) ? relBar(Math.max(c.beat, loc.beat)) : relBar(Math.min(c.endBeat, endBeat)),
            })),
        }))
        .filter((t) => t.clips.length),
      // What those tracks' clips send inside this song, on the set's timeline.
      rigPatches: rigTrackDefs.flatMap((t) =>
        (t.kind === 'midi' ? t.patches : [])
          .filter((r) => r.beat >= loc.beat - 1e-6 && r.beat < endBeat)
          .map((r) => ({
            bar: Math.round(relBar(r.beat) * 4) / 4,
            name: r.name,
            track: t.name,
            ...(rigTrackMember(t.name) ?? {}),
            channel: r.channel,
            ...(r.program !== undefined ? { program: r.program } : {}),
            ...(r.bank !== undefined ? { bank: r.bank } : {}),
            ...(r.controls.length ? { controls: r.controls } : {}),
          })),
      ),
      stems,
    };
  });

  return { creator, tempo, timeSigNum, timeSigDen, songs, warnings, buses };
}

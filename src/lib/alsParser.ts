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

export interface TempoChange {
  /** Beats from the start of the set. */
  beat: number;
  bpm: number;
}

export interface AlsEvent {
  /** 1-based bar within the song. */
  bar: number;
  text: string;
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
  /**
   * The set's own rig tracks — MIDI to a pedalboard or the lights, a video
   * track, a timecode track — cut down to what plays inside this song.
   */
  rigTracks: AlsRigTrack[];
  /**
   * Audio files Ableton has on this song's tracks, when it has its own group.
   * `regions` is null when the track plays throughout, which is the usual case.
   */
  stems: {
    name: string;
    /**
     * A reference recording rather than a part of the band's own mix: the
     * finished record to play against, or a piece of it. True when the track
     * says so itself or sits in a REF folder inside the song's group.
     */
    reference: boolean;
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

function clipsOfTrack(track: Track): RawClip[] {
  const clips: RawClip[] = [];
  for (const m of track.chunk.matchAll(/<AudioClip Id="\d+"[^>]*>([\s\S]*?)<\/AudioClip>/g)) {
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
      // Coarse in semitones, fine in cents — the clip's own transposition.
      semitones:
        (Number.isNaN(num(/<PitchCoarse Value="([-\d.]+)"/)) ? 0 : num(/<PitchCoarse Value="([-\d.]+)"/)) +
        (Number.isNaN(num(/<PitchFine Value="([-\d.]+)"/)) ? 0 : num(/<PitchFine Value="([-\d.]+)"/) / 100),
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
      .map((c) => ({ bar: relBar(c.beat), text: c.name })),
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
      chunk,
    }));

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

  const sections = clipsOf(trackByFlag(tracks, /\+\s*SECTIONS\b|^sections\b/i)?.chunk ?? '', 'MidiClip');

  /*
   * The rig's tracks: what the set sends out rather than plays to the band.
   * A MIDI track to a pedalboard, a lighting desk or a tuner; a video or a
   * timecode track. Known by their names, outside any song's group, and
   * never one of the set's own text or click tracks.
   */
  const RIG_TRACK = /\b(midi|rig|patch(es)?|program|pc|video|vid|timecode|tc|ltc|smpte|light(s|ing)?|cortex|helix|kemper|axe|autotune|tuner)\b/i;
  const NOT_RIG = /^(song|arrangement|tempo track|click|cue|cues)$|\+\s*(lyrics|sections)\b|\bslates?\b/i;
  const VIDEO_FILE = /\.(mp4|mov|m4v|avi|mkv|webm)$/i;
  const rigTrackDefs = tracks
    .filter((t) => (t.kind === 'MidiTrack' || t.kind === 'AudioTrack') && !NOT_RIG.test(t.name.trim()))
    .filter((t) => {
      const parent = t.groupId === '-1' ? undefined : tracks.find((g) => g.id === t.groupId);
      const top = parent ? parent.groupId === '-1' && RIG_TRACK.test(parent.name) : true;
      return top && (RIG_TRACK.test(t.name) || (parent ? RIG_TRACK.test(parent.name) : false));
    })
    .map((t) => {
      if (t.kind === 'MidiTrack') {
        return { name: t.name, kind: 'midi' as const, clips: clipsOf(t.chunk, 'MidiClip', 'clip') };
      }
      const raw = clipsOfTrack(t);
      const kind = raw.some((c) => VIDEO_FILE.test(c.path)) || /\b(video|vid)\b/i.test(t.name) ? 'video' as const : 'audio' as const;
      return {
        name: t.name,
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
    const relBar = (beat: number) => {
      const bar = (beat - loc.beat) / beatsPerBar + 1;
      const rounded = Math.round(bar);
      return Math.abs(bar - rounded) < 0.001 ? rounded : Math.round(bar * 1000) / 1000;
    };

    // Match a group track to the song by name, so stems can be attributed.
    const group = groupFor(meta.title, loc.beat, endBeat);
    const stems = group
      ? tracks
          .filter((t) => t.kind === 'AudioTrack' && rootOf(t) === group)
          .map((t) => {
            // Every group between the track and the song's own group; the
            // song group itself is not a folder the track was filed under.
            const folders: string[] = [];
            for (let c = byId.get(t.groupId), i = 0; c && c !== group && i < 8; i++) {
              folders.push(c.name);
              c = byId.get(c.groupId);
            }
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
              sourceStartSec: sourceStartSec(c, Math.max(0, loc.beat - c.startBeat)),
              disabled: c.disabled,
              fadeInSec: c.fadeInSec,
              fadeOutSec: c.fadeOutSec,
              warped: c.warpBps !== null,
              semitones: c.semitones,
              // A warped file at another tempo is stretched to this song's:
              // its beats per second against the song's, where they differ.
              speed:
                c.warpBps && Math.abs(startBpm / 60 / c.warpBps - 1) > 0.005
                  ? startBpm / 60 / c.warpBps
                  : 1,
            }));
            const sounding = mine.find((c) => !c.disabled) ?? mine[0];
            return {
              name: t.name,
              reference,
              path: sounding?.path ?? '',
              regions: audibleRegions(mine, muted, loc.beat, endBeat, relBar),
              clips,
            };
          })
          .filter((s) => s.path)
      : [];

    if (!stems.length) warnings.push(`No audio tracks found for “${meta.title}”.`);

    return {
      title: meta.title,
      raw: loc.name,
      startBar: toBar(loc.beat),
      endBar: Number.isFinite(endBeat) ? toBar(endBeat) : toBar(loc.beat),
      bpm: meta.bpm ?? region?.bpm ?? null,
      key: meta.key ?? region?.key ?? null,
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
      stems,
    };
  });

  return { creator, tempo, timeSigNum, timeSigDen, songs, warnings };
}

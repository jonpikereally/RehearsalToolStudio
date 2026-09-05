/** Core data model. Everything here is persisted to `<root>/.rehearsal-tool.json` in Dropbox. */

export type VariantId = string;
export type SongId = string;

/**
 * How a file behaves in the player.
 *
 * `mix` files are complete mixes and are mutually exclusive — picking one
 * replaces the other, which is what makes "with vocal" → "without vocal"
 * seamless. `stem` files are individual instruments and all play together,
 * each with its own fader, mute and solo.
 */
export type VariantRole = 'mix' | 'stem';

/** A stretch of a part that sounds, in song-relative bars. */
export interface AudibleRegion {
  startBar: number;
  endBar: number;
}

export interface Variant {
  /** Stable id: the Dropbox path (lowercased). */
  id: VariantId;
  /** Display label, e.g. "vocal", "no vocal", "drums". Derived from the filename suffix. */
  name: string;
  /** Auto-detected from the label on first scan; editable per song afterwards. */
  role?: VariantRole;
  /** Full Dropbox path, original casing. */
  path: string;
  /** Dropbox content hash / rev, used to invalidate the cache when you re-export. */
  rev: string;
  sizeBytes: number;
  /**
   * The record's own part rather than the band's.
   *
   * True for anything the set filed under a REF group, and for anything whose
   * track name says so. Held as a fact about the part rather than read off its
   * name each time, because the name is the one thing anybody can change: a
   * "REF DRUMS" renamed to "drums" in the mixer is still the record's drums,
   * and a player that forgot would mix the two together.
   *
   * The reference *master* — the whole record, the thing SWITCH plays — is a
   * mix, not a stem, and is not this.
   */
  reference?: boolean;
  /**
   * A sampler part: a pattern of notes and the one-shot samples they strike,
   * instead of a rendered file. The set's click and cues come out this way —
   * a click is two samples struck hundreds of times, and rendering that into
   * a song-length file made megabytes out of kilobytes. Absent means audio.
   * `path` still names the first sample here, since the studio's loader
   * wants a path; the band's library is written without it.
   */
  kind?: 'sampler';
  samples?: SamplerSample[];
  notes?: SamplerNote[];
  /** Hidden from the variant switcher without deleting it. */
  hidden?: boolean;
  /** Manual ordering within the song. */
  order?: number;
  /**
   * The version this part belongs to, when its folder doesn't say.
   *
   * Prints made by the app live in their own folder, away from the project
   * they were made from, so they carry the version they belong to rather than
   * forming one of their own.
   */
  versionId?: string;
  /**
   * Where this part sounds, when the set says it isn't simply throughout.
   * Absent means the whole song, which is the ordinary case. An empty list
   * means nowhere — the track was muted in Ableton.
   */
  regions?: AudibleRegion[];
  /**
   * Where the file sits against the song: at song bar `bar`, the file is
   * `sourceSec` seconds in. Absent means the file starts on bar 1, which is
   * how an export from 1.1.1 lands. A set whose clip begins two bars after
   * the locator says so here — without it the file would play two bars
   * early, and the region gate would swallow its intro.
   */
  placement?: { bar: number; sourceSec: number };
  /**
   * The clip's own transposition in Live, in semitones, mirrored here on
   * top of whatever the player transposes; and how much faster than its
   * file the clip plays, from its warp. Absent means none and 1.
   */
  pitch?: number;
  speed?: number;
  /**
   * The fader and pan the set has for this part — the track's, times every
   * group above it — as the mixer's starting position until you move it.
   * Linear gain, 1 for unity; pan -1..1. Absent means unity, centred.
   */
  gain?: number;
  pan?: number;
  /**
   * The devices on the track and on its groups, in order, for the player
   * to imitate. What a return bus does after that is the venue's business
   * — output processing, not the song — and is left alone.
   */
  devices?: Device[];
  /**
   * The part as an arrangement of clips, when it is more than one file
   * played from one point: a phrase dropped in from another take, the
   * vocal picked up again ten seconds further in. Each names its file and
   * where it sits; the player renders them flat before it plays. Absent for
   * the ordinary part, which is `path` placed once.
   */
  clips?: VariantClip[];
}

/** One sample a sampler part can strike, by MIDI note. */
export interface SamplerSample {
  /** MIDI note number, 0..127. */
  note: number;
  /** Relative to the band's folder: `Resources/kick-1a2b3c4d.wav`. */
  path: string;
  rev: string;
  sizeBytes: number;
  /**
   * The pad's own level times the track's, linear. Not part of the contract
   * the website reads — it ignores what it does not know — but what the set
   * had, and what the studio's own player honours.
   */
  gain?: number;
}

/** One strike: which note, at which bar. */
export interface SamplerNote {
  /** 1-based, fractional: 9.5 is halfway through bar 9. */
  bar: number;
  note: number;
  /** 0..1, the raw MIDI velocity over 127; absent means full. */
  velocity?: number;
}

/** One clip of an arranged part: which file, where in the song, where in the file. */
export interface VariantClip {
  path: string;
  startBar: number;
  endBar: number;
  sourceStartSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** The clip's own transposition in Live, in semitones. */
  semitones: number;
  /** How much faster than its file the clip plays, from its warp; 1 for as is. */
  speed: number;
  /** The clip's own gain in Live, linear. */
  gain: number;
}

export interface Marker {
  id: string;
  name: string;
  /** 1-based bar number. */
  bar: number;
}

/**
 * A message for the rig on the floor.
 *
 * Lives in the core model rather than beside the MIDI code because it is saved
 * with the song now — see `Song.patchClips`.
 */
export interface Patch {
  /** 1–16, as printed on hardware. */
  channel: number;
  /** 0–127. Absent when the change is control messages alone. */
  program?: number;
  /** Bank select, when the rig needs it. */
  bank?: number;
  /**
   * Control changes sent with it.
   *
   * Not everything worth switching is a program change: a Helix snapshot and a
   * Quad Cortex scene are both CCs, and they're what you actually reach for
   * mid-song — a program change reloads the whole rig, a snapshot doesn't.
   */
  controls?: { cc: number; value: number }[];
  /** Which entry in the device dictionary made this, for showing it back. */
  source?: string;
}

/** One patch change, at a bar. See `PatchClip` in `lib/midi` for the detail. */
export interface PatchClip {
  id: string;
  /** 1-based bar it fires on. */
  bar: number;
  patch: Patch;
  /** How long it lasts. Absent means "until the next change". */
  lengthBars?: number;
  /** What to send at the end. Absent means whatever was in force before it. */
  endPatch?: Patch;
}

/** A tempo change, at a 1-based bar. */
export interface TempoPoint {
  bar: number;
  bpm: number;
}

/** A lyric line or a chord, pinned to a 1-based bar. */
export interface TimedText {
  bar: number;
  text: string;
}

/** One named track of timed text, e.g. the lyrics or the chords. */
export interface ChartLane {
  id: string;
  name: string;
  kind: 'lyrics' | 'chords';
  items: TimedText[];
}

/**
 * A device on a track or a bus in Live, as far as it can be read: which
 * device, whether it is on, its main knobs, and for EQ Eight its bands.
 * `supported` says whether this app can imitate it in Web Audio.
 */
export interface Device {
  kind: string;
  name: string;
  on: boolean;
  supported: boolean;
  params: Record<string, number | boolean>;
  bands?: { on: boolean; mode: number; freq: number; gain: number; q: number }[];
}

/** A return bus in the set: what feeds it is summed, run through its devices, and sent on. */
export interface Bus {
  name: string;
  gain: number;
  pan: number;
  devices: Device[];
  /** Whether the bus reaches an output itself. */
  direct: boolean;
  /** Its own sends into other buses, by index. */
  sends: { bus: number; level: number }[];
}

/** One of the set's rig tracks, cut down to one song. */
export interface RigTrack {
  name: string;
  kind: 'midi' | 'audio' | 'video';
  clips: { name: string; bar: number; endBar: number }[];
}

export interface Song {
  /** Stable id: the Dropbox folder path + base name (lowercased). */
  id: SongId;
  title: string;
  /** Folder the variants live in. */
  folderPath: string;
  /**
   * The Ableton set this song came out of, when it came from one. Kept so the
   * app can write back to it — the id carries the same path, but lowercased.
   */
  setPath?: string;
  /** Grouping name derived from the folder structure; editable. */
  project: string;
  artist?: string;

  bpm: number;
  /**
   * Tempo changes within the song, if it has any. Bar 1 runs at `bpm` unless
   * a point says otherwise. Absent means a single constant tempo throughout.
   */
  tempoMap?: TempoPoint[];
  timeSigNum: number;
  timeSigDen: number;
  /**
   * Seconds from the start of the file to the downbeat of bar 1.
   * Ableton exports from 1.1.1 are 0; set this if your render has a lead-in.
   */
  firstBarOffsetSec: number;

  /** Original key as written, e.g. "F#m". Purely informational. */
  originalKey?: string;
  /** Semitone transposition currently applied, -12..+12. */
  transpose: number;
  /**
   * Playback speed as a fraction of the recording's own: 1 is untouched, 0.9 a
   * tenth slower. Applied uniformly, so a song whose tempo map steps 136→140
   * still steps — the whole shape scales rather than flattening.
   */
  tempoScale?: number;

  /**
   * What to send the rig, and where.
   *
   * Saved with the song rather than on the device it was programmed on, so a
   * set worked out on the laptop is there on the phone at the gig. It does mean
   * anyone sharing the folder sees them — patch numbers mean something
   * different on every rig, so treat someone else's as information rather than
   * as something to play.
   */
  patchClips?: PatchClip[];
  /**
   * The set's own rig tracks inside this song — MIDI to the pedalboard or
   * the lights, video, timecode — as Ableton plays them. Read from the set
   * and shown, never sent from here: Live drives the rig, this shows what it
   * will do and when.
   */
  rig?: RigTrack[];
  /**
   * What this app cannot play as Ableton does — a time signature change
   * partway through, say — read from the set and shown with the song.
   */
  caveats?: string[];

  variants: Variant[];
  /**
   * Where the generated click sits among the mixer channels. It has no Variant
   * of its own to carry an `order`, so it keeps one here — in the library
   * rather than on the device, like the stem order, since a sensible layout is
   * worth sharing with the band.
   */
  clickOrder?: number;
  markers: Marker[];
  /** Lyric lines and chords, when a song came from an Ableton set. */
  lyrics?: TimedText[];
  chords?: TimedText[];
  /**
   * The set's text tracks kept separate — lead lyrics, chords, cues, notes —
   * so the reader can pick which ones to look at. `lyrics` and `chords` above
   * are the merged view of the same events.
   */
  lanes?: ChartLane[];
  /**
   * Free text about the song. Typed here, or — where the set has any — the
   * info text on the song's group track in Live, which a rescan brings in and
   * which wins over what was typed: the set is where the band writes to
   * itself, and two places to keep the same note is one too many.
   */
  notes?: string;

  /**
   * How long the song runs, once anything has played it.
   *
   * Not known from the files alone — it comes from the decoded audio — so it is
   * remembered the first time a song is opened, which is what lets a setlist
   * show times without loading every song in it.
   */
  durationSec?: number;

  /** Epoch ms, used to resolve sync conflicts between devices. */
  updatedAt: number;
  /** True until the user has confirmed/edited the tempo. Drives the "needs tempo" badge. */
  tempoUnset?: boolean;
}

export interface Setlist {
  id: string;
  name: string;
  songIds: SongId[];
  notes?: string;
  updatedAt: number;
}

export interface Library {
  version: 1;
  /** Dropbox folder that was scanned. */
  root: string;
  songs: Song[];
  setlists: Setlist[];
  updatedAt: number;
}

export function emptyLibrary(root = ''): Library {
  return { version: 1, root, songs: [], setlists: [], updatedAt: 0 };
}

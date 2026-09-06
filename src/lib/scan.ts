import type { FileEntry } from './files';
import { RENDER_DATE_SUFFIX } from './preparedSet.ts';
import { normalisePath } from './paths.ts';
import type { Library, Setlist, Song, Variant, VariantRole } from '../types';

/**
 * Turn a flat Dropbox file listing into songs and variants.
 *
 * One folder per song is the usual shape, with each file tagged by bracket:
 *
 *   Long Way Down {128, F#m, 4-4}/
 *     Long Way Down (full mix).mp3
 *     Long Way Down [guitar].mp3
 *
 * Files are grouped into songs by their base name once every tag is stripped,
 * so a flat folder holding several songs works just as well.
 */

const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'aac', 'mp4', 'wav', 'wave', 'aif', 'aiff', 'flac', 'ogg', 'oga', 'opus', 'caf',
]);

export function isAudio(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return AUDIO_EXT.has(ext);
}

/**
 * Ableton project scaffolding, which never holds anything worth listing.
 *
 * `Backup` alone can hold dozens of copies of a set — one project here has 35 —
 * and reading them all would both take an age and fill the library with stale
 * duplicates of every song.
 */
// Resources holds the one-shots sampler parts strike, shared across every set;
// read as songs it would be two hundred songs called "kick".
const IGNORED_DIR = /(^|\/)(Backup|Archive Sets?|Samples|Resources|Ableton Project Info|AbleSet)(\/|$)/i;

export function isProjectScaffolding(path: string): boolean {
  return IGNORED_DIR.test(path);
}

/**
 * Folders holding a set file. A set describes everything beneath it, so the
 * folder scan leaves that territory alone — otherwise reference mixes, cue
 * files and tempo bounces all turn up as songs in their own right.
 */
export function setOwnedFolders(files: FileEntry[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.als')) continue;
    if (isProjectScaffolding(file.path)) continue;
    folders.add(parentPath(file.path).toLowerCase());
  }
  return [...folders];
}

/**
 * One set file per folder: the newest.
 *
 * Ableton sets are commonly kept as dated versions side by side, and importing
 * both would produce two copies of every song — the older one stale.
 */
export function newestSetPerFolder(files: FileEntry[]): FileEntry[] {
  const best = new Map<string, FileEntry>();
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.als')) continue;
    if (isProjectScaffolding(file.path)) continue;
    const folder = parentPath(file.path).toLowerCase();
    const current = best.get(folder);
    // Fall back to the name when timestamps are equal or missing; dated names
    // like "2026.06.22" sort correctly.
    const newer =
      !current ||
      file.modified > current.modified ||
      (file.modified === current.modified && file.name.localeCompare(current.name) > 0);
    if (newer) best.set(folder, file);
  }
  return [...best.values()];
}

export function isUnderAnyFolder(path: string, folders: string[]): boolean {
  const lower = path.toLowerCase();
  return folders.some((f) => f !== '' && (lower === f || lower.startsWith(f + '/')));
}

/** Formats small enough to stream happily to a phone. */
const COMPRESSED_EXT = new Set(['mp3', 'm4a', 'aac', 'mp4', 'ogg', 'oga', 'opus']);

export function isCompressed(name: string): boolean {
  return COMPRESSED_EXT.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
}

/**
 * Keep one file per part when the same part exists in several formats.
 *
 * Running the converter leaves a WAV master beside the AAC it produced; without
 * this they would appear as two identical-looking stems, and a phone might pull
 * the 50 MB one. The compressed file wins; ties go to the smaller file.
 */
function preferCompressed(files: FileEntry[]): FileEntry[] {
  const best = new Map<string, FileEntry>();
  for (const file of files) {
    const { label, role } = parseFileName(stripExt(file.name));
    const key = `${role}:${label.toLowerCase()}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, file);
      continue;
    }
    const wins =
      (isCompressed(file.name) && !isCompressed(existing.name)) ||
      (isCompressed(file.name) === isCompressed(existing.name) && file.size < existing.size);
    if (wins) best.set(key, file);
  }
  return [...best.values()];
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Split "Song Name - no vocal" into its song and variant halves. */
export function splitVariant(fileStem: string): { base: string; label: string } {
  const m = fileStem.match(/^(.*\S)\s+-\s+(\S.*)$/);
  if (!m) return { base: fileStem.trim(), label: 'main' };
  return { base: m[1].trim(), label: m[2].trim() };
}

/* ------------------------------ name tagging ------------------------------
 *
 * Three kinds of information can be tagged onto a file or folder name, each in
 * its own bracket so they may appear in any order and can never be confused
 * with one another:
 *
 *   {curly}   song info — tempo, key, time signature, comma separated
 *   [square]  stem      — one instrument, mixed alongside the others
 *   (round)   version   — a complete alternate mix, exclusive
 *
 *   Long Way Down {128, F#m, 4-4} [guitar].mp3
 *   Long Way Down {128, F#m} (no vocal).mp3
 *
 * Values are comma separated. The time signature uses a hyphen rather than the
 * usual slash because a slash cannot appear in a file name at all.
 */

const SONG_INFO_BLOCK = /\{([^}]*)\}/;

/** Values inside the song-info block, each recognised by its shape. */
const TIMESIG_VALUE = /^(\d{1,2})\s*[-\u2013/]\s*(\d{1,2})$/;
const BPM_VALUE = /^(\d{2,3}(?:\.\d+)?)\s*(?:bpm)?$/i;
const KEY_VALUE = /^([A-Ga-g][#b♯♭]?(?:m|min|maj|major|minor)?)$/;

/** Earlier style, still read: a bare `128bpm`, or a tempo/key in any bracket. */
const LEGACY_BPM = /[[(]?\s*(\d{2,3}(?:\.\d+)?)\s*bpm\s*[\])]?/i;
const LEGACY_KEY = /[[(]\s*([A-Ga-g][#b♯♭]?(?:m|min|maj|major|minor)?)\s*[\])]/;

/** Whatever bracket survives the tag pass names the stem or the version. */
const STEM_TOKEN = /\[\s*([^\]]+?)\s*\]/;
const VERSION_TOKEN = /\(\s*([^)]+?)\s*\)/;

function tidyKey(raw: string): string {
  const key = raw.replace('♯', '#').replace('♭', 'b');
  return key[0].toUpperCase() + key.slice(1);
}

/** Collapse the gaps a removed tag leaves behind. */
function tidy(name: string): string {
  return name.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—_]+|[\s\-–—_]+$/g, '').trim();
}

export interface TimeSignature {
  num: number;
  den: number;
}

export interface NameMeta {
  /** The name with every tag removed. */
  title: string;
  bpm: number | null;
  key: string | null;
  timeSig: TimeSignature | null;
}

interface Tags {
  rest: string;
  bpm: number | null;
  key: string | null;
  timeSig: TimeSignature | null;
}

/** Take the song-info tags out of a name, returning them and what remains. */
function extractTags(name: string): Tags {
  let rest = name;
  let bpm: number | null = null;
  let key: string | null = null;
  let timeSig: TimeSignature | null = null;

  const block = rest.match(SONG_INFO_BLOCK);
  if (block) {
    for (const raw of block[1].split(',')) {
      const value = raw.trim();
      if (!value) continue;

      const sig = value.match(TIMESIG_VALUE);
      if (sig) {
        const num = Number(sig[1]);
        const den = Number(sig[2]);
        if (num >= 1 && num <= 32 && [1, 2, 4, 8, 16].includes(den)) timeSig = { num, den };
        continue;
      }
      const tempo = value.match(BPM_VALUE);
      if (tempo) {
        const n = parseFloat(tempo[1]);
        if (n >= 20 && n <= 300) bpm = n;
        continue;
      }
      const note = value.match(KEY_VALUE);
      if (note) key = tidyKey(note[1]);
    }
    rest = rest.replace(block[0], ' ');
  }

  // Strip the older tags whether or not they won, so a leftover `[128bpm]`
  // is never mistaken for a stem called "128bpm".
  const legacyBpm = rest.match(LEGACY_BPM);
  if (legacyBpm) {
    const n = parseFloat(legacyBpm[1]);
    if (n >= 20 && n <= 300) {
      if (bpm == null) bpm = n;
      rest = rest.replace(legacyBpm[0], ' ');
    }
  }
  const legacyKey = rest.match(LEGACY_KEY);
  if (legacyKey) {
    if (key == null) key = tidyKey(legacyKey[1]);
    rest = rest.replace(legacyKey[0], ' ');
  }

  return { rest, bpm, key, timeSig };
}

/** Read the tags off a song or folder name. */
export function parseNameMeta(name: string): NameMeta {
  const { rest, bpm, key, timeSig } = extractTags(name);
  // A prepared song folder ends in the day it was rendered, which is not the title.
  return { title: tidy(rest.replace(RENDER_DATE_SUFFIX, ' ')) || name.trim(), bpm, key, timeSig };
}

export interface ParsedFileName {
  /** Song name, with every tag stripped. */
  base: string;
  /** The stem or version label. */
  label: string;
  role: VariantRole;
  bpm: number | null;
  key: string | null;
  timeSig: TimeSignature | null;
}

/**
 * Read everything a file name carries.
 *
 * `[square]` marks a stem and `(round)` marks a version, which settles the one
 * case an instrument word list never could: `[vocal]` is a stem, `(vocal)` is a
 * mix. Song-info tags come out first so `{128, F#m}` is never taken for either.
 * A trailing " - name" is still read as a version, for files named before the
 * bracket convention.
 */
export function parseFileName(fileStem: string): ParsedFileName {
  const { rest, bpm, key, timeSig } = extractTags(fileStem);
  let remaining = rest;

  const stem = remaining.match(STEM_TOKEN);
  if (stem) remaining = remaining.replace(stem[0], ' ');

  const version = remaining.match(VERSION_TOKEN);
  if (version) remaining = remaining.replace(version[0], ' ');

  const base = tidy(remaining) || fileStem.trim();

  if (stem) return { base, label: stem[1].trim(), role: 'stem', bpm, key, timeSig };
  if (version) return { base, label: version[1].trim(), role: 'mix', bpm, key, timeSig };

  const split = splitVariant(base);
  return { base: split.base, label: split.label, role: defaultRole(split.label), bpm, key, timeSig };
}

/** Instrument names that mark a file as an individual stem rather than a full mix. */
const STEM_WORDS = [
  'drums', 'drum', 'kick', 'snare', 'hats', 'hihat', 'hi-hat', 'toms', 'percussion', 'perc',
  'bass', 'sub', '808',
  'guitar', 'guitars', 'gtr', 'gtrs', 'acoustic', 'electric', 'banjo', 'mando', 'mandolin',
  'keys', 'keyboard', 'keyboards', 'piano', 'rhodes', 'wurli', 'organ', 'synth', 'synths', 'pads',
  'strings', 'horns', 'brass', 'sax', 'trumpet', 'trombone', 'violin', 'cello', 'fiddle',
  'vocals', 'vox', 'bgv', 'bgvs', 'harmony', 'harmonies', 'choir',
  'click', 'metronome', 'count', 'countin', 'count-in',
  'cues', 'cue', 'guide',
  'fx', 'sfx', 'samples', 'loops', 'aux', 'misc',
];

const STEM_RE = new RegExp(`(^|[^a-z])(${STEM_WORDS.join('|')})([^a-z]|$)`, 'i');

/**
 * Decide whether a label names an individual instrument or a complete mix.
 *
 * A negated label ("no vocal", "without drums") always means a full mix — it
 * describes a mix by what it lacks. Note that bare "vocal" is a mix for the
 * same reason, while "vocals" and "vox" are stems; that distinction is the one
 * genuinely ambiguous case, and either can be overridden per song in the app.
 */
export function defaultRole(label: string): VariantRole {
  const l = label.toLowerCase().trim();
  if (/^(no|without|minus|sans)\b/.test(l)) return 'mix';
  if (/(^|[^a-z])(full|master|mix|main|original|reference|instrumental|backing)([^a-z]|$)/i.test(l)) {
    return 'mix';
  }
  if (l === 'vocal' || l === 'with vocal' || l === 'lead vocal') return 'mix';
  return STEM_RE.test(l) ? 'stem' : 'mix';
}

/**
 * Parts that must never be pitch shifted.
 *
 * A click has no pitch worth preserving, and transposing a spoken cue just
 * makes the voice wrong. Skipping them also saves a render and the cache space
 * it would occupy.
 */
const UNPITCHED_RE =
  /(^|[^a-z])(click|clicks|metronome|count|countin|count-in|countoff|count-off|cue|cues|guide)([^a-z]|$)/i;

export function isUnpitched(label: string): boolean {
  return UNPITCHED_RE.test(label);
}

/**
 * A reference master: the finished record, kept to play against rather than to
 * mix with.
 *
 * It behaves differently from every other whole mix — an instrumental or an
 * acapella is a part you might blend in, while this is the thing you A/B
 * against — so it is worth telling apart by name.
 */
const REFERENCE_RE = /\b(ref|reference|master)\b/i;

export function isReferenceName(label: string): boolean {
  return REFERENCE_RE.test(label);
}

/**
 * A part belonging to the record rather than the band, by its label alone.
 *
 * Narrower than `isReferenceName` on purpose: that one counts "master" so it
 * can spot the whole record, and counting it here would brand the band's own
 * master mix somebody else's.
 */
const REFERENCE_PART_RE = /\bref(erence)?\b/i;

export function isReferenceLabel(label: string): boolean {
  return REFERENCE_PART_RE.test(label);
}

/** Variants sort by an explicit order when set, else "fullest" first. */
function variantRank(label: string): number {
  const l = label.toLowerCase();
  if (/\b(full|master|mix|main|original)\b/.test(l)) return 0;
  if (/\bcue|guide\b/.test(l)) return 2;
  if (/\bno |without|minus|instrumental|backing\b/.test(l)) return 3;
  if (/\bvocal|voc\b/.test(l)) return 1;
  return 4;
}

function relativeTo(root: string, path: string): string {
  const r = normalisePath(root).toLowerCase();
  const p = path.toLowerCase();
  if (r && p.startsWith(r + '/')) return path.slice(r.length + 1);
  if (r && p === r) return '';
  return path.replace(/^\//, '');
}

/**
 * A folder wrapped in brackets is a project, and holds artist folders:
 *
 *   Artist/Song/…                  ← the usual shape
 *   [Summer Tour]/Artist/Song/…    ← a project groups several artists
 */
const PROJECT_FOLDER = /^[[({]\s*(.+?)\s*[\])}]$/;

export interface SongLocation {
  project: string | null;
  artist: string | null;
}

/**
 * Work out where a song sits from its folder path.
 *
 * The song folder is the last segment, the artist is the closest folder above
 * it that isn't a project, and the project is the closest bracketed folder
 * above that. Any depth in between is ignored, so a stray folder level doesn't
 * throw the whole library off.
 */
export function locateSong(root: string, folderPath: string): SongLocation {
  const rel = relativeTo(root, folderPath);
  const above = rel.split('/').filter(Boolean).slice(0, -1);

  let project: string | null = null;
  let artist: string | null = null;

  for (let i = above.length - 1; i >= 0; i--) {
    const match = above[i].match(PROJECT_FOLDER);
    if (match) {
      if (!project) project = match[1].trim();
    } else if (!artist) {
      artist = parseNameMeta(above[i]).title;
    }
  }
  return { project, artist };
}

export interface ScanResult {
  library: Library;
  addedSongs: string[];
  addedVariants: string[];
  removedVariants: string[];
  updatedVariants: string[];
  removedSongs: string[];
  /** Every file Dropbox returned for the scan root, audio or not. */
  filesSeen: number;
  /** How many of those had an audio extension. */
  audioSeen: number;
  /** A few names that were skipped, to explain an empty result. */
  skippedSamples: string[];
  /** Where the files were read from, so an empty scan says which. */
  sourceLabel?: string;
  /**
   * Files the two sources agreed on. Zero means they are looking at different
   * trees, which is a misconfiguration rather than a result.
   */
  overlap?: number | null;
  /** Ableton sets read during the scan. */
  alsSets?: number;
  /** Where those sets are, so one can be prepared without scanning again. */
  alsSetPaths?: string[];
  alsSongs?: number;
  /** Running orders taken from those sets, so a missing one is visible. */
  alsSetlists?: number;
  alsNotes?: string[];
}

/**
 * Merge a fresh listing into the existing library.
 *
 * Everything the user has typed — tempo, markers, transpose, notes, artist,
 * project overrides, variant ordering — is preserved across rescans. Files that
 * vanish from Dropbox are dropped; re-exported files are detected by `rev` so
 * their cached audio can be invalidated.
 */
export function mergeScan(
  existing: Library,
  files: FileEntry[],
  root: string,
  /** Files an Ableton set already accounts for, which must not be scanned twice. */
  claimed: Set<string> = new Set(),
  /**
   * Keep what this listing didn't see.
   *
   * A scan of one source can't see what the other holds, so absence from it
   * means nothing — a Dropbox file that hasn't synced to this machine is not a
   * deleted file. Only a scan that read everything is entitled to decide
   * something has gone.
   */
  keepUnseen = false,
): ScanResult {
  const audio = files.filter((f) => isAudio(f.name) && !claimed.has(f.path.toLowerCase()));

  // folderPath -> base -> files
  const groups = new Map<string, FileEntry[]>();
  const groupMeta = new Map<string, { folderPath: string; base: string }>();

  for (const file of audio) {
    const folderPath = parentPath(file.path);
    // The base name is what groups a song's files together, so it must be read
    // with every tag stripped — `Song [guitar]` and `Song - vocal` are one song.
    const { base } = parseFileName(stripExt(file.name));
    const key = `${folderPath.toLowerCase()}::${base.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      groupMeta.set(key, { folderPath, base });
    }
    groups.get(key)!.push(file);
  }

  // How many distinct songs share a folder? Decides whether the folder name or
  // the file's base name is the better title.
  const groupsPerFolder = new Map<string, number>();
  for (const { folderPath } of groupMeta.values()) {
    const k = folderPath.toLowerCase();
    groupsPerFolder.set(k, (groupsPerFolder.get(k) ?? 0) + 1);
  }

  const prevSongs = new Map(existing.songs.map((s) => [s.id, s]));
  const result: ScanResult = {
    library: { ...existing, root: normalisePath(root), songs: [], setlists: existing.setlists },
    addedSongs: [],
    addedVariants: [],
    removedVariants: [],
    updatedVariants: [],
    removedSongs: [],
    filesSeen: files.length,
    audioSeen: audio.length,
    skippedSamples: files
      .filter((f) => !isAudio(f.name))
      .slice(0, 5)
      .map((f) => f.name),
  };

  const songs: Song[] = [];

  for (const [key, allGroupFiles] of groups) {
    // One file per part, so a WAV and the AAC beside it aren't two stems.
    const groupFiles = preferCompressed(allGroupFiles);
    const meta = groupMeta.get(key)!;
    const soleGroupInFolder = (groupsPerFolder.get(meta.folderPath.toLowerCase()) ?? 1) === 1;
    const folderName = baseName(meta.folderPath);
    // Tempo and key may be tagged on any of the song's files or on the folder.
    const fileMetas = groupFiles.map((f) => parseFileName(stripExt(f.name)));
    const fromFolder = parseNameMeta(folderName);
    // `meta.base` already has its tags stripped by parseFileName.
    const title = soleGroupInFolder && folderName ? fromFolder.title : meta.base;

    const prev = prevSongs.get(key);
    const prevVariants = new Map((prev?.variants ?? []).map((v) => [v.id, v]));

    const variants: Variant[] = groupFiles
      .map((f) => {
        const parsed = parseFileName(stripExt(f.name));
        const id = f.path.toLowerCase();
        const old = prevVariants.get(id);
        if (!old) {
          if (prev) result.addedVariants.push(f.path);
        } else if (old.rev !== f.rev) {
          result.updatedVariants.push(f.path);
        }
        return {
          id,
          name: old?.name ?? parsed.label,
          // Keep any role the user set by hand; only derive it for new files.
          role: old?.role ?? parsed.role,
          /*
           * A prepared set writes "[ref drums]", so the label is where this
           * comes from for a folder of files. Read once and kept, so renaming
           * the part in the mixer cannot lose it.
           */
          reference: old?.reference ?? (isReferenceLabel(parsed.label) || undefined),
          path: f.path,
          rev: f.rev,
          sizeBytes: f.size,
          hidden: old?.hidden,
          order: old?.order,
        } satisfies Variant;
      })
      .sort((a, b) => {
        const ao = a.order ?? variantRank(a.name);
        const bo = b.order ?? variantRank(b.name);
        return ao - bo || a.name.localeCompare(b.name);
      });

    for (const old of prevVariants.values()) {
      if (variants.some((v) => v.id === old.id)) continue;
      if (keepUnseen) variants.push(old);
      else result.removedVariants.push(old.path);
    }

    const location = locateSong(root, meta.folderPath);

    if (prev) {
      // Moving a song to a different folder re-derives where it sits; leaving
      // it put keeps whatever artist or project the user typed by hand.
      const moved = prev.folderPath.toLowerCase() !== meta.folderPath.toLowerCase();
      songs.push({
        ...prev,
        folderPath: meta.folderPath,
        project: moved ? location.project ?? 'Unfiled' : prev.project,
        artist: moved ? location.artist ?? undefined : prev.artist,
        variants,
      });
    } else {
      result.addedSongs.push(title);
      // Tags may sit on any of the song's files, or on the folder name.
      const bpm = fileMetas.find((m) => m.bpm != null)?.bpm ?? fromFolder.bpm;
      const originalKey =
        fileMetas.find((m) => m.key != null)?.key ?? fromFolder.key ?? undefined;
      const timeSig =
        fileMetas.find((m) => m.timeSig != null)?.timeSig ?? fromFolder.timeSig;
      songs.push({
        id: key,
        title,
        folderPath: meta.folderPath,
        project: location.project ?? 'Unfiled',
        artist: location.artist ?? undefined,
        bpm: bpm ?? 120,
        tempoUnset: bpm == null,
        timeSigNum: timeSig?.num ?? 4,
        timeSigDen: timeSig?.den ?? 4,
        firstBarOffsetSec: 0,
        originalKey,
        transpose: 0,
        variants,
        markers: [],
        updatedAt: Date.now(),
      });
    }
  }

  for (const prev of prevSongs.values()) {
    // Songs owned by an Ableton set are merged in separately.
    if (prev.id.startsWith('als:')) continue;
    if (groups.has(prev.id)) continue;
    if (keepUnseen) songs.push(prev);
    else result.removedSongs.push(prev.title);
  }

  songs.sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
  result.library.songs = songs;
  result.library.updatedAt = Date.now();

  // Setlists are left alone here. A song owned by a set isn't in `songs` yet —
  // sets are merged in afterwards — so pruning now would strip every one of
  // them from every setlist on each rescan. `syncSetlists` does it once the
  // library is whole.
  result.library.setlists = existing.setlists;

  return result;
}

/**
 * Setlists, once the library is whole: the sets rebuilt, the rest pruned.
 *
 * A set is a running order, and re-reading it is the only way that order can
 * follow what you do in Ableton — so a setlist that came from a set is
 * *replaced* rather than merged. Reordering one by hand won't survive the next
 * scan, which is the trade for it staying true to the set.
 *
 * Anything you made by hand is only ever pruned of songs that have gone, and a
 * set's own setlist disappears with the set rather than lingering empty.
 */
export function syncSetlists(
  existing: Setlist[],
  /** One per set read this scan, in arrangement order. */
  fromSets: Setlist[],
  liveIds: Set<string>,
): Setlist[] {
  const scanned = new Map(fromSets.map((sl) => [sl.id, sl]));
  const out: Setlist[] = [];

  for (const sl of existing) {
    const fresh = scanned.get(sl.id);
    if (fresh) {
      scanned.delete(sl.id);
      // Only claim a change when there is one: `updatedAt` decides which
      // device's copy wins, so touching it every scan would have two phones
      // overwriting each other with identical setlists.
      const same =
        sl.name === fresh.name &&
        sl.songIds.length === fresh.songIds.length &&
        sl.songIds.every((id, i) => id === fresh.songIds[i]);
      out.push(same ? sl : { ...sl, name: fresh.name, songIds: fresh.songIds, updatedAt: fresh.updatedAt });
      continue;
    }

    const kept = sl.songIds.filter((id) => liveIds.has(id));
    // A set that is no longer there takes its setlist with it; one you made
    // stays, empty or not, because you made it. (`als:` ids are the set's own,
    // as they are for its songs above — checked here rather than imported, so
    // the scan doesn't have to depend on the importer.)
    if (sl.id.startsWith('als:') && kept.length === 0) continue;
    out.push(kept.length === sl.songIds.length ? sl : { ...sl, songIds: kept });
  }

  return [...out, ...scanned.values()];
}

import type { ChartLane, Marker, PatchClip, Song, TempoPoint, TimedText } from '../types';

/**
 * What a folder of files can't say for itself.
 *
 * A prepared set is deliberately an ordinary library — bracketed names, facts
 * in the folder name — so that anything can play it. But a folder name holds
 * one tempo, and a song may change tempo; it holds no sections and no chords;
 * and it can't mention that the encoder added a lead-in. All of that would be
 * thrown away in the writing.
 *
 * So one small file sits beside the songs carrying the rest. It is optional by
 * design: without it the set still plays, just with a single tempo and no
 * chart, exactly as a hand-made folder would.
 */

export const MANIFEST_NAME = 'set.json';

export interface PreparedSongInfo {
  /** The song's folder name, relative to the set. */
  folder: string;
  title: string;
  /**
   * Seconds from the start of each file to the downbeat of bar 1.
   *
   * MP3 decodes back with a lead-in the encoder added, and browsers don't all
   * trim it — so every part starts fractionally late. They all start equally
   * late, so they stay locked to one another; this is what keeps the whole song
   * honest against its bars.
   */
  firstBarOffsetSec: number;
  originalKey?: string;
  tempoMap?: TempoPoint[];
  markers?: { bar: number; name: string }[];
  chords?: TimedText[];
  /**
   * The set's `+LYRICS` tracks, kept apart the way AbleSet writes them — lead
   * lyrics, chords, backing-vocal cues, a note to the drummer. Merged into one
   * they would be unreadable, and which of them is worth looking at depends on
   * who is holding the phone.
   */
  lanes?: ChartLane[];
  /**
   * Patch changes for the rig, exactly as the set carried them. Their ids are
   * derived from the set, so a re-publish replaces each clip with itself
   * rather than with an identical stranger every device then argues about.
   */
  patchClips?: PatchClip[];
}

export interface PreparedManifest {
  preparedBy: 'rehearsaltool';
  preparedAt: string;
  /** The set this came from, for when someone wonders where it went. */
  /** The .als it came from — absent when written by hand or from the editor. */
  fromSet?: string;
  paddingSec: number;
  songs: PreparedSongInfo[];
}

export function isManifestName(fileName: string): boolean {
  return fileName.toLowerCase() === MANIFEST_NAME;
}

/** The set folder a manifest sits in. */
export function setFolderOf(manifestPath: string): string {
  const cut = manifestPath.lastIndexOf('/');
  return cut > 0 ? manifestPath.slice(0, cut) : '';
}

function looksLikeManifest(value: unknown): value is PreparedManifest {
  const m = value as PreparedManifest | null;
  return !!m && m.preparedBy === 'rehearsaltool' && Array.isArray(m.songs);
}

/**
 * Say what is wrong with a manifest, instead of silently ignoring it.
 *
 * A set.json is Prepare's output, but it is also a file a person can write by
 * hand beside a folder of audio — that is the point of it being an ordinary
 * file. Hand-written files come with hand-written mistakes, and the old
 * behaviour was to shrug and apply nothing, which reads as "the app is
 * broken" rather than "bar wants a number".
 *
 * Tolerant of fields it doesn't know — later versions may add some — and
 * strict about the types of the ones it does.
 */
export function validateManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const m = raw as Partial<PreparedManifest> | null;
  if (!m || typeof m !== 'object') return { ok: false, errors: ['not a JSON object'] };
  if (m.preparedBy !== 'rehearsaltool') {
    errors.push(`"preparedBy" must be exactly "rehearsaltool" — it is how the scan knows this file is meant for it`);
  }
  if (!Array.isArray(m.songs)) {
    errors.push('"songs" must be a list');
    return { ok: false, errors };
  }
  m.songs.forEach((song, i) => {
    const at = `songs[${i}]`;
    const bad = (msg: string) => errors.push(`${at}: ${msg}`);
    if (!song || typeof song !== 'object') return bad('not an object');
    if (typeof song.folder !== 'string' || !song.folder) bad('"folder" must name the song\'s folder');
    if (song.title !== undefined && typeof song.title !== 'string') bad('"title" must be text');
    if (song.firstBarOffsetSec !== undefined && typeof song.firstBarOffsetSec !== 'number') {
      bad('"firstBarOffsetSec" must be a number of seconds');
    }
    if (song.originalKey !== undefined && typeof song.originalKey !== 'string') bad('"originalKey" must be text');
    for (const [field, wantBar] of [['tempoMap', 'bpm'], ['chords', 'text']] as const) {
      const list = song[field] as unknown;
      if (list === undefined) continue;
      if (!Array.isArray(list)) { bad(`"${field}" must be a list`); continue; }
      (list as Record<string, unknown>[]).forEach((item, j) => {
        if (!item || typeof item.bar !== 'number') bad(`"${field}"[${j}] needs a numeric "bar"`);
        else if (typeof item[wantBar] !== (wantBar === 'bpm' ? 'number' : 'string')) {
          bad(`"${field}"[${j}] needs ${wantBar === 'bpm' ? 'a numeric "bpm"' : 'a "text" string'}`);
        }
      });
    }
    if (song.markers !== undefined) {
      if (!Array.isArray(song.markers)) bad('"markers" must be a list');
      else song.markers.forEach((mk, j) => {
        if (!mk || typeof mk.bar !== 'number' || typeof mk.name !== 'string') {
          bad(`"markers"[${j}] needs a numeric "bar" and a "name"`);
        }
      });
    }
    if (song.lanes !== undefined && !Array.isArray(song.lanes)) bad('"lanes" must be a list');
    if (song.patchClips !== undefined && !Array.isArray(song.patchClips)) bad('"patchClips" must be a list');
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Put a manifest's facts back onto the songs the scan found.
 *
 * Matched by folder, since that is what the manifest names and what the scan
 * groups by. A song the manifest doesn't mention is left exactly as scanned —
 * files added to a prepared set by hand keep working.
 */
/**
 * A manifest from library songs — the inverse of applyManifest.
 *
 * This is how edits made in the studio survive outside the library file: the
 * same set.json a person could write by hand, written by the machine instead,
 * beside the audio it describes. Songs already in `previous` that aren't
 * being rewritten keep their entries, so one song's edit doesn't erase the
 * others'.
 */
export function manifestFromSongs(
  songs: Song[],
  setFolder: string,
  previous?: PreparedManifest | null,
): PreparedManifest {
  const prefix = setFolder ? `${setFolder.toLowerCase()}/` : '';
  const entries = songs
    .filter((song) => song.folderPath.toLowerCase().startsWith(prefix))
    .map((song) => {
      const info: PreparedSongInfo = {
        folder: song.folderPath.slice(prefix.length),
        title: song.title,
        firstBarOffsetSec: song.firstBarOffsetSec ?? 0,
      };
      if (song.originalKey) info.originalKey = song.originalKey;
      if (song.tempoMap?.length) info.tempoMap = song.tempoMap;
      if (song.markers?.length) info.markers = song.markers.map((m) => ({ bar: m.bar, name: m.name }));
      if (song.chords?.length) info.chords = song.chords;
      if (song.lyrics?.length || song.lanes?.length) {
        info.lanes = song.lanes?.length
          ? song.lanes
          : [{ id: 'lead', name: 'Lead', kind: 'lyrics', items: song.lyrics! }];
      }
      if (song.patchClips?.length) info.patchClips = song.patchClips;
      return info;
    });

  const mine = new Set(entries.map((e) => e.folder.toLowerCase()));
  const kept = (previous?.songs ?? []).filter((e) => !mine.has(e.folder.toLowerCase()));
  return {
    preparedBy: 'rehearsaltool',
    preparedAt: new Date().toISOString(),
    paddingSec: previous?.paddingSec ?? 0,
    songs: [...kept, ...entries],
  };
}

export function applyManifest(
  songs: Song[],
  manifestPath: string,
  raw: unknown,
): { applied: number; errors?: string[] } {
  if (!looksLikeManifest(raw)) {
    // Not even shaped like ours — but if somebody clearly *tried*, say why.
    const verdict = validateManifest(raw);
    return { applied: 0, errors: verdict.errors.length ? verdict.errors : undefined };
  }
  const verdict = validateManifest(raw);
  if (!verdict.ok) return { applied: 0, errors: verdict.errors };
  const setFolder = setFolderOf(manifestPath).toLowerCase();

  const byFolder = new Map<string, PreparedSongInfo>();
  for (const info of raw.songs) {
    byFolder.set(`${setFolder}/${info.folder}`.toLowerCase(), info);
  }

  let applied = 0;
  for (const song of songs) {
    const info = byFolder.get(song.folderPath.toLowerCase());
    if (!info) continue;
    applied++;

    song.firstBarOffsetSec = info.firstBarOffsetSec ?? song.firstBarOffsetSec;
    if (info.originalKey) song.originalKey = info.originalKey;
    if (info.tempoMap?.length) song.tempoMap = info.tempoMap;
    if (info.chords?.length) song.chords = info.chords;
    if (info.lanes?.length) song.lanes = info.lanes;
    // Set-wins-else-keep, the same bargain the direct importer strikes: a
    // manifest with none must not wipe what was programmed in the app.
    if (info.patchClips?.length) song.patchClips = info.patchClips;
    if (info.markers?.length) song.markers = markersFrom(info.markers, song.markers);
    song.tempoUnset = false;
  }
  return { applied };
}

/**
 * Sections become markers, keeping any id they already had so the library file
 * doesn't churn on every scan.
 */
function markersFrom(
  sections: { bar: number; name: string }[],
  existing: Marker[],
): Marker[] {
  const old = new Map(existing.map((m) => [`${m.bar}:${m.name}`, m]));
  return sections.map((s, i) => {
    const key = `${s.bar}:${s.name}`;
    return old.get(key) ?? { id: `p_${i}_${s.bar}`, name: s.name, bar: s.bar };
  });
}

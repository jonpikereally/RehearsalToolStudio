import type { AlsProject, AlsSong } from './alsParser';
import type { FileEntry } from './files';
import type {
  ChartLane, Marker, PatchClip, Setlist, Song, TimedText, Variant, VariantRole,
} from '../types';
import { isAudio, parseFileName, parseNameMeta } from './scan.ts';
import { canonicalAlsPath, parseRigLocator } from './alsPatch.ts';
import { deriveChordLanes } from './nashville.ts';

/**
 * Turning a parsed Ableton set into library songs.
 *
 * The set knows more than the files ever could: where each song starts, which
 * audio belongs to it, its sections and chords, and where the tempo changes.
 * So a set takes precedence over the folder scan for any file it references —
 * otherwise the stems would be found twice, once by each route.
 */

/** Where a set's file references are rooted: the folder holding the `.als`. */
function projectFolder(alsPath: string): string {
  const i = alsPath.lastIndexOf('/');
  return i <= 0 ? '' : alsPath.slice(0, i);
}

/** A set's own name, used to group its songs in the list. */
export function setName(alsPath: string): string {
  const folder = projectFolder(canonicalAlsPath(alsPath));
  const name = folder.slice(folder.lastIndexOf('/') + 1);
  return name.replace(/\s+Project$/i, '').trim() || 'Ableton set';
}

/** Resolve a path stored in the set against the folder the set lives in. */
export function resolveStemPath(alsPath: string, stemPath: string): string {
  if (stemPath.startsWith('/')) return stemPath;
  return `${projectFolder(alsPath)}/${stemPath}`;
}

/**
 * Tidy an Ableton track name for display.
 *
 * Live numbers duplicated tracks — "Bass 1", "Lead Vox 1" — which carries no
 * meaning here, where there is only ever one of each per song.
 */
export function stemLabel(trackName: string): string {
  return trackName.replace(/\s+\d+$/, '').trim() || trackName;
}

export function songIdFor(alsPath: string, title: string): string {
  return `als:${canonicalAlsPath(alsPath).toLowerCase()}::${title.toLowerCase()}`;
}

/** The id of the setlist a set stands for. No `::`, so it can't be a song's. */
export function setlistIdFor(alsPath: string): string {
  return `als:${canonicalAlsPath(alsPath).toLowerCase()}`;
}

export function isFromSet(setlistId: string): boolean {
  return setlistId.startsWith('als:');
}

/**
 * The set as a setlist: its songs, in the order the arrangement plays them.
 *
 * A set already *is* a running order — that's what the locators along the
 * timeline are — so the same information was sitting in the library as an
 * unordered heap of songs and nowhere as the order you actually play. Songs
 * arrive here in arrangement order, which is the whole point of doing this
 * from the set rather than from the folder.
 */
/**
 * The set as a setlist: its songs, in the order the arrangement plays them.
 *
 * A set already *is* a running order — that's what the locators along the
 * timeline are — so the same information was sitting in the library as an
 * unordered heap of songs and nowhere as the order you actually play.
 *
 * Built from the set rather than from what a scan imported: a song only
 * imports when its audio can be found, and tying the order to that meant a set
 * whose stems weren't reachable that day gave no setlist at all, though the app
 * already knew every song in it. Each song is kept if the library has it —
 * however it got there.
 */
export function setlistFromProject(
  alsPath: string,
  project: AlsProject,
  known: (songId: string) => boolean,
): Setlist {
  return {
    id: setlistIdFor(alsPath),
    name: setName(alsPath),
    songIds: project.songs.map((s) => songIdFor(alsPath, s.title)).filter(known),
    updatedAt: Date.now(),
  };
}

/**
 * Every track inside a song's group is a part of that song, so the default is
 * "stem" — the opposite of the file-name convention, where an unrecognised
 * label is more likely to be a complete mix. Only a reference or full mix
 * track is exclusive.
 */
export function roleForTrack(label: string): VariantRole {
  return /\b(ref|reference|master|full|mix)\b/i.test(label) ? 'mix' : 'stem';
}

export interface AlsImportResult {
  songs: Song[];
  /** Audio paths the set accounts for, so the folder scan can skip them. */
  claimedPaths: Set<string>;
  /** Songs in the set whose audio isn't present. */
  missing: string[];
}

/**
 * Build songs from a set.
 *
 * `available` is the scanned file listing; a song is only created when at
 * least one of its files is actually there, so a set describing material that
 * hasn't been synced doesn't fill the library with songs that can't play.
 */
export function songsFromProject(
  project: AlsProject,
  alsPath: string,
  available: FileEntry[],
  existing: Map<string, Song>,
): AlsImportResult {
  const byPath = new Map(available.map((f) => [f.path.toLowerCase(), f]));
  const claimedPaths = new Set<string>();
  const missing: string[] = [];
  const songs: Song[] = [];
  const artist = setName(alsPath);

  for (const alsSong of project.songs) {
    const variants: Variant[] = [];

    for (const stem of alsSong.stems) {
      const full = resolveStemPath(alsPath, stem.path);
      const file = byPath.get(full.toLowerCase());
      if (!file) continue;

      claimedPaths.add(file.path.toLowerCase());
      const label = stemLabel(stem.name);
      variants.push({
        id: file.path.toLowerCase(),
        name: label,
        role: roleForTrack(label),
        path: file.path,
        rev: file.rev,
        sizeBytes: file.size,
        order: variants.length,
        // The arrangement, not the file, decides where a part sounds.
        regions: stem.regions ?? undefined,
      });
    }

    /*
     * Anything else in those folders named after this song.
     *
     * A print made here lands beside the stems, inside a folder the set owns —
     * which the folder scan skips wholesale, and which Ableton knows nothing
     * about, so it would otherwise fall between the two and never appear. Match
     * it by name the same way a plain folder of files is matched.
     */
    for (const file of extrasFor(alsSong.title, variants, available, claimedPaths)) {
      const { label, role } = parseFileName(stripExtension(file.name));
      variants.push({
        id: `${file.path}#${file.rev}`,
        name: label,
        path: file.path,
        rev: file.rev,
        role,
        sizeBytes: file.size,
        order: variants.length,
      });
      claimedPaths.add(file.path);
    }

    if (!variants.length) {
      missing.push(alsSong.title);
      continue;
    }

    const id = songIdFor(alsPath, alsSong.title);
    const prev = existing.get(id);

    songs.push({
      ...prev,
      id,
      title: alsSong.title,
      folderPath: projectFolder(alsPath),
      setPath: alsPath,
      project: prev?.project ?? 'Unfiled',
      artist: prev?.artist ?? artist,

      // The set is the authority on timing, so these are refreshed each scan
      // rather than preserved — editing them in Ableton is the way to change them.
      bpm: alsSong.bpm ?? prev?.bpm ?? project.tempo,
      tempoUnset: false,
      tempoMap: alsSong.tempoChanges.length ? alsSong.tempoChanges : undefined,
      timeSigNum: project.timeSigNum,
      timeSigDen: project.timeSigDen,
      firstBarOffsetSec: prev?.firstBarOffsetSec ?? 0,
      originalKey: alsSong.key ?? prev?.originalKey,
      transpose: prev?.transpose ?? 0,

      markers: markersFrom(alsSong, prev?.markers),
      /*
       * The set wins when it carries any, since editing it there is the point
       * of writing them there. When it carries none the library's are kept —
       * otherwise a scan of a set nobody has written to yet would wipe changes
       * programmed in the app.
       */
      patchClips: alsSong.rigMarks?.length
        ? clipsFromMarks(alsSong.rigMarks, id)
        : prev?.patchClips,
      lyrics: alsSong.lyrics.length ? alsSong.lyrics.map(toTimedText) : undefined,
      chords: alsSong.chords.length ? alsSong.chords.map(toTimedText) : undefined,
      lanes: laneList(alsSong),
      variants,
      notes: prev?.notes,
      updatedAt: Date.now(),
    });
  }

  return { songs, claimedPaths, missing };
}

/**
 * A file's song title, with every tag taken off.
 *
 * parseNameMeta only lifts the `{curly}` block, leaving the version and stem
 * brackets in place, so those come off here — otherwise a print called
 * "Fix You (no vocal …)" never matches the song "Fix You".
 */
function baseTitleOf(fileName: string): string {
  const withoutTags = stripExtension(fileName).replace(/\s*[[({][^\])}]*[\])}]\s*/g, ' ');
  return parseNameMeta(withoutTags).title.trim().toLowerCase();
}

const stripExtension = (name: string): string => {
  const cut = name.lastIndexOf('.');
  return cut > 0 ? name.slice(0, cut) : name;
};

/**
 * Files sitting with a song's audio that Ableton never mentions — prints made
 * here, or anything dropped in by hand — matched to the song by name.
 *
 * Only the folders this song's own audio lives in are searched, so a print for
 * one song can't attach itself to another that happens to share a word.
 */
function extrasFor(
  title: string,
  variants: Variant[],
  files: FileEntry[],
  claimed: Set<string>,
): FileEntry[] {
  const folders = new Set(
    variants.map((v) => v.path.slice(0, v.path.lastIndexOf('/')).toLowerCase()),
  );
  if (!folders.size) return [];
  const wanted = title.trim().toLowerCase();

  return files.filter((file) => {
    if (claimed.has(file.path)) return false;
    if (!isAudio(file.name)) return false;
    const folder = file.path.slice(0, file.path.lastIndexOf('/')).toLowerCase();
    if (!folders.has(folder)) return false;
    // The name with its tags stripped has to be this song, not merely near it.
    return baseTitleOf(file.name) === wanted;
  });
}

const toTimedText = (e: { bar: number; text: string }): TimedText => ({ bar: e.bar, text: e.text });

/**
 * Sections become markers, keeping their ids across scans so they don't churn
 * in the library file every time a set is re-read.
 */
/**
 * Only lanes that actually carry something for this song.
 *
 * Shared with Prepare: a set's text tracks should reach a prepared folder the
 * same way they reach a set read straight off the disk.
 */
export function laneList(song: AlsSong): ChartLane[] | undefined {
  const lanes = (song.lanes ?? [])
    .filter((lane) => lane.items.length)
    .map((lane) => ({ ...lane, items: lane.items.map(toTimedText) }));
  // Whichever language the chart was written in, both readings go through.
  const all = deriveChordLanes(lanes, song.key);
  return all.length ? all : undefined;
}

function markersFrom(song: AlsSong, previous: Marker[] | undefined): Marker[] {
  const old = new Map((previous ?? []).map((m) => [`${m.bar}:${m.name}`, m]));
  return song.sections.map((section) => {
    const key = `${section.bar}:${section.text}`;
    return (
      old.get(key) ?? {
        id: `als_${Math.round(section.bar * 1000)}_${section.text.replace(/\W+/g, '').slice(0, 12)}`,
        name: section.text,
        bar: section.bar,
      }
    );
  });
}

/**
 * Locator names back into clips.
 *
 * Ids are made from the set rather than at random, so a rescan doesn't replace
 * every clip with an identical one under a new name — which would look like no
 * change at all, and be a fresh conflict on every device each time.
 */
export function clipsFromMarks(marks: { bar: number; name: string }[], songId: string): PatchClip[] {
  return marks
    .map((mark, i) => {
      const parsed = parseRigLocator(mark.name);
      return parsed ? { id: `als:${songId}:${i}`, bar: Math.round(mark.bar), ...parsed } : null;
    })
    .filter((c): c is PatchClip => !!c);
}

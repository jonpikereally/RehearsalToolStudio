import type { AlsClip, AlsProject, AlsSong } from './alsParser';
import type { FileEntry } from './files';
import type {
  Device,
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
  const raw = stemPath.startsWith('/') ? stemPath : `${projectFolder(alsPath)}/${stemPath}`;
  // Live writes stems outside the project as `../../Stems/x.wav`; a path with
  // the dots still in it matches nothing, so they are folded away here.
  const out: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * Where a stem is when it is not where the set says.
 *
 * A set moved to another machine, or copied out of the folder it was made
 * in, still names its stems by the path they had there. Live finds them
 * again by searching; this does the same, within the folder: first a file
 * under the same-named parent folder, then any file of that name so long as
 * there is only one.
 */
function findByName(stemPath: string, available: FileEntry[]): FileEntry | undefined {
  const parts = stemPath.split('/').filter(Boolean);
  const name = parts.pop()?.toLowerCase();
  if (!name) return undefined;
  const parent = parts.pop()?.toLowerCase();
  const sameName = available.filter((f) => f.name.toLowerCase() === name);
  if (parent) {
    const under = sameName.filter((f) => f.path.toLowerCase().endsWith(`/${parent}/${name}`));
    if (under.length === 1) return under[0];
  }
  return sameName.length === 1 ? sameName[0] : undefined;
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
 * label is more likely to be a complete mix. Only the reference *song* is
 * exclusive: "REF SONG", "Ref Master", "Full Mix", a bare "Reference". A REF
 * folder also holds the record's own parts — "REF DRUMS", "REF VOX", "REF
 * LV" — and those are parts to blend in like any other, not a mix to switch
 * to; naming a part after the word is what makes them so.
 */
export function roleForTrack(label: string): VariantRole {
  const l = label.trim().toLowerCase();
  if (!/\b(ref|reference|master|full|mix)\b/.test(l)) return 'stem';
  // What is left once the reference words are gone: nothing, or a whole-song
  // word, means the song itself; anything else names a part of it.
  const rest = l
    .replace(/\b(ref|reference|master|full|mix|song|track|main|record|original)\b/g, ' ')
    .replace(/[\d\s._-]+/g, ' ')
    .trim();
  return rest ? 'stem' : 'mix';
}

/**
 * Where a part's file lands, from its first clip that sounds. A clip on bar 1
 * playing the file from its start is the ordinary case and says nothing.
 */
export function placementOf(clips: AlsClip[] | undefined): Variant['placement'] {
  const clip = clips?.find((c) => !c.disabled) ?? clips?.[0];
  if (!clip) return undefined;
  if (Math.abs(clip.startBar - 1) < 1e-6 && Math.abs(clip.sourceStartSec) < 1e-6) return undefined;
  return { bar: clip.startBar, sourceSec: clip.sourceStartSec };
}

/**
 * The part's fader and pan as the set has them: the track's own times its
 * groups', and for a part that is one clip, that clip's gain folded in.
 * Left out at unity and centre, which is what most stems are.
 */
export function mixOf(
  stem: { gain?: number; pan?: number },
  clips: AlsClip[] | undefined,
): Pick<Variant, 'gain' | 'pan'> {
  const clip = clips?.find((c) => !c.disabled) ?? clips?.[0];
  const gain = (stem.gain ?? 1) * (clip?.gain ?? 1);
  const out: Pick<Variant, 'gain' | 'pan'> = {};
  if (Math.abs(gain - 1) > 1e-4) out.gain = gain;
  if (stem.pan && Math.abs(stem.pan) > 1e-4) out.pan = stem.pan;
  return out;
}

/**
 * The devices the part runs through on its own track and groups. Where it
 * is sent after that — a return bus with the venue's EQ and compression
 * on it — is output processing rather than the song, and is left alone.
 */
export function routeOf(stem: { devices?: Device[] }): Pick<Variant, 'devices'> {
  return stem.devices?.some((d) => d.on) ? { devices: stem.devices } : {};
}

/** A single-clip part's own transposition and warp speed, when it has any. */
export function ownShift(clips: AlsClip[] | undefined): Pick<Variant, 'pitch' | 'speed'> {
  const clip = clips?.find((c) => !c.disabled) ?? clips?.[0];
  const out: Pick<Variant, 'pitch' | 'speed'> = {};
  if (clip?.semitones) out.pitch = clip.semitones;
  if (clip?.speed && Math.abs(clip.speed - 1) > 1e-6) out.speed = clip.speed;
  return out;
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
      const file = byPath.get(full.toLowerCase()) ?? findByName(stem.path, available);
      if (!file) continue;

      /*
       * A track playing more than one clip — another file dropped in, the
       * same file picked up again elsewhere — is an arrangement, and the
       * part carries every clip whose file is here so the player can lay
       * it out. One clip is the ordinary part: the file, placed once.
       */
      const live = (stem.clips ?? []).filter((c) => !c.disabled);
      const arranged = live.length > 1
        ? live
            .map((clip) => ({
              clip,
              file: byPath.get(resolveStemPath(alsPath, clip.path).toLowerCase()) ?? findByName(clip.path, available),
            }))
            .filter((x): x is { clip: AlsClip; file: FileEntry } => !!x.file)
        : [];
      for (const { file: f } of arranged) claimedPaths.add(f.path.toLowerCase());

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
        // The arrangement, not the file, decides where a part sounds — and
        // where its file begins.
        regions: stem.regions ?? undefined,
        placement: arranged.length > 1 ? undefined : placementOf(stem.clips),
        ...(arranged.length > 1 ? {} : ownShift(stem.clips)),
        ...mixOf(stem, arranged.length > 1 ? undefined : stem.clips),
        ...routeOf(stem),
        clips:
          arranged.length > 1
            ? arranged.map(({ clip, file: f }) => ({
                path: f.path,
                startBar: clip.startBar,
                endBar: clip.endBar,
                sourceStartSec: clip.sourceStartSec,
                fadeInSec: clip.fadeInSec,
                fadeOutSec: clip.fadeOutSec,
                semitones: clip.semitones ?? 0,
                speed: clip.speed ?? 1,
                gain: clip.gain ?? 1,
              }))
            : undefined,
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

    /*
     * A song whose audio is not here is still a song in the set: it keeps
     * its place in the running order, its tempo, key and sections, and says
     * plainly that its files are elsewhere. Reported, so the scan can say
     * how many — but never dropped.
     */
    if (!variants.length) missing.push(alsSong.title);

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
      // The tempo Live actually plays the song at is the automation's, where
      // there is any; a locator's "136BPM" is a label, and the set tempo is
      // only what is left when nothing else says.
      bpm: alsSong.startBpm ?? alsSong.bpm ?? prev?.bpm ?? project.tempo,
      tempoUnset: false,
      tempoMap: alsSong.tempoChanges.length ? alsSong.tempoChanges : undefined,
      timeSigNum: alsSong.timeSigNum ?? project.timeSigNum,
      timeSigDen: alsSong.timeSigDen ?? project.timeSigDen,
      caveats: alsSong.caveats?.length ? alsSong.caveats : undefined,
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
      rig: alsSong.rigTracks?.length
        ? alsSong.rigTracks.map((t) => ({
            name: t.name,
            kind: t.kind,
            clips: t.clips.map((c) => ({ name: c.name, bar: c.startBar, endBar: c.endBar })),
          }))
        : undefined,
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

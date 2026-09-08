import type { AlsProject } from './alsParser';
import { audioKeyFor, audioStanding, type AudioStanding } from './audioKey';
import { resolveStemPath } from './alsImport';
import { holdAwake } from './keepAwake';
import * as local from './localSource';
import { DEFAULT_BITRATE } from './mp3';
import { getShiftedBuffer, primeShiftedRender, shiftLanes } from './pitchService';
import { folderOrder, prepareSet, songFolderBase, type PrepareProgress, type PrepareResult } from './prepare';
import { markPrepareRunning } from './prepareState';
import { MANIFEST_NAME, folderBaseOf, sameSong, type PreparedManifest, type PreparedPart } from './preparedSet';
import { SETS_FOLDER } from './prints';
import { publishLibrary, type PublishResult } from './publish';
import { clearDecodedCache, releaseReady } from './songLoader';
import { absolutePath, readBytes, statFile } from './source';
import { updatePrepared, wordsChanged } from './updatePrepared';
import { readMembers, spareSubmixes, submixState, type MemberMix } from './members.ts';

/**
 * A prepare, from the set as it stands to the band's folder — the run itself,
 * apart from any dialog.
 *
 * The dialog used to hold all of this between its buttons. Now the set is
 * also prepared again on its own whenever Live saves it, with nobody at a
 * dialog, so what a run is lives here and both call it: work out where each
 * song stands against the last prepare, write the ones that changed, refresh
 * the words of the ones that didn't, and publish the library.
 */

/** Every song's audio key as it stands now, by title and by folder name. */
export interface AudioKeys {
  byTitle: Record<string, string>;
  /** Keyed by song name — the folder's title part, lower-cased — as manifests are matched. */
  byName: Record<string, string>;
}

/**
 * The keys themselves: the set, a stat per file, and nothing read. Asked
 * for before a folder is even chosen, since the keys are also how a set's
 * folder is recognised among the band's when its name has changed.
 */
export async function audioKeysFor(project: AlsProject, setPath: string): Promise<AudioKeys> {
  const revs = new Map<string, string | null>();
  const paths = new Set<string>();
  for (const song of project.songs) for (const stem of song.stems) for (const clip of stem.clips) {
    if (!clip.disabled) paths.add(resolveStemPath(setPath, clip.path));
  }
  // A stat apiece, a dozen at a time; a missing file is a fact, not a failure.
  const list = [...paths];
  for (let i = 0; i < list.length; i += 12) {
    await Promise.all(
      list.slice(i, i + 12).map(async (path) => {
        try {
          const st = await statFile(path);
          revs.set(path.toLowerCase(), `${st.modified}-${st.size}`);
        } catch {
          revs.set(path.toLowerCase(), null);
        }
      }),
    );
  }
  const inputs = {
    fileRev: (path: string) => revs.get(resolveStemPath(setPath, path).toLowerCase()) ?? null,
    bitrate: DEFAULT_BITRATE,
    sampleRate: 48000,
  };
  const byTitle: Record<string, string> = {};
  const byName: Record<string, string> = {};
  for (const song of project.songs) {
    if (byTitle[song.title]) continue;
    const key = audioKeyFor(song, project, inputs);
    byTitle[song.title] = key;
    byName[songFolderBase(song).toLowerCase()] = key;
  }
  return { byTitle, byName };
}

/** The band as the folder has them; an unreadable list is no members at all. */
export async function bandMembers(band: local.FolderHandle): Promise<MemberMix[]> {
  return readMembers(band).catch(() => []);
}

/**
 * Take away the submixes a song holds that nobody's list asks for now.
 *
 * Not moved aside like a song folder: a submix is a sum of files that are all
 * still in the folder, so nothing is lost with it, and a folder that keeps
 * every list anybody ever had is one the band downloads twice over.
 */
async function clearSpareSubmixes(
  band: local.FolderHandle,
  setFolder: string,
  titles: string[],
  members: MemberMix[],
): Promise<void> {
  let manifest: PreparedManifest | null = null;
  try {
    const { bytes } = await local.readBytes(band, '', `${setFolder}/${MANIFEST_NAME}`);
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifest;
  } catch {
    return; // nothing prepared here to clear
  }
  const wanted = new Set(titles.map((t) => t.toLowerCase()));
  for (const entry of manifest.songs) {
    if (!entry.parts?.length || !wanted.has((entry.title ?? '').toLowerCase())) continue;
    const spare = new Set(spareSubmixes(entry.parts, members));
    for (const part of entry.parts) {
      if (!part.file || !spare.has(part.name)) continue;
      await local.removeSubmix(band, '', `${setFolder}/${entry.folder}/${part.file}`).catch(() => undefined);
    }
  }
}

/** Who is missing a submix in this song, or what is there for nobody: else null. */
function submixesFor(parts: PreparedPart[], members: MemberMix[]): string | null {
  const missing = members.filter((m) => submixState(parts, m) === 'missing').map((m) => m.member);
  const spare = spareSubmixes(parts, members);
  if (!missing.length && !spare.length) return null;
  return [
    missing.length ? `nothing yet for ${missing.join(', ')}` : '',
    spare.length ? `${spare.length} nobody needs now` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export interface Standing {
  /** Where each song's audio stands against the manifest, by title. */
  standing: Map<string, AudioStanding>;
  /**
   * Why each song's submixes are behind the band, by title, or null when they
   * are not. Separate work from the audio: a member added leaves every stem
   * exactly right and every submix of theirs unwritten.
   */
  submixes: Map<string, string | null>;
  /** Songs whose words, sections, chords, notes or key differ from their entry, by title. */
  words: Set<string>;
  /** Each song's audio key as it is now, by title, for the manifest. */
  keys: Record<string, string>;
  lastPrepared: string | null;
  /** What was already prepared under this name; null when nothing was. */
  manifest: PreparedManifest | null;
}

/** Titles in set order, one each: a count-in locator repeats its song's. */
export function titlesOf(project: AlsProject): string[] {
  const titles: string[] = [];
  for (const song of project.songs) {
    if (titles[titles.length - 1] !== song.title) titles.push(song.title);
  }
  return titles;
}

/**
 * What has changed since the last prepare into this folder.
 *
 * Each song's audio is keyed from the set and the files' revisions, and held
 * against the key its manifest entry carries. Nothing here reads a stem: it
 * is the set, a stat per file, and the manifest.
 */
export async function standingFor(
  project: AlsProject,
  setPath: string,
  band: local.FolderHandle,
  folderName: string,
  known?: AudioKeys,
): Promise<Standing> {
  let manifest: PreparedManifest | null = null;
  try {
    const { bytes } = await local.readBytes(band, '', `${SETS_FOLDER}/${folderName}/${MANIFEST_NAME}`);
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifest;
  } catch {
    manifest = null; // never prepared under this name: every song is new
  }
  const keys = known ?? (await audioKeysFor(project, setPath));
  /*
   * The submixes are a separate question from the audio, and one the folder
   * can answer outright: the manifest says which submixes each song holds and
   * what went into them, so a member added — or one of them keeping something
   * different — makes the songs that lack their submix stale, and nothing
   * else. Read once for the whole set.
   */
  const members = (await bandMembers(band)).filter((m) => !m.off);
  const standing = new Map<string, AudioStanding>();
  const submixes = new Map<string, string | null>();
  const words = new Set<string>();
  for (const song of project.songs) {
    if (standing.has(song.title)) continue;
    const name = songFolderBase(song);
    const entry = manifest?.songs.find((e) => sameSong(e.folder, name));
    standing.set(song.title, audioStanding(keys.byTitle[song.title], entry?.audioKey, !!entry));
    // Whether the submixes match the band is its own question, and its own
    // work: the stems being right says nothing about them, or the other way.
    submixes.set(song.title, entry?.parts?.length ? submixesFor(entry.parts, members) : null);
    if (entry && wordsChanged(entry, song, project, setPath)) words.add(song.title);
  }
  return { standing, submixes, words, keys: keys.byTitle, lastPrepared: manifest?.preparedAt ?? null, manifest };
}

export interface RunOptions {
  project: AlsProject;
  setPath: string;
  /** The band's folder, already granted. */
  band: local.FolderHandle;
  /** The prepared set's folder name under Sets/. */
  folderName: string;
  /** Titles to write out again. Empty writes no audio: the rest is still refreshed. */
  selected: string[];
  /**
   * Titles whose submixes want writing, the stems being right already.
   *
   * Its own pass, after the audio: preparing the stems and preparing the
   * submixes are separate work, and a band that has changed does not make a
   * song's stems wrong. A song in both lists gets its submixes from the audio
   * pass and is not written twice.
   */
  submixes?: string[];
  standing: Map<string, AudioStanding> | null;
  /**
   * Songs whose words, sections, chords, notes or key differ from their
   * prepared entry. Given, only those among the unchanged songs are
   * refreshed — a section renamed in one song is one song's file, not
   * nineteen — unless the running order has moved, when every entry's
   * place in the manifest is rewritten anyway.
   */
  words?: Set<string>;
  keys: Record<string, string>;
  /** The running order by title; the arrangement's without. */
  songOrder?: string[];
  cacheBudgetGB: number;
  /**
   * Filled as the run moves song folders aside, one entry per song written,
   * for undoPrepare. The caller's own array, so a run that is stopped — and
   * throws — still leaves the list of what it touched.
   */
  aside?: local.Aside[];
  /** The band's submixes; read from the folder when not given. */
  members?: MemberMix[];
  signal?: AbortSignal;
  onProgress?: (p: PrepareProgress) => void;
}

export interface RunOutcome {
  /** What the prepare wrote; null when no song was chosen to write. */
  result: PrepareResult | null;
  /** What the submix pass wrote, when one ran. */
  submixes: PrepareResult | null;
  /** Words and sections refreshed for the unchanged songs left alone, and which. */
  refreshed: { count: number; songs: string[]; error?: string } | null;
  published: PublishResult;
}

/**
 * Prepare the chosen songs into the band's folder, refresh the rest, and
 * hand the result to the band.
 *
 * Everything is written into the band's folder rather than beside the set it
 * came from: that folder is a different Dropbox app folder and the only one
 * they can read. The library goes with it, because a folder of files with no
 * library is a folder the band's app can make nothing of.
 */
export async function runPrepare(o: RunOptions): Promise<RunOutcome> {
  const { project, setPath, band, folderName, standing, keys, songOrder, signal, onProgress } = o;
  markPrepareRunning(true);
  // Minutes of work nobody is touching is what a Mac calls idle; held awake,
  // or the display sleeps, the app naps and the run crawls.
  const releaseAwake = holdAwake('Preparing a set');
  try {
    /*
     * Let go of what is only being held for listening. The player keeps the
     * song it has open decoded, and a run keeps every song of it, while
     * preparing needs the machine's memory for source WAVs, a rendered part
     * and the encoder's copy of it.
     */
    releaseReady();
    clearDecodedCache();

    const titles = titlesOf(project);
    const selected = new Set(o.selected);
    const members = o.members ?? (await bandMembers(band));
    const setFolder = `${SETS_FOLDER}/${folderName}`;
    // Where the session is, for the manifest to remember; a lone set has no folder to say.
    const sessionPath = await absolutePath(setPath).catch(() => undefined);
    const writeFile = (path: string, data: Blob) => local.writeFile(band, '', path, data);

    let result: PrepareResult | null = null;
    if (selected.size) {
      // What is about to be written over is kept, so the run can be undone.
      const aside = o.aside;
      if (aside) await local.undoBegin(band, setFolder);
      const ctx = new AudioContext();
      try {
        result = await prepareSet({
          project,
          alsPath: setPath,
          only: [...selected],
          /*
           * What is already in that folder, so a run of one song leaves the
           * songs prepared before it describing themselves as they did.
           */
          readManifest: async () => {
            try {
              const { bytes: raw } = await local.readBytes(band, '', `${setFolder}/${MANIFEST_NAME}`);
              return JSON.parse(new TextDecoder().decode(raw)) as PreparedManifest;
            } catch {
              return null; // nothing prepared here yet, which is the usual case
            }
          },
          // The band's folder is its own root; nothing of the studio's path
          // structure comes with it.
          root: '',
          setName: folderName,
          // One submix per member per song, of everything they don't keep.
          members,
          resolvePath: (relative) => resolveStemPath(setPath, relative),
          readFile: async (path) => (await readBytes(path)).bytes,
          readSlice: async (path, start, end) => {
            const got = await readBytes(path, undefined, undefined, { start, end });
            return { bytes: got.bytes, size: got.size };
          },
          writeFile,
          // The song's folder as it was — and, when the day has moved its
          // name on, the older folder too — kept aside for undo.
          beforeSong: aside
            ? async (name, previous) => {
                if (previous) aside.push({ folder: previous, kept: await local.undoKeep(band, setFolder, previous) });
                aside.push({ folder: name, kept: await local.undoKeep(band, setFolder, name) });
              }
            : undefined,
          decode: (raw) => ctx.decodeAudioData(raw.slice(0)),
          // What everything is rendered at, so the lead-in is measured there too.
          sampleRate: ctx.sampleRate,
          // Cached under the file it came from: a key without it once served
          // one stem's render for every stem of the song.
          shift: ({ buffer, semitones, speed, source, prime, onProgress: onShift }) =>
            (prime ? primeShiftedRender : getShiftedBuffer)({
              ctx,
              path: source,
              rev: `prepare:${buffer.length}@${buffer.sampleRate}`,
              semitones,
              tempo: speed,
              source: buffer,
              budgetBytes: o.cacheBudgetGB * 1e9,
              onProgress: onShift,
              signal,
            }),
          parallelShifts: shiftLanes(),
          audioKeys: keys,
          songOrder,
          sessionPath,
          onProgress,
          signal,
        });
      } finally {
        void ctx.close();
      }
    }

    /*
     * Then the submixes of songs whose stems were already right. Written into
     * the folders as they stand — nothing is moved aside, since nothing of
     * theirs is being written over — and the entries keep everything the last
     * prepare said, their submix parts swapped for these.
     */
    const wantSubmixes = (o.submixes ?? []).filter((title) => !selected.has(title));
    let submixResult: PrepareResult | null = null;
    if (wantSubmixes.length) {
      // A submix nobody's list asks for now is taken away rather than left to
      // be downloaded: everything in it is still there as its own part.
      await clearSpareSubmixes(band, setFolder, wantSubmixes, members);
      const ctx = new AudioContext();
      try {
        submixResult = await prepareSet({
          project,
          alsPath: setPath,
          only: wantSubmixes,
          submixesOnly: true,
          readManifest: async () => {
            try {
              const { bytes: raw } = await local.readBytes(band, '', `${setFolder}/${MANIFEST_NAME}`);
              return JSON.parse(new TextDecoder().decode(raw)) as PreparedManifest;
            } catch {
              return null;
            }
          },
          root: '',
          setName: folderName,
          members,
          resolvePath: (relative) => resolveStemPath(setPath, relative),
          readFile: async (path) => (await readBytes(path)).bytes,
          readSlice: async (path, start, end) => {
            const got = await readBytes(path, undefined, undefined, { start, end });
            return { bytes: got.bytes, size: got.size };
          },
          writeFile,
          decode: (raw) => ctx.decodeAudioData(raw.slice(0)),
          sampleRate: ctx.sampleRate,
          shift: ({ buffer, semitones, speed, source, prime, onProgress: onShift }) =>
            (prime ? primeShiftedRender : getShiftedBuffer)({
              ctx,
              path: source,
              rev: `prepare:${buffer.length}@${buffer.sampleRate}`,
              semitones,
              tempo: speed,
              source: buffer,
              budgetBytes: o.cacheBudgetGB * 1e9,
              onProgress: onShift,
              signal,
            }),
          parallelShifts: shiftLanes(),
          songOrder,
          sessionPath,
          onProgress,
          signal,
        });
      } finally {
        void ctx.close();
      }
    }

    /*
     * The songs left alone still get their words and sections: a lyric fixed
     * in the set lands everywhere, whether or not any audio moved. The cheap
     * path, over the manifest the run just wrote — or the one that was there.
     */
    const unchanged = titles.filter((t) => !selected.has(t) && standing?.get(t)?.state === 'unchanged');
    let refreshed: RunOutcome['refreshed'] = null;
    if (unchanged.length) {
      try {
        const { bytes: raw } = await local.readBytes(band, '', `${setFolder}/${MANIFEST_NAME}`);
        const manifest = JSON.parse(new TextDecoder().decode(raw)) as PreparedManifest;
        // Only the songs whose words moved — every song when the order did,
        // since each entry's place in the manifest is then a change.
        const orderNow = folderOrder(project, songOrder).map((n) => n.toLowerCase());
        const orderThen = manifest.songs.map((e) => folderBaseOf(e.folder).toLowerCase()).filter((n) => orderNow.includes(n));
        const orderMoved = orderThen.join('|') !== orderNow.filter((n) => orderThen.includes(n)).join('|');
        const untouched = o.words && !orderMoved ? unchanged.filter((t) => o.words!.has(t)) : unchanged;
        if (!untouched.length) {
          refreshed = { count: 0, songs: [] };
          throw Object.assign(new Error('nothing to refresh'), { name: 'NothingToRefresh' });
        }
        const under = `${setFolder.toLowerCase()}/`;
        const presentFolders = [
          ...new Set(
            (await local.listFiles(band, ''))
              .map((f) => f.path.replace(/^\/+/, ''))
              .filter((path) => path.toLowerCase().startsWith(under))
              .map((path) => path.slice(under.length).split('/')[0])
              .filter((name) => name && !name.includes('.')),
          ),
        ];
        const refresh = await updatePrepared({
          project,
          alsPath: setPath,
          setFolder,
          manifest,
          presentFolders,
          only: untouched,
          songOrder,
          sessionPath,
          writeFile,
          signal,
        });
        refreshed = { count: refresh.updated.length, songs: refresh.updated };
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        if ((err as { name?: string })?.name !== 'NothingToRefresh') {
          refreshed = { count: 0, songs: [], error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    const published = await publishLibrary(band);
    return { result, submixes: submixResult, refreshed, published };
  } finally {
    releaseAwake();
    markPrepareRunning(false);
  }
}

/**
 * Put a prepare's songs back as they were before it — a run stopped halfway,
 * or one that should not have happened — and republish the library so the
 * band sees the folder as it is again.
 */
export async function undoPrepare(
  band: local.FolderHandle,
  folderName: string,
  aside: local.Aside[],
): Promise<{ restored: number; removed: number; published: PublishResult }> {
  const put = await local.undoRestore(band, `${SETS_FOLDER}/${folderName}`, aside);
  const published = await publishLibrary(band);
  return { ...put, published };
}

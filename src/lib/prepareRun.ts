import type { AlsProject } from './alsParser';
import { audioKeyFor, audioStanding, type AudioStanding } from './audioKey';
import { resolveStemPath } from './alsImport';
import { holdAwake } from './keepAwake';
import * as local from './localSource';
import { DEFAULT_BITRATE } from './mp3';
import { getShiftedBuffer, primeShiftedRender, shiftLanes } from './pitchService';
import { prepareSet, songFolderName, type PrepareProgress, type PrepareResult } from './prepare';
import { markPrepareRunning } from './prepareState';
import { MANIFEST_NAME, type PreparedManifest } from './preparedSet';
import { SETS_FOLDER } from './prints';
import { publishLibrary, type PublishResult } from './publish';
import { clearDecodedCache, releaseReady } from './songLoader';
import { readBytes, statFile } from './source';
import { updatePrepared } from './updatePrepared';

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

export interface Standing {
  /** Where each song stands against the manifest, by title. */
  standing: Map<string, AudioStanding>;
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
): Promise<Standing> {
  let manifest: PreparedManifest | null = null;
  try {
    const { bytes } = await local.readBytes(band, '', `${SETS_FOLDER}/${folderName}/${MANIFEST_NAME}`);
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifest;
  } catch {
    manifest = null; // never prepared under this name: every song is new
  }
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
  const keys: Record<string, string> = {};
  const standing = new Map<string, AudioStanding>();
  for (const song of project.songs) {
    if (keys[song.title]) continue;
    const key = audioKeyFor(song, project, inputs);
    keys[song.title] = key;
    const folder = songFolderName(song, project).toLowerCase();
    const entry = manifest?.songs.find((e) => e.folder.toLowerCase() === folder);
    standing.set(song.title, audioStanding(key, entry?.audioKey, !!entry));
  }
  return { standing, keys, lastPrepared: manifest?.preparedAt ?? null, manifest };
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
  standing: Map<string, AudioStanding> | null;
  keys: Record<string, string>;
  /** The running order by title; the arrangement's without. */
  songOrder?: string[];
  cacheBudgetGB: number;
  signal?: AbortSignal;
  onProgress?: (p: PrepareProgress) => void;
}

export interface RunOutcome {
  /** What the prepare wrote; null when no song was chosen to write. */
  result: PrepareResult | null;
  /** Words and sections refreshed for the unchanged songs left alone. */
  refreshed: { count: number; error?: string } | null;
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
    const setFolder = `${SETS_FOLDER}/${folderName}`;
    const writeFile = (path: string, data: Blob) => local.writeFile(band, '', path, data);

    let result: PrepareResult | null = null;
    if (selected.size) {
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
          resolvePath: (relative) => resolveStemPath(setPath, relative),
          readFile: async (path) => (await readBytes(path)).bytes,
          readSlice: async (path, start, end) => {
            const got = await readBytes(path, undefined, undefined, { start, end });
            return { bytes: got.bytes, size: got.size };
          },
          writeFile,
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
    const untouched = titles.filter((t) => !selected.has(t) && standing?.get(t)?.state === 'unchanged');
    let refreshed: RunOutcome['refreshed'] = null;
    if (untouched.length) {
      try {
        const { bytes: raw } = await local.readBytes(band, '', `${setFolder}/${MANIFEST_NAME}`);
        const manifest = JSON.parse(new TextDecoder().decode(raw)) as PreparedManifest;
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
          writeFile,
          signal,
        });
        refreshed = { count: refresh.updated.length };
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        refreshed = { count: 0, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const published = await publishLibrary(band);
    return { result, refreshed, published };
  } finally {
    releaseAwake();
    markPrepareRunning(false);
  }
}

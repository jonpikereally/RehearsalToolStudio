import type { AlsProject, AlsSong } from './alsParser';
import { clipsFromMarks, clipsFromRig, laneList, songIdFor } from './alsImport.ts';
import { chordProFor } from './chordPro.ts';
import { folderOrder, lyricsFileFor, mergeSongs, songFolderBase, tempoOf } from './prepare.ts';
import { MANIFEST_NAME, SONG_FILE_NAME, folderBaseOf, sameSong, songFileFor, type PreparedManifest, type PreparedSongInfo } from './preparedSet.ts';
import { songLengthSec } from './infoTrack.ts';
import { parseNameMeta } from './scan.ts';

/**
 * Bringing a prepared set's words and structure up to date, without touching a
 * note of its audio.
 *
 * Almost everything the Studio publishes about a song is not the audio. The
 * sections, the chords, the lyric lanes, the key, the tempo map and the rig's
 * patch changes all live in `set.json` beside the parts, with the words also
 * written out as `.lrc` and `.cho`. Adding a section name or fixing a line
 * changes none of the MP3s — so re-encoding gigabytes of stems to publish a
 * spelling correction is work nobody should have to wait for.
 *
 * What this will *not* do is pretend when the audio has actually moved. The
 * song folder's name carries the tempo, the key and the time signature, so a
 * song whose folder no longer matches the set is a song whose parts are stale;
 * it is named and left alone rather than half-updated. The same goes for the
 * encoder's lead-in: `firstBarOffsetSec` describes files already on disk, so
 * it is carried over untouched and never measured again.
 */

/** What is safe to change here, and what is not. */
export const AUDIO_SAFE = [
  'sections and their names',
  'chords',
  'lyric lanes and their lines',
  'the key written in the locator',
  'patch changes for the rig',
] as const;

/** Where a prepared set was found, and what its manifest says. */
export interface PreparedSetAt {
  /** The set folder, relative to the band's folder. */
  folder: string;
  manifest: PreparedManifest;
}

/**
 * Which prepared set a `.als` belongs to.
 *
 * Not worked out from the name: a set folder is named for the day it was
 * prepared, so "today's name" is only right on the day, and updating a set
 * prepared last Tuesday would write a fresh folder with no audio in it. The
 * manifest records the set it came from, so that is what decides. Falling back
 * to the folder's name covers a set prepared before the manifest carried one.
 * Newest wins where several match, which is the one everyone is playing.
 */
/** How many of a manifest's songs are the set's own, by their audio keys as they stand. */
export function contentScore(manifest: PreparedManifest, keys: Record<string, string>): number {
  let score = 0;
  for (const entry of manifest.songs) {
    const now = keys[folderBaseOf(entry.folder).toLowerCase()];
    if (now && entry.audioKey === now) score++;
  }
  return score;
}

export function setFor(
  candidates: PreparedSetAt[],
  alsPath: string,
  /** The set's audio keys as they are now, by song folder name lower-cased. */
  keys?: Record<string, string>,
): PreparedSetAt | null {
  const key = (path: string) => path.replace(/^\/+/, '').toLowerCase();
  const newestFirst = [...candidates].sort((a, b) =>
    (b.manifest.preparedAt ?? '').localeCompare(a.manifest.preparedAt ?? ''),
  );

  const fromSet = newestFirst.filter((c) => c.manifest.fromSet && key(c.manifest.fromSet) === key(alsPath));
  if (fromSet.length) return fromSet[0];

  /*
   * By content next: the folder whose entries carry the most of the set's
   * audio keys as they stand. A set renamed on disk, or a folder renamed in
   * Dropbox, is still the same songs and the same files — and a folder that
   * merely shares the name, prepared from some other set, is not: the songs
   * in it would all be written again for nothing.
   */
  if (keys) {
    let best: { at: PreparedSetAt; score: number } | null = null;
    for (const c of newestFirst) {
      const score = contentScore(c.manifest, keys);
      if (score > 0 && (!best || score > best.score)) best = { at: c, score };
    }
    if (best) return best.at;
  }

  const base = alsPath.split('/').pop()?.replace(/\.als$/i, '') ?? '';
  if (!base) return null;
  const named = newestFirst.filter((c) => {
    const folder = c.folder.split('/').pop() ?? '';
    return folder.toLowerCase().startsWith(`${base.toLowerCase()} `) || folder.toLowerCase() === base.toLowerCase();
  });
  return named[0] ?? null;
}

export interface UpdateOptions {
  project: AlsProject;
  /** The `.als` this set came from, recorded in the manifest. */
  alsPath: string;
  /** The prepared set's folder, relative to the band's folder. */
  setFolder: string;
  /** The manifest already there. Its `paddingSec` is kept, never remeasured. */
  manifest: PreparedManifest;
  /** Song folder names actually present under `setFolder`, however they are cased. */
  presentFolders: string[];
  /** Titles to update; the whole set when absent. */
  only?: string[];
  /** The running order by title, as for prepareSet; the arrangement's without. */
  songOrder?: string[];
  writeFile: (path: string, data: Blob) => Promise<string>;
  onProgress?: (p: { title: string; index: number; count: number }) => void;
  signal?: AbortSignal;
}

export interface UpdateResult {
  folder: string;
  /** Songs whose entry, words or chart were rewritten. */
  updated: string[];
  lyricsWritten: number;
  chartsWritten: number;
  /** Songs left alone, and why — never silently. */
  skipped: { song: string; reason: string }[];
  /**
   * Words or charts a song no longer has, whose files are still on disk. The
   * file API cannot delete, so they are named rather than quietly left.
   */
  stale: string[];
}

/** Characters a file name can't carry, whatever the filesystem. */
function safeName(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Everything the manifest says about one song, worked out from the set alone.
 *
 * `firstBarOffsetSec` is the exception and comes from the caller: it is a fact
 * about the MP3s sitting in the folder, not about the set, and re-deriving it
 * here would put a song fractionally out against files nobody re-encoded.
 */
export function songInfoFor(
  song: AlsSong,
  project: AlsProject,
  alsPath: string,
  /** What the files on disk say, which this cannot re-derive: their folder, lead-in, parts, key and date. */
  carried: {
    folder: string;
    firstBarOffsetSec: number;
    parts?: PreparedSongInfo['parts'];
    audioKey?: string;
    renderedAt?: string;
  },
): PreparedSongInfo {
  const { folder, firstBarOffsetSec, parts, audioKey, renderedAt } = carried;
  return {
    folder,
    title: song.title,
    renderedAt,
    tempo: Math.round(tempoOf(song, project) * 10) / 10,
    timeSignature: `${project.timeSigNum}/${project.timeSigDen}`,
    bars: song.endBar - song.startBar + 1,
    durationSec: Math.round(songLengthSec(song, project) * 100) / 100,
    firstBarOffsetSec,
    /*
     * Carried, not derived, for the same reason as the lead-in: these name
     * files sitting in the folder, and which of the set's tracks were printed,
     * combined or skipped was a choice made at prepare time that this run has
     * no record of. A set prepared before the manifest carried them gains them
     * on its next proper prepare.
     */
    parts,
    // The audio's key is a fact about those same files, and travels with them.
    audioKey,
    originalKey: song.key ?? undefined,
    notes: song.notes || undefined,
    tempoMap: song.tempoChanges.length ? song.tempoChanges : undefined,
    markers: song.sections.length
      ? song.sections.map((s) => ({ bar: s.bar, name: s.text }))
      : undefined,
    chords: song.chords.length ? song.chords : undefined,
    lanes: laneList(song),
    patchClips:
      song.rigMarks?.length || song.rigPatches?.length
        ? [
            ...clipsFromMarks(song.rigMarks ?? [], songIdFor(alsPath, song.title)),
            ...clipsFromRig(song.rigPatches ?? [], songIdFor(alsPath, song.title)),
          ].sort((a, b) => a.bar - b.bar)
        : undefined,
  };
}

/**
 * Whether a song can be updated in place, and what to say when it can't.
 *
 * Two ways to fail, and they are worth telling apart: a song the prepared set
 * has never heard of, and a song whose folder has moved out from under it
 * because its tempo, key or time signature changed. The second is the
 * dangerous one — the audio in that folder is now wrong, and writing fresh
 * sections over it would make a broken song look maintained.
 */
export function updatableSong(
  song: AlsSong,
  project: AlsProject,
  manifest: PreparedManifest,
  presentFolders: string[],
): { ok: true; entry: PreparedSongInfo | null; folder: string } | { ok: false; reason: string } {
  const name = songFolderBase(song);
  const entry = manifest.songs.find((s) => sameSong(s.folder, name)) ?? null;
  if (entry) {
    // The facts the audio was rendered under: from the entry, or for an
    // older set from the curly block its folder name carried.
    const meta = entry.tempo === undefined ? parseNameMeta(entry.folder) : null;
    const was = {
      bpm: entry.tempo ?? meta?.bpm ?? null,
      key: entry.tempo !== undefined ? entry.originalKey ?? null : meta?.key ?? null,
      sig: entry.timeSignature ?? (meta?.timeSig ? `${meta.timeSig.num}/${meta.timeSig.den}` : null),
    };
    const now = {
      bpm: Math.round(tempoOf(song, project) * 10) / 10,
      key: song.key ?? null,
      sig: `${project.timeSigNum}/${project.timeSigDen}`,
    };
    const moved =
      (was.bpm !== null && Math.abs(was.bpm - now.bpm) > 0.05) ||
      (was.key !== null && was.key !== now.key) ||
      (was.sig !== null && was.sig !== now.sig);
    if (moved) {
      return {
        ok: false,
        reason:
          `its audio was rendered at ${was.bpm ?? '?'} BPM${was.key ? ` in ${was.key}` : ''}${was.sig ? `, ${was.sig}` : ''} ` +
          `and the set now has it at ${now.bpm} BPM${now.key ? ` in ${now.key}` : ''}, ${now.sig} — ` +
          'the tempo, key or time signature has changed, so the audio there is out of date too. Prepare it properly.',
      };
    }
    return { ok: true, entry, folder: entry.folder };
  }
  const present = presentFolders.find((f) => sameSong(f, name));
  if (present) return { ok: true, entry: null, folder: present };
  return { ok: false, reason: 'it has never been prepared into this set' };
}

export async function updatePrepared(opts: UpdateOptions): Promise<UpdateResult> {
  const { project, alsPath, setFolder, manifest, presentFolders, writeFile, onProgress, signal } = opts;

  const wanted = opts.only?.length ? new Set(opts.only) : null;
  // Deduped the way the importer does: a count-in locator repeats its title.
  const chosen: AlsSong[] = [];
  for (const song of project.songs) {
    if (wanted && !wanted.has(song.title)) continue;
    if (chosen[chosen.length - 1]?.title !== song.title) chosen.push(song);
  }

  const written: PreparedSongInfo[] = [];
  const skipped: UpdateResult['skipped'] = [];
  const stale: string[] = [];
  let lyricsWritten = 0;
  let chartsWritten = 0;

  for (const [index, song] of chosen.entries()) {
    if (signal?.aborted) throw new DOMException('Update cancelled', 'AbortError');
    onProgress?.({ title: song.title, index: index + 1, count: chosen.length });

    const standing = updatableSong(song, project, manifest, presentFolders);
    if (!standing.ok) {
      skipped.push({ song: song.title, reason: standing.reason });
      continue;
    }

    // The folder the files are in — dated when it was rendered, not today.
    const folderName = standing.folder;
    const songFolder = `${setFolder}/${folderName}`;
    const base = safeName(song.title);

    const words = lyricsFileFor(song, project);
    if (words) {
      await writeFile(`${songFolder}/${base}.lrc`, words);
      lyricsWritten++;
    } else if (standing.entry?.lanes?.some((lane) => lane.kind === 'lyrics' && lane.items.length)) {
      // It had words when it was prepared and has none now. The file on disk
      // is the old ones, and nothing here can remove it.
      stale.push(`${folderName}/${base}.lrc`);
    }

    const chart = chordProFor(song, project);
    if (chart) {
      await writeFile(`${songFolder}/${base}.cho`, new Blob([chart], { type: 'text/plain' }));
      chartsWritten++;
    }

    const entry = songInfoFor(song, project, alsPath, {
      folder: standing.folder,
      // The files' own lead-in, kept exactly. Nothing here re-encodes them.
      firstBarOffsetSec: standing.entry?.firstBarOffsetSec ?? manifest.paddingSec,
      parts: standing.entry?.parts,
      audioKey: standing.entry?.audioKey,
      renderedAt: standing.entry?.renderedAt,
    });
    written.push(entry);
    // The folder's own copy of the entry, refreshed with it.
    await writeFile(
      `${songFolder}/${SONG_FILE_NAME}`,
      new Blob([JSON.stringify(songFileFor(entry, setFolder.split('/').pop() ?? setFolder, alsPath), null, 2)], {
        type: 'application/json',
      }),
    );
  }

  if (written.length) {
    const next: PreparedManifest = {
      preparedBy: 'rehearsaltool',
      preparedAt: new Date().toISOString(),
      fromSet: alsPath,
      // Describes the MP3s in the folder, which this run has not touched.
      paddingSec: manifest.paddingSec,
      songs: mergeSongs(manifest.songs, written, folderOrder(project, opts.songOrder)),
    };
    await writeFile(
      `${setFolder}/${MANIFEST_NAME}`,
      new Blob([JSON.stringify(next, null, 2)], { type: 'application/json' }),
    );
  }

  return {
    folder: setFolder,
    updated: written.map((w) => w.title),
    lyricsWritten,
    chartsWritten,
    skipped,
    stale,
  };
}

import { emptyLibrary, type Library, type Setlist, type Song } from '../types.ts';
import * as local from './localSource.ts';
import { isProjectScaffolding, mergeScan } from './scan.ts';
import type { FileEntry } from './files.ts';
import { applyManifest, isManifestName, setFolderOf, type PreparedManifest } from './preparedSet.ts';
import { isPreparedSet, isPrint } from './prints.ts';

/**
 * Handing a prepared set to the band.
 *
 * The band reads one folder — their own Dropbox app folder — and the studio
 * reads another. Nothing bridges them but this: what the studio prepares is
 * written into the band's folder, along with a library naming it.
 *
 * The library matters as much as the audio. Without one the band's app has a
 * folder of files and no idea what any of them are: no tempos, no keys, no
 * sections, no running order. The files alone are not a library.
 *
 * It is built by reading the folder back rather than from what was just
 * written. Whatever the band's app would make of those files is what they
 * should be given, and reading it back is the only way to be sure the two
 * agree — a library describing files that are not quite there is worse than
 * none at all.
 */

export const BAND_LIBRARY = '.rehearsal-tool.json';
/** The name the library went by before the app was renamed; read, never written. */
export const LEGACY_BAND_LIBRARY = '.learning-songs.json';

export interface PublishResult {
  /** Songs the band can now see. */
  songs: number;
  /** Songs that were already there and stayed. */
  kept: number;
  folderName: string;
}

/**
 * Rebuild the band's library from what is in their folder, and write it.
 *
 * Merged rather than replaced: a set published last month is still theirs, and
 * anything typed against those songs — a key, a marker moved by hand — belongs
 * to the library rather than to the files, and would be lost by starting over.
 */
/**
 * The files of the band's folder that are songs.
 *
 * Not the prints: a mix of a song that exists is not a song, and the
 * website attaches those itself on its own scan. And nothing under
 * Resources/, which holds the samples the click and cues strike, the slates,
 * and whatever else was filed there — a folder of a hundred and sixty
 * one-shots is not a hundred and sixty songs, and once read as such it put
 * "215 songs" in front of a band with forty-six. The studio's own scan never
 * looked there; this one, having no set to tell it whose territory was
 * whose, did.
 */
export function publishable(files: FileEntry[]): FileEntry[] {
  return files.filter((f) => !isPrint(f.path) && !isProjectScaffolding(f.path));
}

/** A prepared set's running order in the band's library, by its set folder. */
export const preparedSetlistId = (setFolder: string): string => `set:${setFolder.toLowerCase()}`;
export const isPreparedSetlist = (id: string): boolean => id.startsWith('set:');

/**
 * One running order per prepared set, for the band's app.
 *
 * The manifest lists a set's songs in the order they are played — AbleSet's
 * where the project keeps one — and a library of songs alone loses that:
 * alphabetical is what a folder of songs becomes with no order beside it.
 * So each prepared set is also a setlist in the band's library, its songs
 * in the manifest's order by the ids the scan just gave them. Rebuilt from
 * the folder every time, like the songs; a running order made by hand on
 * the website is not the studio's and is left alone.
 */
export function setlistsFromManifests(
  songs: Song[],
  manifests: { path: string; manifest: PreparedManifest }[],
  existing: Setlist[],
): Setlist[] {
  const idByPath = new Map(songs.map((s) => [s.folderPath.toLowerCase(), s.id]));
  const made: Setlist[] = [];
  for (const { path, manifest } of manifests) {
    if (manifest?.preparedBy !== 'rehearsaltool' || !Array.isArray(manifest.songs)) continue;
    const setFolder = setFolderOf(path);
    const songIds = manifest.songs
      .map((info) => idByPath.get(`${setFolder}/${info.folder}`.toLowerCase()))
      .filter((id): id is string => !!id);
    if (!songIds.length) continue;
    const at = Date.parse(manifest.preparedAt ?? '');
    made.push({
      id: preparedSetlistId(setFolder),
      name: setFolder.split('/').pop() || setFolder,
      songIds,
      notes: 'The running order as prepared — AbleSet’s where the project keeps one.',
      updatedAt: Number.isFinite(at) ? at : Date.now(),
    });
  }
  return [...existing.filter((sl) => !isPreparedSetlist(sl.id)), ...made];
}

export async function publishLibrary(folder: local.FolderHandle): Promise<PublishResult> {
  const existing =
    (await local.readJson<Library>(folder, '', `/${BAND_LIBRARY}`).catch(() => null))?.data ??
    (await local.readJson<Library>(folder, '', `/${LEGACY_BAND_LIBRARY}`).catch(() => null))?.data ??
    emptyLibrary('');

  const files = await local.listFiles(folder, '');
  const before = existing.songs.length;

  // The band's folder has no Ableton sets in it and nothing to claim, so this
  // is the plain folder scan — the same one their app would have run.
  const result = mergeScan(existing, publishable(files), '');
  const songs = result.library.songs;

  // Facts the folder names had no room for: sections, chords, lyrics — and
  // the order the songs are played in.
  const manifests = files.filter((f) => isPreparedSet(f.path) && isManifestName(f.name));
  const read: { path: string; manifest: PreparedManifest }[] = [];
  for (const file of manifests) {
    const doc = await local.readJson<unknown>(folder, '', file.path).catch(() => null);
    if (!doc) continue;
    applyManifest(songs, file.path, doc.data);
    read.push({ path: file.path, manifest: doc.data as PreparedManifest });
  }
  const setlists = setlistsFromManifests(songs, read, result.library.setlists ?? []);

  /*
   * As the band's player reads it. A sampler part carries no path there —
   * its paths are on its samples — and the studio's loader needing one is
   * the studio's business, not the contract's.
   */
  const forBand = songs.map((song) => ({
    ...song,
    variants: song.variants.map((v) => {
      if (v.kind !== 'sampler') return v;
      const { path: _path, clips: _clips, ...rest } = v;
      return rest as typeof v;
    }),
  }));
  const library = { ...result.library, songs: forBand, setlists, updatedAt: Date.now() };
  await local.writeJson(folder, '', `/${BAND_LIBRARY}`, library);
  /*
   * Under the old name as well, for now. The band's production site still
   * reads only that name until the release that knows the new one goes
   * out; a studio that stopped writing it would leave the band a library
   * frozen on the day of the rename. Drop this once production reads
   * .rehearsal-tool.json.
   */
  await local.writeJson(folder, '', `/${LEGACY_BAND_LIBRARY}`, library);

  return {
    songs: songs.length,
    kept: Math.min(before, songs.length),
    folderName: folder.name,
  };
}

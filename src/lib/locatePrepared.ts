import * as local from './localSource';
import type { FileEntry } from './files';
import { isManifestName, setFolderOf, type PreparedManifest } from './preparedSet';
import { isPreparedSet } from './prints';
import { contentScore, setFor, type PreparedSetAt } from './updatePrepared';
import { defaultSetName, rememberSetName, rememberedSetName, safeSetName } from './setName';
import { SETS_FOLDER } from './prints';
import { MANIFEST_NAME } from './preparedSet';

/**
 * Finding the prepared set in the band's folder that a given `.als` produced.
 *
 * Kept apart from the update itself, and from the pages that call it, because
 * both the set-wide tool and the one-song dialog need exactly this and neither
 * should be reading the band's folder its own way.
 */

export interface LocatedSet {
  setFolder: string;
  manifest: PreparedManifest;
  /** Song folder names actually on disk under it. */
  presentFolders: string[];
}

/** Every prepared set in the band's folder, with its manifest. */
export async function preparedCandidates(folder: local.FolderHandle): Promise<{ files: FileEntry[]; candidates: PreparedSetAt[] }> {
  const files = await local.listFiles(folder, '');
  const candidates: PreparedSetAt[] = [];
  for (const file of files) {
    // Any Sets folder, wherever it sits: the old wrapper's and the new root's alike.
    if (!isManifestName(file.name) || !isPreparedSet(file.path)) continue;
    try {
      const { bytes } = await local.readBytes(folder, '', file.path);
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifest;
      if (manifest?.preparedBy === 'rehearsaltool' && Array.isArray(manifest.songs)) {
        candidates.push({ folder: setFolderOf(file.path), manifest });
      }
    } catch {
      // A manifest that will not parse is not the set being looked for.
    }
  }
  return { files, candidates };
}

export async function locatePrepared(
  folder: local.FolderHandle,
  alsPath: string,
  /** The set's audio keys now, by song folder name, to recognise it by content. */
  keys?: Record<string, string>,
): Promise<LocatedSet | { error: string }> {
  const { files, candidates } = await preparedCandidates(folder);
  const found = setFor(candidates, alsPath, keys);
  if (!found) {
    return {
      error: candidates.length
        ? 'None of the prepared sets in the band’s folder came from this set. Prepare it once, and after that this can keep it up to date.'
        : 'Nothing has been prepared into the band’s folder yet. Prepare the set once, and after that this can keep it up to date.',
    };
  }

  /*
   * The song folders actually there, so a song the manifest never mentioned —
   * prepared by a build that wrote no manifest — can still be described rather
   * than reported missing.
   */
  const present = new Set<string>();
  const prefix = `${found.folder}/`.toLowerCase();
  for (const file of files) {
    if (!file.path.toLowerCase().startsWith(prefix)) continue;
    const rest = file.path.slice(found.folder.length + 1);
    const cut = rest.indexOf('/');
    if (cut > 0) present.add(rest.slice(0, cut));
  }

  return { setFolder: found.folder, manifest: found.manifest, presentFolders: [...present] };
}

/**
 * The folder name to prepare under now.
 *
 * The name remembered for this .als when there is one. Otherwise the folder
 * in the band's folder this set already produced — found the way the update
 * tool finds it, by what the manifest says it came from or by the folder's
 * name — because a set renamed on disk, or a memory lost with the browser's
 * storage, must not start a fresh folder with no audio in it. Today's name
 * only when nothing was ever prepared. Found once, it is remembered, so the
 * one-song dialog lands in the same folder.
 */
export async function preparedNameFor(
  folder: local.FolderHandle,
  alsPath: string,
  keys?: Record<string, string>,
): Promise<string> {
  const remembered = rememberedSetName(alsPath);
  /*
   * A remembered name is trusted — unless the folder it names holds none
   * of this set's songs while another folder holds some. That is a memory
   * pointing at the wrong folder (a renamed one, prepared from some other
   * set), and following it would write every song again for nothing.
   */
  if (remembered && !keys) return remembered;
  const { candidates } = await preparedCandidates(folder);
  if (remembered && keys) {
    const own = candidates.find((c) => c.folder.split('/').pop()?.toLowerCase() === remembered.toLowerCase());
    if (!own) return remembered; // not prepared yet under that name: the name stands
    if (contentScore(own.manifest, keys) > 0) return remembered;
    const better = candidates.find((c) => contentScore(c.manifest, keys) > 0);
    if (!better) return remembered;
  }
  const found = setFor(candidates, alsPath, keys);
  const name = found?.folder.split('/').pop();
  if (name) {
    rememberSetName(alsPath, name);
    return name;
  }
  return remembered ?? defaultSetName(alsPath);
}

/** A set folder in the band's folder, as the launch screen lists it. */
export interface OutputSet {
  /** `Sets/<name>`, relative to the band's folder. */
  folder: string;
  name: string;
  songs: number;
  preparedAt?: string;
  /** The Ableton session it is prepared from, as remembered in its manifest. */
  session?: string;
}

/** Every set folder under Sets/, newest first. */
export async function outputSets(band: local.FolderHandle): Promise<OutputSet[]> {
  const { candidates } = await preparedCandidates(band);
  return candidates
    .map((c) => ({
      folder: c.folder,
      name: c.folder.split('/').pop() ?? c.folder,
      songs: c.manifest.songs.length,
      preparedAt: c.manifest.preparedAt,
      session: c.manifest.session,
    }))
    .sort((a, b) => (b.preparedAt ?? '').localeCompare(a.preparedAt ?? ''));
}

const json = (value: unknown) => new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });

/**
 * Remember which session feeds a set folder, in its manifest. A folder with
 * no manifest yet gets one with nothing prepared in it, so the folder is
 * there to be listed and opened before its first prepare.
 */
export async function rememberSession(band: local.FolderHandle, setFolder: string, alsPath: string): Promise<void> {
  const path = `${setFolder}/${MANIFEST_NAME}`;
  let manifest: PreparedManifest;
  try {
    const { bytes } = await local.readBytes(band, '', path);
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as PreparedManifest;
  } catch {
    manifest = { preparedBy: 'rehearsaltool', preparedAt: new Date().toISOString(), paddingSec: 0, songs: [] };
  }
  if (manifest.session === alsPath) return;
  await local.writeFile(band, '', path, json({ ...manifest, session: alsPath }));
}

/** Make a set folder under Sets/, named and fed by a session, with nothing prepared in it yet. */
export async function createOutputSet(band: local.FolderHandle, name: string, alsPath: string): Promise<OutputSet> {
  const clean = safeSetName(name);
  if (!clean) throw new Error('The folder needs a name.');
  const folder = `${SETS_FOLDER}/${clean}`;
  if (await local.exists(band, '', `${folder}/${MANIFEST_NAME}`)) {
    throw new Error(`There is already a set folder called “${clean}”. Open that one, or choose another name.`);
  }
  await rememberSession(band, folder, alsPath);
  return { folder, name: clean, songs: 0, preparedAt: new Date().toISOString(), session: alsPath };
}

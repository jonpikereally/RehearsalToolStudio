import * as local from './localSource';
import { isManifestName, setFolderOf, type PreparedManifest } from './preparedSet';
import { PREPARED_FOLDER, PRINTS_FOLDER } from './prints';
import { setFor, type PreparedSetAt } from './updatePrepared';

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

export async function locatePrepared(
  folder: local.FolderHandle,
  alsPath: string,
): Promise<LocatedSet | { error: string }> {
  const files = await local.listFiles(folder, '');
  const under = new RegExp(`(^|/)${PRINTS_FOLDER}/${PREPARED_FOLDER}/`, 'i');

  const candidates: PreparedSetAt[] = [];
  for (const file of files) {
    if (!isManifestName(file.name) || !under.test(file.path)) continue;
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

  const found = setFor(candidates, alsPath);
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

import type { Variant } from '../types';

/**
 * Grouping a song's files into versions.
 *
 * Files in the same folder are the same version. A version is a complete
 * rendering of the song and can carry anything: its own stems, an acapella, an
 * instrumental, a reference master, a print made here. A later export goes to a
 * folder of its own, and that is what makes it a different version.
 *
 * Nothing in the file names says this, and nothing needs to — the folders
 * already do.
 */

export interface SongVersion {
  /** Stable across scans: the folder, lowercased. */
  id: string;
  name: string;
  folder: string;
  parts: Variant[];
  /** The separated parts, as opposed to whole mixes. */
  stems: Variant[];
  mixes: Variant[];
}

export function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

function leafOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A readable name for a version.
 *
 * Export folders are usually the song's name again plus how it was rendered —
 * "Fix You 136 140BPM Stems 2025.09.10" — so the song's own name comes off the
 * front, leaving what actually distinguishes this one from the others.
 */
export function versionName(folder: string, songTitle: string): string {
  const leaf = leafOf(folder);
  const trimmed = leaf.replace(new RegExp(`^${escapeRegExp(songTitle)}\\s*`, 'i'), '').trim();
  return trimmed || leaf || 'Main';
}

/**
 * Versions in order, fullest first.
 *
 * The one holding the most parts leads: an export with the whole band in it is
 * a better default than a folder holding a single bounce.
 */
export function versionsOf(variants: Variant[], songTitle: string): SongVersion[] {
  /*
   * The folder, unless the part names its version outright. A print made here
   * lives in the app's own folder rather than the project's, so it says which
   * version it belongs to instead of forming one of its own.
   */
  const byFolder = new Map<string, Variant[]>();
  for (const variant of variants) {
    // Lowercased, so a part naming its version by id lands in the same group as
    // the parts whose folder that id came from.
    const key = (variant.versionId ?? folderOf(variant.path)).toLowerCase();
    const list = byFolder.get(key);
    if (list) list.push(variant);
    else byFolder.set(key, [variant]);
  }

  const versions: SongVersion[] = [];
  for (const [key, parts] of byFolder) {
    /*
     * Named after a part that actually lives in the version's folder. A print
     * only points at the version, and its own folder is the app's, which would
     * make a poor name for the thing it belongs to.
     */
    const home = parts.find((p) => !p.versionId) ?? parts[0];
    const folder = folderOf(home.path);
    versions.push({
      id: key,
      name: versionName(folder, songTitle),
      folder,
      parts,
      stems: parts.filter((p) => p.role === 'stem'),
      mixes: parts.filter((p) => p.role !== 'stem'),
    });
  }

  return versions.sort((a, b) => b.parts.length - a.parts.length || a.name.localeCompare(b.name));
}

import type { FileEntry } from './files';
import { normalisePath } from './paths.ts';
import { isAudio, parseNameMeta } from './scan.ts';

/**
 * The shape of what the app writes, and how it is read back.
 *
 *   <root>/
 *     Sets/<set name>/...         sets prepared from Ableton: a library in
 *                                 their own right, scanned like any folder
 *     Prints/<version>/...        mixes printed of songs that already exist,
 *                                 attached to those songs on scan
 *     Resources/...               the samples sampler parts strike, shared
 *
 * It used to all sit under a folder called "Rehearsal Tool", and prints were
 * whatever was under it but not under Sets/. The band's folder already lives
 * inside a Dropbox app folder of that name, so the path read the app's name
 * twice for nothing — and once the wrapper is gone, "not under Sets/" would
 * sweep in anything else the band keeps beside their sets. So prints are now
 * named by their folder rather than inferred from position.
 *
 * Both shapes are read; only the new one is written. Every band has the old
 * one, nothing moves anyone's files, and a band that prepares again ends up
 * with the two side by side, which is fine: a folder called Sets or Prints
 * counts wherever it sits, which is the rule the website reads by too.
 */

/** The wrapper everything used to sit under. Read, never written. */
export const APP_FOLDER = 'Rehearsal Tool';
export const SETS_FOLDER = 'Sets';
export const PRINTS_FOLDER = 'Prints';
export const RESOURCES_FOLDER = 'Resources';
/** Kept for the studio's own manifest paths; the same thing as SETS_FOLDER. */
export const PREPARED_FOLDER = SETS_FOLDER;

/** A path with this folder as one of its segments, wherever it sits. */
const hasSegment = (path: string, name: string) => new RegExp(`(^|/)${name}(/|$)`, 'i').test(path);

/** True for a set the app prepared, which is scanned as an ordinary library. */
export function isPreparedSet(path: string): boolean {
  return hasSegment(path, SETS_FOLDER);
}

/**
 * True for a print: written by the app, and attached to a song that exists.
 * Under Prints/ now; under the old wrapper but not under Sets/ before.
 */
export function isPrint(path: string): boolean {
  if (isPreparedSet(path)) return false;
  return hasSegment(path, PRINTS_FOLDER) || hasSegment(path, APP_FOLDER);
}

/** Where prepared sets are written under a root. */
export function setsFolder(root: string): string {
  return `${normalisePath(root)}/${SETS_FOLDER}`;
}

/** The folder a print belongs in, given the version it was made from. */
export function printFolder(root: string, versionName: string): string {
  const base = `${normalisePath(root)}/${PRINTS_FOLDER}`;
  const safe = versionName.replace(/[\\/:*?"<>|]/g, '').trim();
  return safe ? `${base}/${safe}` : base;
}

export interface FoundPrint {
  file: FileEntry;
  /** The song's title, taken from the file name with its tags stripped. */
  title: string;
  /** The version folder it sits in, or '' when it sits loose. */
  versionName: string;
}

function stripExtension(name: string): string {
  const cut = name.lastIndexOf('.');
  return cut > 0 ? name.slice(0, cut) : name;
}

/**
 * A file's song title, with every tag taken off.
 *
 * parseNameMeta only lifts the `{curly}` block, so the version and stem
 * brackets come off here too — otherwise "Fix You (no vocal …)" never matches
 * the song "Fix You".
 */
export function baseTitleOf(fileName: string): string {
  const withoutTags = stripExtension(fileName).replace(/\s*[[({][^\])}]*[\])}]\s*/g, ' ');
  return parseNameMeta(withoutTags).title.trim();
}

/** Every print, wherever it sits, with the song and version it claims. */
export function findPrints(files: FileEntry[]): FoundPrint[] {
  const found: FoundPrint[] = [];
  for (const file of files) {
    if (!isPrint(file.path) || !isAudio(file.name)) continue;
    const title = baseTitleOf(file.name);
    if (!title) continue;

    // The folders between the prints root — Prints/, or the old wrapper — and
    // the file are the version, if there are any.
    const parts = file.path.split('/').filter(Boolean);
    const lower = parts.map((p) => p.toLowerCase());
    let at = lower.indexOf(PRINTS_FOLDER.toLowerCase());
    if (at < 0) at = lower.indexOf(APP_FOLDER.toLowerCase());
    const between = parts.slice(at + 1, parts.length - 1);
    found.push({ file, title, versionName: between.join('/') });
  }
  return found;
}

import type { FileEntry } from './files';
import { normalisePath } from './paths.ts';
import { isAudio, parseNameMeta } from './scan.ts';

/**
 * Where mixes printed by the app live, and how they find their way back.
 *
 * They go in one folder of the app's own rather than into the Ableton project
 * they came from. A set's stem folders are the project's business — dropping
 * files into them muddles what Ableton exported with what this app made, and
 * anyone re-exporting stems would be picking through both.
 *
 *   <root>/Rehearsal Tool/<version>/Fix You (no vocal v1 2026-08-13 rehearsaltool).wav
 *
 * The version folder is what puts a print back with the parts it was made from.
 * Without it the print would sit in a folder of its own, and a folder is what
 * makes a version, so every print would look like a new rendering of the song.
 */

export const PRINTS_FOLDER = 'Rehearsal Tool';

/**
 * Sets prepared from Ableton live under here.
 *
 * They are a library in their own right — songs with parts, to be scanned like
 * any other folder — where a print is an extra part belonging to a song that
 * already exists. Both are written by the app, so both sit under its folder,
 * but only one of them is attached to something else afterwards.
 */
export const PREPARED_FOLDER = 'Sets';

function underAppFolder(path: string): boolean {
  return new RegExp(`(^|/)${PRINTS_FOLDER}(/|$)`, 'i').test(path);
}

/** True for a set the app prepared, which is scanned as an ordinary library. */
export function isPreparedSet(path: string): boolean {
  return (
    underAppFolder(path) &&
    new RegExp(`(^|/)${PRINTS_FOLDER}/${PREPARED_FOLDER}(/|$)`, 'i').test(path)
  );
}

/** True for a print: written by the app, and attached to a song that exists. */
export function isPrint(path: string): boolean {
  return underAppFolder(path) && !isPreparedSet(path);
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

/** Every print in the app's folder, with the song and version it claims. */
export function findPrints(files: FileEntry[]): FoundPrint[] {
  const found: FoundPrint[] = [];
  for (const file of files) {
    if (!isPrint(file.path) || !isAudio(file.name)) continue;
    const title = baseTitleOf(file.name);
    if (!title) continue;

    // The folder directly under "Rehearsal Tool" is the version, if there is one.
    const parts = file.path.split('/').filter(Boolean);
    const at = parts.findIndex((p) => p.toLowerCase() === PRINTS_FOLDER.toLowerCase());
    const between = parts.slice(at + 1, parts.length - 1);
    found.push({ file, title, versionName: between.join('/') });
  }
  return found;
}

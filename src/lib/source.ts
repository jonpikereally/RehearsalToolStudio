import type { FileEntry } from './files.ts';
import * as local from './localSource.ts';

/**
 * Where the app reads songs from: one folder on this machine, and nothing
 * else. The studio runs on the machine the sets live on, so the folder on
 * disk is the whole of it — no downloads, no sign-in, no second copy to fall
 * out of step with the first.
 *
 * Paths above this layer keep their leading-slash, '/'-joined form, so song
 * and variant ids are stable whatever folder the studio is pointed at.
 */

interface Config {
  root: string;
  useLocal: boolean;
  folder: local.FolderHandle | null;
}

let config: Config = { root: '', useLocal: false, folder: null };

export function configureSource(next: Partial<Config>): void {
  config = { ...config, ...next };
}

/** True when a folder is chosen and switched on. */
export function localReady(): boolean {
  return config.useLocal && !!config.folder;
}

export function canRead(): boolean {
  return localReady();
}

export function describeSource(): string {
  return localReady() ? `the folder “${config.folder!.name}” on this Mac` : 'nowhere yet';
}

/* --------------------------------- listing -------------------------------- */

export async function listAll(onProgress?: (count: number) => void): Promise<FileEntry[]> {
  if (!localReady()) return [];
  return local.listFiles(config.folder!, config.root, onProgress);
}

/* --------------------------------- reading -------------------------------- */

/** True when this file is in the folder. */
/**
 * Where a file stands: here, not there, or in a folder the studio has not
 * been allowed to read. A check that could not be made at all counts as
 * here — a momentary gap in the server is not a missing file.
 */
export async function availability(path: string): Promise<'here' | 'missing' | 'forbidden'> {
  if (!localReady()) return 'here';
  try {
    return (await local.exists(config.folder!, config.root, path)) ? 'here' : 'missing';
  } catch (err) {
    return /not a folder the studio was given/.test(String((err as Error)?.message ?? err)) ? 'forbidden' : 'here';
  }
}

export async function isLocal(path: string): Promise<boolean> {
  if (!localReady()) return false;
  // A check that could not be made is not a file that is not there.
  try {
    return await local.exists(config.folder!, config.root, path);
  } catch {
    return true;
  }
}

export async function readBytes(
  path: string,
  onProgress?: (loaded: number, total: number) => void,
  _signal?: AbortSignal,
  /** Only this stretch of the file, by byte offsets; the whole file without. */
  range?: local.ByteRange,
): Promise<{ bytes: ArrayBuffer; mime: string; from: 'local' | 'remote'; size: number }> {
  if (!localReady()) throw new Error('No folder is chosen to read from.');
  // Disk reads are effectively instant, so there is no progress worth showing.
  const result = await local.readBytes(config.folder!, config.root, path, range);
  onProgress?.(result.bytes.byteLength, result.bytes.byteLength);
  return { ...result, from: 'local' };
}

/* ------------------------------- library file ------------------------------ */

export interface Doc<T> {
  data: T;
  rev: string | null;
}

export async function readJson<T>(path: string): Promise<Doc<T> | null> {
  if (!localReady()) return null;
  return local.readJson<T>(config.folder!, config.root, path);
}

/** A file's identity as another local tool would need it: name, size, date. */
/** AbleSet's current running order for the set at `path`, from its log. */
export async function abletLive(path: string): Promise<local.AbleSetLive> {
  if (!localReady()) return { found: false };
  return local.abletLive(config.folder!, config.root, path);
}

/** Where a file of the folder is on this Mac, for another app that reads it itself. */
export async function absolutePath(path: string): Promise<string> {
  if (!localReady()) throw new Error('No folder is chosen to read from.');
  return local.absolutePath(config.folder!, config.root, path);
}

export async function statFile(path: string): Promise<{ name: string; size: number; modified: number }> {
  if (!localReady()) throw new Error('No folder is chosen to read from.');
  return local.statFile(config.folder!, config.root, path);
}

export type WriteResult = { ok: true; rev: string } | { ok: false; conflict: true };

/** Save a file into the folder, returning where it landed. Never overwrites audio. */
export async function writeFile(path: string, data: Blob): Promise<string> {
  if (!localReady()) throw new Error('No folder is chosen to save into.');
  return local.writeFile(config.folder!, config.root, path, data);
}

export async function writeJson(path: string, data: unknown, _rev: string | null): Promise<WriteResult> {
  // On disk there is no revision to race against — last write wins, as it
  // would with any other file. Reported as a conflict rather than thrown when
  // there is no folder, so a stray call is a no-op instead of an error.
  if (!localReady()) return { ok: false, conflict: true };
  return local.writeJson(config.folder!, config.root, path, data);
}

import type { FileEntry } from './files';
import { normalisePath } from './paths.ts';

/**
 * The folder on disk, reached through the studio's own server.
 *
 * The studio's window has no way to a file of its own; its server does, and
 * it runs on the same machine as the files — the only machine the studio was
 * ever for. Every read and write here is a call to `/__fs/…` on the server
 * that served the page (see scripts/studio-files.mjs), by folder path.
 *
 * Paths are reported in the form `<root>/Artist/Song/file.mp3` so song and
 * variant ids are stable whatever folder the studio is pointed at.
 */

/**
 * Two folders, kept apart on purpose.
 *
 * `songs` is the workshop the studio reads: sets, stems, gigabytes of WAV.
 * `publish` is the band's own folder — a different Dropbox app folder, synced
 * by the desktop client, and the only place their app can read from — so
 * what the studio prepares is written there rather than beside its source.
 */
export type FolderSlot = 'songs' | 'publish' | 'resources';

/** A path a set names absolutely, outside the folder: sent as it is, read only. */
export const isAbsoluteRef = (path: string): boolean => path.startsWith('abs:');

declare const opaque: unique symbol;

/** A folder this app may read and write. Which path that is stays in here. */
export interface FolderHandle {
  readonly name: string;
  readonly [opaque]: true;
}

interface Inner {
  name: string;
  dir: string;
}

const wrap = (inner: Inner): FolderHandle => inner as unknown as FolderHandle;
const open = (handle: FolderHandle): Inner => handle as unknown as Inner;

export interface LocalFolder {
  handle: FolderHandle;
  name: string;
}

/** A file chosen on its own, read then and there — a set is small. */
export interface PickedFile {
  name: string;
  size: number;
  modified: number;
  bytes: ArrayBuffer;
}

/** What a closed picker throws, in the words callers already look for. */
function aborted(): Error {
  return Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
}

/* --------------------------------- server --------------------------------- */

/**
 * The header is what marks a call as the studio's: a browser will not send a
 * custom header cross-site without asking first, and the server never says
 * yes to a stranger.
 */
const STUDIO_HEADER = { 'x-rehearsal-studio': 'window' };

async function call<T>(op: string, body: unknown): Promise<T> {
  const res = await post(op, JSON.stringify(body), 'application/json');
  return (await res.json()) as T;
}

async function post(op: string, body: BodyInit, type: string): Promise<Response> {
  let res: Response | null = null;
  /*
   * The launcher replaces an outdated server under a running page, which
   * takes a second. A request that fails to connect is tried again a few
   * times before it counts as the server being gone — a folder was once
   * reported "not chosen" and a file "not on disk" for the length of that
   * gap.
   */
  for (let attempt = 0; attempt < 6 && !res; attempt++) {
    try {
      res = await fetch(`/__fs/${op}`, {
        method: 'POST',
        headers: { ...STUDIO_HEADER, 'content-type': type },
        body,
      });
    } catch {
      if (attempt === 5) throw new Error("The studio's server isn't answering — start it with `npm run serve`.");
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (!res) throw new Error("The studio's server isn't answering — start it with `npm run serve`.");
  if (!res.ok) {
    let message = `${res.status} from the studio's server`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not JSON, then; the status will have to do */
    }
    throw new Error(message);
  }
  return res;
}

const PROMPTS: Record<FolderSlot, string> = {
  songs: 'Choose the folder your Ableton sets and stems live in',
  publish: "Choose the band's folder — the one Rehearsal Tool reads",
  resources: "Allow the folder the set's samples live in — read only",
};

/* --------------------------------- picking -------------------------------- */

/** Prompt for a folder. Named slots are remembered; `null` is a one-off, forgotten with the page. */
export async function pickFolder(
  slot: FolderSlot | null = 'songs',
  opts: { startIn?: string } = {},
): Promise<LocalFolder> {
  const picked = await call<{ cancelled?: true; dir: string; name: string }>('pick', {
    kind: 'folder',
    slot: slot ?? undefined,
    prompt: slot ? PROMPTS[slot] : 'Choose where to put what comes out',
    startIn: opts.startIn,
  });
  if (picked.cancelled) throw aborted();
  return { handle: wrap({ dir: picked.dir, name: picked.name }), name: picked.name };
}

/** Prompt for one file — a set off another machine, say — and read it. */
export async function pickFile(opts: { description: string; extensions: string[] }): Promise<PickedFile> {
  const picked = await call<{
    cancelled?: true;
    dir: string;
    name: string;
    size: number;
    modified: number;
  }>('pick', { kind: 'file', prompt: `Choose ${opts.description}`, extensions: opts.extensions });
  if (picked.cancelled) throw aborted();
  const res = await post('read', JSON.stringify({ dir: picked.dir, path: picked.name }), 'application/json');
  return { name: picked.name, size: picked.size, modified: picked.modified, bytes: await res.arrayBuffer() };
}

export async function storedFolder(slot: FolderSlot = 'songs'): Promise<LocalFolder | null> {
  const stored = await call<{ dir: string | null; name?: string }>('stored', { slot });
  if (!stored.dir) return null;
  const name = stored.name ?? stored.dir;
  return { handle: wrap({ dir: stored.dir, name }), name };
}

export async function forgetFolder(slot: FolderSlot = 'songs'): Promise<void> {
  await call('forget', { slot });
}

/**
 * A folder or a set the Mac app was handed — dropped on the window or on the
 * Dock icon. Its folder (the set's own, for a set) becomes the songs folder,
 * remembered as one chosen in Settings would be; the set's name comes back
 * with it so it can be the one opened.
 */
export async function openPath(path: string): Promise<{ folder: LocalFolder; file?: string }> {
  const opened = await call<{ dir: string; name: string; file?: string }>('open', { path, slot: 'songs' });
  return {
    folder: { handle: wrap({ dir: opened.dir, name: opened.name }), name: opened.name },
    ...(opened.file ? { file: opened.file } : {}),
  };
}

/* ---------------------------------- paths --------------------------------- */

/** The part of a path below the root: what the folder itself holds. */
function below(root: string, path: string): string {
  // A sample outside the folder, named absolutely by the set: as it is.
  if (isAbsoluteRef(path)) return path;
  const prefix = normalisePath(root);
  const lower = path.toLowerCase();
  return prefix && lower.startsWith(prefix.toLowerCase() + '/')
    ? path.slice(prefix.length + 1)
    : path.replace(/^\//, '');
}

/* --------------------------------- reading -------------------------------- */

/** Every file in the folder, as the scanner wants them. */
export async function listFiles(
  folder: FolderHandle,
  root: string,
  onProgress?: (count: number) => void,
): Promise<FileEntry[]> {
  const prefix = normalisePath(root);
  const { files } = await call<{
    files: { path: string; name: string; size: number; modified: number }[];
  }>('list', { dir: open(folder).dir });
  const out = files.map((f) => ({
    path: `${prefix}/${f.path}`,
    name: f.name,
    // Changes whenever the file is re-exported.
    rev: `${f.modified}-${f.size}`,
    size: f.size,
    modified: f.modified,
  }));
  onProgress?.(out.length);
  return out;
}

/** Name, size and date of one file, exactly as the disk reports them. */
export async function statFile(
  folder: FolderHandle,
  root: string,
  path: string,
): Promise<{ name: string; size: number; modified: number }> {
  return call('stat', { dir: open(folder).dir, path: below(root, path) });
}

/** What AbleSet is playing right now for this set, from its log. */
export interface AbleSetLive {
  found: boolean;
  /** When AbleSet last sent itself this order, as an ISO date. */
  at?: string | null;
  setlistName?: string;
  /** The set AbleSet has open, and whether it is this set's project. */
  projectFile?: string | null;
  applies?: boolean;
  entries?: { time: number; lastKnownName: string }[];
}

export async function abletLive(folder: FolderHandle, root: string, path: string): Promise<AbleSetLive> {
  return call('ableset-live', { dir: open(folder).dir, path: below(root, path) });
}

/** Whether a file is actually there, without reading it. */
export async function exists(folder: FolderHandle, root: string, path: string): Promise<boolean> {
  return (await call<{ exists: boolean }>('exists', { dir: open(folder).dir, path: below(root, path) })).exists;
}

/** A stretch of a file, by byte offsets; `end` is exclusive. */
export interface ByteRange {
  start: number;
  end: number;
}

export async function readBytes(
  folder: FolderHandle,
  root: string,
  path: string,
  range?: ByteRange,
): Promise<{ bytes: ArrayBuffer; mime: string; size: number }> {
  const res = await post(
    'read',
    JSON.stringify({ dir: open(folder).dir, path: below(root, path), ...(range ? { start: range.start, end: range.end } : {}) }),
    'application/json',
  );
  const bytes = await res.arrayBuffer();
  return {
    bytes,
    mime: res.headers.get('content-type') || 'application/octet-stream',
    // The whole file's length, whatever stretch of it came back.
    size: Number(res.headers.get('x-file-size')) || bytes.byteLength,
  };
}

/* ------------------------------- library file ------------------------------ */

export async function readJson<T>(
  folder: FolderHandle,
  root: string,
  path: string,
): Promise<{ data: T; rev: string | null } | null> {
  const doc = await call<{ missing?: true; data: T; rev: string }>('read-json', {
    dir: open(folder).dir,
    path: below(root, path),
  });
  return doc.missing ? null : { data: doc.data, rev: doc.rev };
}

/** Save bytes into the folder, creating directories as needed. */
export async function writeFile(folder: FolderHandle, root: string, path: string, data: Blob): Promise<string> {
  const query = new URLSearchParams({ dir: open(folder).dir, path: below(root, path) });
  await post(`write?${query}`, data, data.type || 'application/octet-stream');
  return path;
}

export async function writeJson(
  folder: FolderHandle,
  root: string,
  path: string,
  data: unknown,
): Promise<{ ok: true; rev: string }> {
  const { rev } = await call<{ rev: string }>('write-json', {
    dir: open(folder).dir,
    path: below(root, path),
    data,
  });
  return { ok: true, rev };
}

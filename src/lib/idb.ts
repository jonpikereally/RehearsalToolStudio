/**
 * IndexedDB cache.
 *
 * Two stores:
 *  - `files`   original downloaded audio (small, mp3/m4a) keyed by Dropbox path + rev
 *  - `renders` pitch-shifted PCM (large) keyed by path + rev + semitones
 *
 * `renders` is capped by a byte budget and evicted least-recently-used, because a
 * four minute stereo render is ~42 MB even stored as 16-bit PCM.
 */

const DB_NAME = 'rehearsal-tool-studio';
const DB_VERSION = 2;
const FILES = 'files';
const RENDERS = 'renders';
/** Directory handles from the File System Access API, which survive structured clone. */
const HANDLES = 'handles';

export interface CachedFile {
  key: string;
  /**
   * Where it came from, kept rather than parsed back out of the key.
   *
   * The key is `path@rev`, so recovering the path means splitting on the last
   * @ — which is right until a revision contains one. Neither source produces
   * such a revision today, but a cache that quietly fails to identify its own
   * entries is a poor thing to build on. Absent on anything cached before this
   * existed, hence the fallback.
   */
  path?: string;
  bytes: ArrayBuffer;
  mime: string;
  addedAt: number;
}

export interface CachedRender {
  key: string;
  /** Interleaved 16-bit PCM. */
  pcm: ArrayBuffer;
  channels: number;
  sampleRate: number;
  frames: number;
  bytes: number;
  lastUsed: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) {
        db.createObjectStore(FILES, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(RENDERS)) {
        const store = db.createObjectStore(RENDERS, { keyPath: 'key' });
        store.createIndex('lastUsed', 'lastUsed');
      }
      if (!db.objectStoreNames.contains(HANDLES)) {
        db.createObjectStore(HANDLES);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      /*
       * Another tab holding the old version open blocks the upgrade, and the
       * new stores then never appear — every read fails with "object store not
       * found" until that tab is closed. Standing aside when a newer version
       * wants in keeps a second tab from wedging the first.
       */
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onblocked = () => {
      console.warn('[rehearsal-tool-studio] database upgrade is waiting on another tab of this app');
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const fileKey = (path: string, rev: string) => `${path.toLowerCase()}@${rev}`;
export const renderKey = (path: string, rev: string, semitones: number) =>
  `${path.toLowerCase()}@${rev}#${semitones}`;

/* ------------------------------- originals ------------------------------- */

export async function getFile(key: string): Promise<CachedFile | undefined> {
  return tx<CachedFile | undefined>(FILES, 'readonly', (s) => s.get(key));
}

export async function putFile(entry: CachedFile): Promise<void> {
  await tx(FILES, 'readwrite', (s) => s.put(entry));
}

export async function deleteFile(key: string): Promise<void> {
  await tx(FILES, 'readwrite', (s) => s.delete(key));
}

/* -------------------------------- renders -------------------------------- */

export async function getRender(key: string): Promise<CachedRender | undefined> {
  const entry = await tx<CachedRender | undefined>(RENDERS, 'readonly', (s) => s.get(key));
  if (entry) {
    // Touch asynchronously; a failed touch only costs us eviction accuracy.
    void tx(RENDERS, 'readwrite', (s) => s.put({ ...entry, lastUsed: Date.now() })).catch(() => {});
  }
  return entry;
}

export async function putRender(entry: Omit<CachedRender, 'lastUsed'>, budgetBytes: number): Promise<void> {
  await tx(RENDERS, 'readwrite', (s) => s.put({ ...entry, lastUsed: Date.now() }));
  await evictRenders(budgetBytes);
}

/** Drop least-recently-used renders until the store fits inside `budgetBytes`. */
export async function evictRenders(budgetBytes: number): Promise<void> {
  const db = await openDb();
  const entries: CachedRender[] = await new Promise((resolve, reject) => {
    const out: CachedRender[] = [];
    const t = db.transaction(RENDERS, 'readonly');
    const req = t.objectStore(RENDERS).index('lastUsed').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      // Skip the heavy `pcm` payload; we only need the sizes and keys here.
      const v = cursor.value as CachedRender;
      out.push({ ...v, pcm: undefined as unknown as ArrayBuffer });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  let total = entries.reduce((n, e) => n + e.bytes, 0);
  const doomed: string[] = [];
  for (const e of entries) {
    if (total <= budgetBytes) break;
    doomed.push(e.key);
    total -= e.bytes;
  }
  if (!doomed.length) return;

  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(RENDERS, 'readwrite');
    const store = t.objectStore(RENDERS);
    for (const key of doomed) store.delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* --------------------------------- stats --------------------------------- */

export interface CacheStats {
  fileCount: number;
  fileBytes: number;
  renderCount: number;
  renderBytes: number;
}

export async function cacheStats(): Promise<CacheStats> {
  const db = await openDb();
  const read = (store: string, size: (v: any) => number) =>
    new Promise<{ count: number; bytes: number }>((resolve, reject) => {
      let count = 0;
      let bytes = 0;
      const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve({ count, bytes });
        count++;
        bytes += size(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

  const [files, renders] = await Promise.all([
    read(FILES, (v: CachedFile) => v.bytes.byteLength),
    read(RENDERS, (v: CachedRender) => v.bytes),
  ]);
  return {
    fileCount: files.count,
    fileBytes: files.bytes,
    renderCount: renders.count,
    renderBytes: renders.bytes,
  };
}

/**
 * The path a cached file came from, for entries that predate storing it.
 *
 * Splits on the last @, which is correct as long as the revision has none —
 * true of both Dropbox revisions and the local `modified-size` ones.
 */
export function pathFromFileKey(key: string): string {
  const cut = key.lastIndexOf('@');
  return cut > 0 ? key.slice(0, cut) : key;
}

/** Where a cached entry came from: what it recorded, or what its key implies. */
export function pathOfCached(file: Pick<CachedFile, 'key' | 'path'>): string {
  return file.path ?? pathFromFileKey(file.key);
}

/**
 * Drop cached copies of files that are on this machine anyway.
 *
 * Reading from a folder used to cache what it read, so a synced library wrote a
 * second copy of itself here — dead weight competing for the same budget as the
 * renders, which are the expensive thing worth keeping. This clears exactly
 * those, leaving anything genuinely fetched from Dropbox alone.
 *
 * `isLocal` is passed in rather than imported so this stays a store operation
 * and knows nothing about where files come from.
 */
export async function clearLocalDuplicates(
  isLocal: (path: string) => Promise<boolean>,
): Promise<{ removed: number; bytes: number }> {
  const db = await openDb();

  // Collected first, then deleted: an IndexedDB transaction closes the moment
  // it stops being used, and awaiting a filesystem check inside one ends it.
  const entries = await new Promise<{ key: string; path: string; bytes: number }[]>((resolve, reject) => {
    const found: { key: string; path: string; bytes: number }[] = [];
    const req = db.transaction(FILES, 'readonly').objectStore(FILES).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(found);
      const value = cursor.value as CachedFile;
      found.push({ key: value.key, path: pathOfCached(value), bytes: value.bytes.byteLength });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  const doomed: { key: string; bytes: number }[] = [];
  for (const entry of entries) {
    if (await isLocal(entry.path)) doomed.push(entry);
  }
  if (!doomed.length) return { removed: 0, bytes: 0 };

  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(FILES, 'readwrite');
    const store = t.objectStore(FILES);
    for (const entry of doomed) store.delete(entry.key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });

  return { removed: doomed.length, bytes: doomed.reduce((sum, e) => sum + e.bytes, 0) };
}

export async function clearCache(which: 'files' | 'renders' | 'all'): Promise<void> {
  const db = await openDb();
  const stores = which === 'all' ? [FILES, RENDERS] : [which === 'files' ? FILES : RENDERS];
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    for (const s of stores) t.objectStore(s).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ----------------------------- folder handles ----------------------------- */

/**
 * A picked directory handle, kept so the folder doesn't have to be chosen again
 * on every visit. The browser still asks the user to re-grant access once per
 * session, but it remembers which folder was meant.
 */
export async function putHandle(key: string, handle: unknown): Promise<void> {
  await tx(HANDLES, 'readwrite', (s) => s.put(handle as any, key));
}

export async function getHandle<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>(HANDLES, 'readonly', (s) => s.get(key));
}

export async function deleteHandle(key: string): Promise<void> {
  await tx(HANDLES, 'readwrite', (s) => s.delete(key));
}

/** Ask the browser not to evict us under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

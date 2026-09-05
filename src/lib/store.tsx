import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { emptyLibrary, type Library, type Setlist, type Song } from '../types';
import { mergeScan, isProjectScaffolding, newestSetPerFolder, parseFileName, syncSetlists, type ScanResult } from './scan';
import { parseAls, type AlsProject } from './alsParser';
import { findPrints, isPrint, isPreparedSet, type FoundPrint } from './prints';
import { applyManifest, isManifestName } from './preparedSet';
import { versionsOf } from './versions';
import { setlistFromProject, songsFromProject } from './alsImport';
import * as source from './source';
import * as local from './localSource';
import { normalisePath } from './paths.ts';

/**
 * Library state, persisted to localStorage for instant startup and written to
 * `<root>/.rehearsal-tool.json` in the folder, which is where it lives.
 */

const LIBRARY_FILE = '.rehearsal-tool.json';
// What the file was called before the app was renamed. Read when the new
// name is not there yet; never written, so a folder moves over on first save.
const LEGACY_LIBRARY_FILE = '.learning-songs.json';
const LS_LIBRARY = 'ls.library';
const LS_REV = 'ls.libraryRev';
const LS_SETTINGS = 'ls.settings';
/** The set being worked on. Session-scoped: every launch asks again. */
const SS_SET = 'ls.currentSet';
/** Every set the last scan found, whether or not its songs have audio here. */
const LS_SETS = 'ls.knownSets';
const PUSH_DEBOUNCE_MS = 1500;

export interface Settings {
  /**
   * A path prefix the library's ids are built under. '' for the folder itself,
   * which is what the studio uses; kept so a library made under a prefix still
   * reads.
   */
  root: string;
  /** Render cache budget in GB. */
  cacheBudgetGB: number;
  /**
   * How much memory the songs of a run may hold between them, in GB.
   *
   * Decoded audio is far larger than the files it came from, so keeping a
   * whole set ready is the one thing in the studio that can exhaust a machine.
   * Past this, the songs least recently played are let go and built again if
   * the run comes back round to them.
   */
  runMemoryGB: number;
  /** Bar jump sizes offered in the transport. */
  jumpSizes: number[];
  /** Keep the screen awake while playing. */
  keepAwake: boolean;
  /** Read from the chosen folder on this machine. */
  useLocal: boolean;
  /**
   * The output device to play out of, where the browser lets a page choose.
   * Kept with its label as well as its id: ids are opaque, and a device that
   * has gone missing is worth naming rather than showing as a code.
   */
  outputDevice: { id: string; label: string } | null;
}

const DEFAULT_SETTINGS: Settings = {
  root: '',
  cacheBudgetGB: 1,
  runMemoryGB: 4,
  jumpSizes: [1, 4, 8, 16],
  keepAwake: true,
  useLocal: false,
  outputDevice: null,
};

/** Settings saved by earlier builds, which named their source differently. */
function migrateSettings(raw: Partial<Settings> & { sourceKind?: string }): Partial<Settings> {
  if (raw.sourceKind && raw.useLocal === undefined) {
    return { ...raw, useLocal: raw.sourceKind === 'local' };
  }
  return raw;
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'disconnected';

/**
 * Only a song that came from a set is a song here. The folder holds Ableton
 * projects; every loose audio file in it is a stem, a bounce, a slate or a
 * sample. A library written by an earlier build that scanned by file name
 * still carries those, so they are dropped wherever a library comes in.
 */
function setSongsOnly(lib: Library): Library {
  const songs = lib.songs.filter((s) => s.id.startsWith('als:'));
  return songs.length === lib.songs.length ? lib : { ...lib, songs };
}

/** One entry per set the library knows, named after its file. */
export interface KnownSet {
  path: string;
  name: string;
  songs: number;
  /** How many of those have their audio in the folder. */
  withAudio: number;
}

/** How the folder stands: none chosen, chosen but switched off, or reading. */
export type LocalStatus = 'off' | 'not-picked' | 'ready';

interface StoreValue {
  library: Library;
  settings: Settings;
  syncState: SyncState;
  syncError: string | null;
  scanning: boolean;
  scanProgress: string;
  lastScan: ScanResult | null;
  localStatus: LocalStatus;
  localFolderName: string | null;
  /** The set everything on screen is about, as its path in the folder. */
  currentSet: string | null;
  /** The sets the library knows, for choosing between. */
  sets: KnownSet[];
  chooseSet: (path: string | null) => void;
  saveSettings: (patch: Partial<Settings>) => void;
  updateSong: (id: string, patch: Partial<Song>) => void;
  updateSetlist: (id: string, patch: Partial<Setlist>) => void;
  createSetlist: (name: string) => Setlist;
  deleteSetlist: (id: string) => void;
  /** Read the folder again: every set in it, and drop a song whose files have gone. */
  rescan: () => Promise<void>;
  /** `replace` takes the folder's library whole, discarding what is held here. */
  pullNow: (opts?: { replace?: boolean }) => Promise<void>;
  /** Choose the synced folder on this machine. Must come from a click. */
  pickLocalFolder: () => Promise<void>;
  /** The band's folder, which the studio publishes into. Chosen separately. */
  publishFolderName: string | null;
  /** A folder a set's samples live in outside the project, read only. */
  resourcesFolderName: string | null;
  pickResourcesFolder: (startIn?: string) => Promise<void>;
  pickPublishFolder: () => Promise<local.FolderHandle>;
  publishFolder: () => Promise<local.FolderHandle | null>;
  stopUsingLocalFiles: () => void;
  forgetLocalFolder: () => Promise<void>;
  dismissScanResult: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>');
  return ctx;
}

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function libraryPath(root: string): string {
  const r = normalisePath(root);
  return `${r}/${LIBRARY_FILE}`;
}

function legacyLibraryPath(root: string): string {
  return `${normalisePath(root)}/${LEGACY_LIBRARY_FILE}`;
}

/**
 * Merge two versions of the library, preferring whichever copy of each song or
 * setlist was edited most recently. Used when another device wrote first.
 */
function mergeLibraries(mine: Library, theirs: Library): Library {
  const songs = new Map<string, Song>();
  for (const song of theirs.songs) songs.set(song.id, song);
  for (const song of mine.songs) {
    const other = songs.get(song.id);
    if (!other || song.updatedAt >= other.updatedAt) songs.set(song.id, song);
  }

  const setlists = new Map<string, Setlist>();
  for (const sl of theirs.setlists) setlists.set(sl.id, sl);
  for (const sl of mine.setlists) {
    const other = setlists.get(sl.id);
    if (!other || sl.updatedAt >= other.updatedAt) setlists.set(sl.id, sl);
  }

  return {
    version: 1,
    root: mine.root || theirs.root,
    songs: [...songs.values()].sort(
      (a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title),
    ),
    setlists: [...setlists.values()],
    updatedAt: Math.max(mine.updatedAt, theirs.updatedAt),
  };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<Library>(() => setSongsOnly(loadLocal(LS_LIBRARY, emptyLibrary())));
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...migrateSettings(loadLocal(LS_SETTINGS, {} as Partial<Settings>)),
  }));
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState('');
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalStatus>('off');
  const [localFolderName, setLocalFolderName] = useState<string | null>(null);
  const [publishFolderName, setPublishFolderName] = useState<string | null>(null);
  const [resourcesFolderName, setResourcesFolderName] = useState<string | null>(null);
  const [currentSet, setCurrentSet] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(SS_SET);
    } catch {
      return null;
    }
  });

  const [knownSets, setKnownSets] = useState<{ path: string; name: string }[]>(() =>
    loadLocal(LS_SETS, []),
  );
  useEffect(() => {
    localStorage.setItem(LS_SETS, JSON.stringify(knownSets));
  }, [knownSets]);

  const chooseSet = useCallback((path: string | null) => {
    setCurrentSet(path);
    try {
      if (path) sessionStorage.setItem(SS_SET, path);
      else sessionStorage.removeItem(SS_SET);
    } catch {
      /* a session that can't remember still works */
    }
  }, []);

  /*
   * A set is a set whether or not its stems are here: it can still be checked,
   * given slates and chords, its setlist printed. So the list is what the
   * scan found, with the songs that did get audio counted against each; a
   * set the songs remember but the last scan did not see is kept too.
   */
  const sets = useMemo<KnownSet[]>(() => {
    const counts = new Map<string, { songs: number; withAudio: number }>();
    for (const song of library.songs) {
      if (!song.setPath) continue;
      const c = counts.get(song.setPath) ?? { songs: 0, withAudio: 0 };
      c.songs += 1;
      if (song.variants.length) c.withAudio += 1;
      counts.set(song.setPath, c);
    }
    const nameOf = (path: string) => path.split('/').pop()!.replace(/\.als$/i, '');
    const all = new Map<string, KnownSet>();
    for (const { path, name } of knownSets) {
      all.set(path, { path, name, ...(counts.get(path) ?? { songs: 0, withAudio: 0 }) });
    }
    for (const [path, c] of counts) {
      if (!all.has(path)) all.set(path, { path, name: nameOf(path), ...c });
    }
    return [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [library.songs, knownSets]);

  const revRef = useRef<string | null>(localStorage.getItem(LS_REV));
  const pushTimer = useRef<number | null>(null);
  const dirty = useRef(false);

  /** Single place errors are surfaced. The raw object stays in the console. */
  const reportError = useCallback((err: unknown) => {
    console.error('[rehearsal-tool-studio]', err);
    setSyncState('error');
    setSyncError(err instanceof Error ? err.message : String(err));
  }, []);

  /* ------------------------------ where we read ----------------------------- */

  /**
   * Point the source layer at the folder the server remembers.
   *
   * The studio runs on the machine the sets live on, so the folder on disk
   * is the whole of it. That folder is inside Dropbox and the desktop client
   * syncs it, which is how the studio's work reaches the band — no API, no
   * sign-in, and none of the ways a download can fail to arrive.
   */
  const applySource = useCallback(async () => {
    const base = { root: settings.root };

    // Look the folder up even when it's switched off, so its name still shows
    // and the switch can be turned back on without picking it again.
    const stored = await local.storedFolder();
    setLocalFolderName(stored?.name ?? null);

    if (!stored) {
      source.configureSource({ ...base, useLocal: false, folder: null });
      setLocalStatus('not-picked');
      return;
    }
    if (!settings.useLocal) {
      source.configureSource({ ...base, useLocal: false, folder: null });
      setLocalStatus('off');
      return;
    }
    source.configureSource({ ...base, useLocal: true, folder: stored.handle });
    setLocalStatus('ready');
  }, [settings.useLocal, settings.root]);

  useEffect(() => {
    void applySource();
  }, [applySource]);

  useEffect(() => {
    void local.storedFolder('publish').then((f) => setPublishFolderName(f?.name ?? null));
    void local.storedFolder('resources').then((f) => setResourcesFolderName(f?.name ?? null));
  }, []);

  const pickLocalFolder = useCallback(async () => {
    const folder = await local.pickFolder();
    source.configureSource({ root: settings.root, useLocal: true, folder: folder.handle });
    setLocalFolderName(folder.name);
    setLocalStatus('ready');
    setSettings((prev) => ({ ...prev, useLocal: true }));
  }, [settings.root]);

  /** Stop reading from disk, but remember which folder it was. */
  const stopUsingLocalFiles = useCallback(() => {
    source.configureSource({ root: settings.root, useLocal: false, folder: null });
    setLocalStatus('off');
    setSettings((prev) => ({ ...prev, useLocal: false }));
  }, [settings.root]);

  /** Forget the folder entirely, so the picker starts fresh. */
  const forgetLocalFolder = useCallback(async () => {
    await local.forgetFolder();
    source.configureSource({ root: settings.root, useLocal: false, folder: null });
    setLocalFolderName(null);
    setLocalStatus('not-picked');
    setSettings((prev) => ({ ...prev, useLocal: false }));
  }, [settings.root]);

  /* ------------------------------ local persist ----------------------------- */

  useEffect(() => {
    localStorage.setItem(LS_LIBRARY, JSON.stringify(library));
  }, [library]);

  useEffect(() => {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }, [settings]);

  /* ------------------------------ writing it back --------------------------- */

  const push = useCallback(
    async (lib: Library) => {
      if (!source.canRead()) return;
      setSyncState('syncing');
      setSyncError(null);
      // Always the folder currently being scanned — a stale `lib.root` would
      // write one folder's library into another's.
      const path = libraryPath(settings.root);
      try {
        let result = await source.writeJson(path, lib, revRef.current);
        if (!result.ok) {
          // Something else wrote first — merge that copy in and retry once.
          const remote = await source.readJson<Library>(path);
          if (remote) {
            const merged = mergeLibraries(lib, remote.data);
            revRef.current = remote.rev;
            setLibrary(merged);
            result = await source.writeJson(path, merged, remote.rev);
          }
        }
        if (result.ok) {
          revRef.current = result.rev;
          localStorage.setItem(LS_REV, result.rev);
          dirty.current = false;
          setSyncState('idle');
        } else {
          setSyncState('error');
          setSyncError('Could not resolve a sync conflict — try again.');
        }
      } catch (err) {
        reportError(err);
      }
    },
    [settings.root],
  );

  const schedulePush = useCallback(
    (lib: Library) => {
      dirty.current = true;
      if (pushTimer.current) window.clearTimeout(pushTimer.current);
      pushTimer.current = window.setTimeout(() => void push(lib), PUSH_DEBOUNCE_MS);
    },
    [push],
  );

  /** Apply a change locally, then sync it. */
  const commit = useCallback(
    (fn: (lib: Library) => Library) => {
      setLibrary((prev) => {
        const next = fn(prev);
        next.updatedAt = Date.now();
        schedulePush(next);
        return next;
      });
    },
    [schedulePush],
  );

  /* ------------------------------- reading it in ---------------------------- */

  /**
   * Read the library out of the folder.
   *
   * Ordinarily a merge, which is what keeps this window from overwriting what
   * was typed elsewhere. `replace` throws that away and takes the folder's copy.
   *
   * That option exists because a merge can only ever add. A song is kept
   * whether it is in the folder's copy or only in this browser's, so a song
   * that has been removed — or a whole library that now belongs to a different
   * folder — has no way of going. Nothing in the file says "this is gone", so
   * the only honest answer is to be able to say "forget what you have".
   */
  const pullNow = useCallback(
    async ({ replace = false } = {}) => {
      if (!source.canRead()) return;
      setSyncState('syncing');
      try {
        const path = libraryPath(settings.root);
        const remote =
          (await source.readJson<Library>(path)) ??
          (await source.readJson<Library>(legacyLibraryPath(settings.root)));
        if (remote) {
          revRef.current = remote.rev;
          if (remote.rev) localStorage.setItem(LS_REV, remote.rev);
          const theirs = setSongsOnly(remote.data);
          setLibrary((prev) => {
            if (replace) return theirs;
            const merged = mergeLibraries(prev, theirs);
            // Only write back if our local copy actually contributed something
            // — which includes having dropped what was never a song.
            if (JSON.stringify(merged) !== JSON.stringify(remote.data)) schedulePush(merged);
            return merged;
          });
        }
        setSyncState('idle');
        setSyncError(null);
      } catch (err) {
        reportError(err);
      }
    },
    [settings.root, schedulePush],
  );

  /**
   * Pointing at a different folder means a different library entirely — a band's
   * own folder, or another project. Start clean rather than merging, so one
   * group's songs can never leak into another group's `.rehearsal-tool.json`.
   */
  useEffect(() => {
    const wanted = normalisePath(settings.root);
    if (normalisePath(library.root) === wanted) return;
    if (dirty.current) return; // let an in-flight save finish first
    revRef.current = null;
    localStorage.removeItem(LS_REV);
    setLibrary(emptyLibrary(wanted));
    if (source.localReady()) void pullNow();
    // Only react to the chosen folder changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.root]);

  /*
   * Read the library once the folder is ready, and whenever the window comes
   * back. Everything typed rather than derived — tempos, markers, keys, patch
   * changes — lives only in that file, so starting from whatever the browser
   * happened to be holding is starting from the past.
   */
  const canReadLibrary = localStatus === 'ready';
  useEffect(() => {
    if (!canReadLibrary) return;
    void pullNow();
    const onFocus = () => {
      if (document.visibilityState === 'visible' && !dirty.current) void pullNow();
    };
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
    // Deliberately runs only when that changes; pullNow is stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReadLibrary]);

  // Flush any pending write before the page goes away.
  useEffect(() => {
    const onHide = () => {
      if (dirty.current && pushTimer.current) {
        window.clearTimeout(pushTimer.current);
        void push(library);
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [library, push]);

  /* --------------------------------- actions -------------------------------- */

  const updateSong = useCallback(
    (id: string, patch: Partial<Song>) => {
      commit((lib) => ({
        ...lib,
        songs: lib.songs.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s)),
      }));
    },
    [commit],
  );

  const updateSetlist = useCallback(
    (id: string, patch: Partial<Setlist>) => {
      commit((lib) => ({
        ...lib,
        setlists: lib.setlists.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s)),
      }));
    },
    [commit],
  );

  const createSetlist = useCallback(
    (name: string): Setlist => {
      const setlist: Setlist = {
        id: `sl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        songIds: [],
        updatedAt: Date.now(),
      };
      commit((lib) => ({ ...lib, setlists: [...lib.setlists, setlist] }));
      return setlist;
    },
    [commit],
  );

  const deleteSetlist = useCallback(
    (id: string) => {
      commit((lib) => ({ ...lib, setlists: lib.setlists.filter((s) => s.id !== id) }));
    },
    [commit],
  );

  const saveSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const rescan = useCallback(async () => {
    if (!source.canRead()) return;
    setScanning(true);
    setScanProgress('Listing files…');
    setLastScan(null);
    try {
      const files = await source.listAll((count) => setScanProgress(`Found ${count} files…`));

      /*
       * Read any Ableton sets first. A set knows which audio belongs to which
       * song, along with its tempo map, sections and key, so it takes charge of
       * the files it names and the folder scan skips them.
       */
      // Backups and archives hold dozens of copies of the same set; reading
      // them would be slow and would import every song several times over.
      // Prints the app made are attached to their songs afterwards, not scanned
      // as songs of their own.
      const usable = files.filter((f) => !isProjectScaffolding(f.path) && !isPrint(f.path));
      const prints = findPrints(files);
      // Facts a prepared set's folder names have no room for.
      const manifests = files.filter((f) => isPreparedSet(f.path) && isManifestName(f.name));
      const setFiles = newestSetPerFolder(usable);
      setKnownSets(setFiles.map((f) => ({ path: f.path, name: f.name.replace(/\.als$/i, '') })));
      /* Sets that couldn't be read at all; the rest of the notes come later. */
      const readErrors: string[] = [];

      /*
       * Parsed here, turned into songs later.
       *
       * Building them now would mean merging them against the library as it was
       * when this callback was made rather than as it is — and a song from a
       * set is rebuilt wholesale each scan, keeping only what the *previous*
       * copy carried. Anything saved since, patch changes included, was thrown
       * away by a scan that had never seen it.
       */
      const parsedSets: { path: string; project: AlsProject }[] = [];
      for (const [index, file] of setFiles.entries()) {
        setScanProgress(`Reading Ableton set ${index + 1} of ${setFiles.length}…`);
        try {
          const { bytes } = await source.readBytes(file.path);
          parsedSets.push({ path: file.path, project: await parseAls(bytes) });
        } catch (err) {
          console.error('[rehearsal-tool-studio] could not read', file.path, err);
          readErrors.push(`${file.name} could not be read`);
        }
      }

      /*
       * Read before the library is built, since applying them is synchronous
       * inside the state update and reading a file is not.
       */
      const manifestDocs: { path: string; data: unknown }[] = [];
      for (const file of manifests) {
        try {
          const doc = await source.readJson<unknown>(file.path);
          if (doc) manifestDocs.push({ path: file.path, data: doc.data });
        } catch (err) {
          console.error('[rehearsal-tool-studio] could not read', file.path, err);
        }
      }

      setScanProgress('Matching variants…');
      setLibrary((prev) => {
        // Against the library as it is now, not as it was when the scan began.
        const known = new Map(prev.songs.map((s) => [s.id, s]));
        const claimed = new Set<string>();
        const alsNotes = [...readErrors];
        const alsSongs: Song[] = [];
        for (const { path, project } of parsedSets) {
          const imported = songsFromProject(project, path, usable, known);
          alsSongs.push(...imported.songs);
          for (const p of imported.claimedPaths) claimed.add(p);
          if (imported.missing.length) {
            alsNotes.push(
              `${imported.missing.length} song${imported.missing.length === 1 ? '' : 's'} in ` +
                `${path.split('/').pop()} have no audio here yet`,
            );
          }
        }

        /*
         * Nothing is scanned by file name. The folder holds Ableton projects,
         * and every audio file in it is a stem, a bounce or a sample — not a
         * song. Songs are what the locators say they are; the folder scan is
         * asked only to carry the library's own edits across.
         */
        const result = mergeScan(prev, [], settings.root, claimed);
        // Songs from a set replace whatever was there under the same id.
        const merged = new Map(result.library.songs.map((s) => [s.id, s]));
        for (const song of alsSongs) merged.set(song.id, song);
        attachPrints([...merged.values()], prints, merged);
        for (const doc of manifestDocs) {
          const { errors } = applyManifest([...merged.values()], doc.path, doc.data);
          // A hand-written manifest with a typo should say so, not vanish.
          if (errors?.length) {
            console.warn(`${doc.path}: ${errors.join('; ')}`);
            result.skippedSamples.push(`${doc.path} — ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
          }
        }
        const songs = [...merged.values()]
          .filter((s) => s.id.startsWith('als:'))
          .sort(
            (a, b) =>
              (a.artist ?? '').localeCompare(b.artist ?? '') || a.title.localeCompare(b.title),
          );
        /*
         * One running order per set, built once the library is whole so a song
         * the set names counts whether it arrived in this scan or an earlier
         * one. An empty one is dropped: a setlist named after a set the library
         * knows nothing about helps nobody.
         */
        const live = new Set(songs.map((s) => s.id));
        const alsSetlists = parsedSets
          .map(({ path, project }) => setlistFromProject(path, project, (id) => live.has(id)))
          .filter((sl) => sl.songIds.length > 0);

        result.library = {
          ...result.library,
          songs,
          setlists: syncSetlists(result.library.setlists, alsSetlists, live),
        };
        result.sourceLabel = source.describeSource();
        result.alsSets = setFiles.length;
        result.alsSetPaths = setFiles.map((f) => f.path);
        result.alsSongs = alsSongs.length;
        result.alsSetlists = alsSetlists.length;
        result.alsNotes = alsNotes;
        setLastScan(result);
        schedulePush(result.library);
        return result.library;
      });
      setScanProgress('');
    } catch (err) {
      reportError(err);
      setScanProgress('');
    } finally {
      setScanning(false);
    }
  }, [settings.root, schedulePush]);

  /*
   * The folder is the truth, so it is read on every launch: every set in it,
   * fresh, with whatever a newer build now makes of them. A library left in
   * the file by an older build is replaced rather than trusted. Once per
   * page, after the file has been read, and only when there is a folder.
   */
  const scannedOnLoad = useRef(false);
  useEffect(() => {
    if (!canReadLibrary || scannedOnLoad.current) return;
    scannedOnLoad.current = true;
    void rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReadLibrary]);

  /** The band's folder, asked for once and remembered by the server. */
  const pickPublishFolder = useCallback(async () => {
    const picked = await local.pickFolder('publish');
    setPublishFolderName(picked.name);
    return picked.handle;
  }, []);

  const pickResourcesFolder = useCallback(async (startIn?: string) => {
    const picked = await local.pickFolder('resources', { startIn });
    setResourcesFolderName(picked.name);
  }, []);

  const publishFolder = useCallback(async () => {
    const stored = await local.storedFolder('publish');
    if (!stored) return null;
    setPublishFolderName(stored.name);
    return stored.handle;
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      library,
      settings,
      syncState,
      syncError,
      scanning,
      scanProgress,
      lastScan,
      localStatus,
      localFolderName,
      currentSet,
      sets,
      chooseSet,
      saveSettings,
      updateSong,
      updateSetlist,
      createSetlist,
      deleteSetlist,
      rescan,
      pullNow,
      pickLocalFolder,
      publishFolderName,
      pickPublishFolder,
      publishFolder,
      resourcesFolderName,
      pickResourcesFolder,
      stopUsingLocalFiles,
      forgetLocalFolder,
      dismissScanResult: () => setLastScan(null),
    }),
    [
      library, settings, syncState, syncError, scanning,
      scanProgress, lastScan, saveSettings, updateSong, updateSetlist, createSetlist, deleteSetlist,
      rescan, pullNow, localStatus, localFolderName, currentSet, sets, chooseSet,
      pickLocalFolder, stopUsingLocalFiles, forgetLocalFolder,
      publishFolderName, pickPublishFolder, publishFolder, resourcesFolderName, pickResourcesFolder,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/**
 * Put prints back with the song and version they were made from.
 *
 * Matched by name, since a print no longer lives beside what it came from: the
 * file name gives the song, and the folder under "Rehearsal Tool" gives the
 * version. A print whose version can't be placed still joins the song — better
 * grouped roughly than lost entirely.
 */
function attachPrints(songs: Song[], prints: FoundPrint[], into: Map<string, Song>): void {
  if (!prints.length) return;
  const byTitle = new Map<string, Song[]>();
  for (const song of songs) {
    const key = song.title.trim().toLowerCase();
    const list = byTitle.get(key);
    if (list) list.push(song);
    else byTitle.set(key, [song]);
  }

  for (const print of prints) {
    const candidates = byTitle.get(print.title.trim().toLowerCase());
    if (!candidates?.length) continue;
    const song = candidates[0];

    const versions = versionsOf(song.variants, song.title);
    const wanted = print.versionName.trim().toLowerCase();
    const version = versions.find((v) => v.name.trim().toLowerCase() === wanted) ?? versions[0];

    const id = print.file.path.toLowerCase();
    if (song.variants.some((v) => v.id === id)) continue;

    const { label } = parseFileName(print.file.name.replace(/\.[^.]+$/, ''));
    into.set(song.id, {
      ...song,
      variants: [
        ...song.variants,
        {
          id,
          name: label,
          role: 'mix',
          path: print.file.path,
          rev: print.file.rev,
          sizeBytes: print.file.size,
          order: song.variants.length,
          // Prints sit outside the project, so they name the version they join.
          versionId: version?.id,
        },
      ],
      updatedAt: song.updatedAt,
    });
  }
}

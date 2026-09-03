import { useSyncExternalStore } from 'react';
import type { Library, SongId } from '../types';
import { setlistIdFor } from './alsImport.ts';

/**
 * A run: several songs opened together and kept loaded, stepped through in
 * order.
 *
 * Opening a song decodes every one of its parts, which for a set of WAV stems
 * is seconds of work — fine once, tiresome as the only way to get from song
 * three to song four in a rehearsal. A run says up front which songs the next
 * hour is about, so they can be made ready ahead of time and held that way:
 * Previous and Next then cost nothing but rebuilding the audio graph.
 *
 * It is a thing of the session, not of the library. It is not written to the
 * folder, nothing syncs it, and it lasts until the songs are opened some other
 * way — which is also what ends it, since a run you didn't ask for silently
 * governing Next is worse than no run at all.
 */

export interface Run {
  songIds: SongId[];
  /** The setlist the order came from, when one did. */
  setlistId: string | null;
}

const EMPTY: Run = { songIds: [], setlistId: null };

/** Survives a reload, like the chosen set does, and no longer. */
const SS_RUN = 'ls.run';

let run: Run = read();

function read(): Run {
  try {
    const raw = sessionStorage.getItem(SS_RUN);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Run;
    if (!Array.isArray(parsed?.songIds)) return EMPTY;
    return { songIds: parsed.songIds, setlistId: parsed.setlistId ?? null };
  } catch {
    return EMPTY;
  }
}

const listeners = new Set<() => void>();

function commit(next: Run): void {
  run = next;
  try {
    if (next.songIds.length) sessionStorage.setItem(SS_RUN, JSON.stringify(next));
    else sessionStorage.removeItem(SS_RUN);
  } catch {
    /* a run that doesn't survive a reload is still a run */
  }
  for (const listener of listeners) listener();
}

export function getRun(): Run {
  return run;
}

/** Open these songs together. One song is no run at all. */
export function openRun(songIds: SongId[], setlistId: string | null = null): void {
  commit(songIds.length > 1 ? { songIds: [...songIds], setlistId } : EMPTY);
}

export function closeRun(): void {
  if (run.songIds.length) commit(EMPTY);
}

export function useRun(): Run {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getRun,
    () => EMPTY,
  );
}

/** Where a song sits in the run, and what is either side of it. */
export interface RunPosition {
  index: number;
  total: number;
  prev: SongId | null;
  next: SongId | null;
}

export function positionIn(run: Run, songId: SongId): RunPosition | null {
  const index = run.songIds.indexOf(songId);
  if (index < 0) return null;
  return {
    index,
    total: run.songIds.length,
    prev: index > 0 ? run.songIds[index - 1] : null,
    next: index < run.songIds.length - 1 ? run.songIds[index + 1] : null,
  };
}

/**
 * The order to open a handful of songs in.
 *
 * Songs are picked off the Songs page, where they sit grouped by artist, but
 * the order that matters is the one they are played in — so a setlist holding
 * them decides it. The set's own running order is preferred, since that is
 * the order the night runs in; failing that, whichever setlist accounts for
 * most of the picked songs. Anything no setlist knows about keeps the order it
 * was picked in and follows on the end, so nothing is ever dropped.
 */
export function orderForRun(
  library: Library,
  currentSet: string | null,
  songIds: SongId[],
): { songIds: SongId[]; setlistId: string | null } {
  const picked = [...new Set(songIds)];
  if (picked.length < 2) return { songIds: picked, setlistId: null };

  const chosen = new Set(picked);
  const covers = (ids: SongId[]) => ids.filter((id) => chosen.has(id)).length;

  const ownId = currentSet ? setlistIdFor(currentSet) : null;
  const own = ownId ? library.setlists.find((s) => s.id === ownId) ?? null : null;

  let best = own && covers(own.songIds) > 1 ? own : null;
  if (!best) {
    for (const setlist of library.setlists) {
      const score = covers(setlist.songIds);
      // Two songs in common is the least that can express an order at all.
      if (score > 1 && score > (best ? covers(best.songIds) : 1)) best = setlist;
    }
  }
  if (!best) return { songIds: picked, setlistId: null };

  const known = best.songIds.filter((id) => chosen.has(id));
  const rest = picked.filter((id) => !best!.songIds.includes(id));
  return { songIds: [...known, ...rest], setlistId: best.id };
}

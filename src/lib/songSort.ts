import type { Song, SongId } from '../types';
import { parseKey } from './nashville.ts';

/**
 * The orders a list of songs can be put in.
 *
 * Four that answer real questions. *Set order* is the running order the songs
 * are played in — the default, since a list that starts in an order nobody
 * chose is a list you have to re-find your place in. *Name* is for finding
 * one. *Key* puts songs that would sit well together next to each other, and
 * shows the set's spread of keys at a glance. *Tempo* does the same for
 * speed, which is what a running order is often really about.
 *
 * A direction goes with the field, and is flipped by tapping the field again
 * twice — a single tap on the field already chosen leaves it alone, so a
 * stray one can't turn the list upside down.
 */

export type SortKey = 'set' | 'name' | 'key' | 'tempo';
export type SortDir = 'asc' | 'desc';

export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}

export const SORT_LABEL: Record<SortKey, string> = {
  set: 'Set order',
  name: 'Name',
  key: 'Key',
  tempo: 'Tempo',
};

export const SORT_KEYS: SortKey[] = ['set', 'name', 'key', 'tempo'];

export const DEFAULT_SORT: SortSpec = { key: 'set', dir: 'asc' };

/** Which way a tap on `key` leaves things: chosen if it wasn't, unchanged if it was. */
export function choose(current: SortSpec, key: SortKey): SortSpec {
  return current.key === key ? current : { key, dir: 'asc' };
}

/** The same field, the other way up. */
export function flip(current: SortSpec): SortSpec {
  return { ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

export function readSort(storageKey: string): SortSpec {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_SORT;
    const spec = JSON.parse(raw) as Partial<SortSpec>;
    if (!spec.key || !SORT_KEYS.includes(spec.key)) return DEFAULT_SORT;
    return { key: spec.key, dir: spec.dir === 'desc' ? 'desc' : 'asc' };
  } catch {
    return DEFAULT_SORT;
  }
}

export function rememberSort(storageKey: string, spec: SortSpec): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(spec));
  } catch {
    /* the order simply won't persist */
  }
}

/**
 * A key's place in the order keys are listed in.
 *
 * Chromatic from C, major before its parallel minor, so C, Cm, C#, C#m, D…
 * A key the parser can't read sorts after every one it can, whichever way up
 * the list is: "unknown" is not the highest key, it is no key.
 */
export function keyRank(key: string | undefined): number | null {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const minor = /m(in)?$/i.test(key!.trim().replace(/\s+/g, '')) && !/maj/i.test(key!);
  return parsed.tonic * 2 + (minor ? 1 : 0);
}

/**
 * The songs in the chosen order.
 *
 * `setOrder` says where each song falls in its running order; a song not in it
 * goes after those that are, by name. Ties (two songs in D, two at 120) break
 * by name so the order is stable and the same on every device. Songs with no
 * tempo or no key sit at the end in either direction.
 */
export function sortSongs(songs: Song[], spec: SortSpec, setOrder: Map<SongId, number>): Song[] {
  const sign = spec.dir === 'asc' ? 1 : -1;
  const byName = (a: Song, b: Song) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

  // A value to sort by, or null for "has none", which always sorts last.
  const value = (song: Song): number | string | null => {
    switch (spec.key) {
      case 'set':
        return setOrder.get(song.id) ?? null;
      case 'name':
        return song.title.toLowerCase();
      case 'key':
        return keyRank(song.originalKey);
      case 'tempo':
        return song.tempoUnset ? null : song.bpm;
    }
  };

  return [...songs].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return byName(a, b);
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : (va as number) - (vb as number);
    return cmp !== 0 ? sign * cmp : spec.key === 'name' ? sign * byName(a, b) : byName(a, b);
  });
}

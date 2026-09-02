/**
 * Which parts this device bothers to fetch.
 *
 * Distinct from a part being switched off in the library: that says "nobody
 * needs this", and travels with the song. This says "not on this device" — a
 * phone on mobile data wants the reference and little else, while the laptop it
 * syncs with can have all eight stems. So it lives here, per device, like the
 * faders.
 */

const LS_SKIP = 'ls.load.skip';

function read<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — the choice simply won't persist */
  }
}

/** Variant ids this device won't download. */
export function skippedFor(songId: string): string[] {
  return read<string[]>(LS_SKIP)[songId] ?? [];
}

export function setSkipped(songId: string, ids: string[]): void {
  const all = read<string[]>(LS_SKIP);
  if (ids.length) all[songId] = ids;
  else delete all[songId];
  write(LS_SKIP, all);
}

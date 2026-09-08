/**
 * Small things kept in this browser's storage, and never mind if they can't be.
 *
 * None of it is the truth — the folder is, and the set beside it — so a full
 * disk, a private window or a quota reached is a reason to carry on without
 * the convenience rather than to stop the page. That is not what used to
 * happen: an unguarded write of the library, four and a half megabytes of
 * words and chords against Safari's five, threw in the middle of drawing and
 * took the whole studio down with it.
 */

/** Keep it, or don't. Never throws. */
export function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // Out of room: the shortcut goes rather than the page.
    try {
      localStorage.removeItem(key);
    } catch {
      /* not even that; there is nothing else to be done about it */
    }
  }
}

/** Forget it, or don't. Never throws. */
export function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* as above */
  }
}

/** What was kept, or the fallback — for storage that is blocked as well as full. */
export function remembered<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

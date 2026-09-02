/**
 * Which parts of the chart this device wants to see.
 *
 * Per device rather than in the shared library, for the same reason the faders
 * are: the singer wants the words, the guitarist wants the chords, and neither
 * should be changing the other's screen. Kept out of the library file also
 * means toggling a lane doesn't count as an edit to sync.
 */

const LS_HIDDEN = 'ls.chart.hiddenLanes';
const LS_CLOSED = 'ls.chart.closed';

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
    /* storage full or blocked — the preference simply won't persist */
  }
}

/**
 * Hidden rather than shown, so a lane added to the set later — a chord track,
 * a second language — turns up rather than staying invisible until found.
 */
export function hiddenLanes(songId: string): string[] {
  return read<string[]>(LS_HIDDEN)[songId] ?? [];
}

export function setLaneHidden(songId: string, laneId: string, hidden: boolean): void {
  const all = read<string[]>(LS_HIDDEN);
  const current = new Set(all[songId] ?? []);
  if (hidden) current.add(laneId);
  else current.delete(laneId);
  if (current.size) all[songId] = [...current];
  else delete all[songId];
  write(LS_HIDDEN, all);
}

/** The chart is shown by default when a song has one. */
export function chartOpen(songId: string): boolean {
  return !read<boolean>(LS_CLOSED)[songId];
}

export function setChartOpen(songId: string, open: boolean): void {
  const all = read<boolean>(LS_CLOSED);
  if (open) delete all[songId];
  else all[songId] = true;
  write(LS_CLOSED, all);
}

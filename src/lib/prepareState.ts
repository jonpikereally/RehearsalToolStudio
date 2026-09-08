/**
 * Whether a prepare is running anywhere in the page.
 *
 * A save of the set that lands while its songs are being written must wait,
 * not start a second run over the first; the watcher asks here before it
 * acts, and the run says when it starts and ends. A module of its own so
 * the store can ask without pulling the whole of preparing in with it.
 */
let running = 0;
/**
 * How many runs have finished, counted so anything showing how far the
 * folder is behind can ask again the moment one does.
 *
 * The sync bar used to watch `prepareRunning()` every couple of seconds and
 * take true-then-false for a run having ended. A run shorter than the gap
 * between two looks — refreshing four songs' words is a second or two —
 * began and ended unseen, and the bar went on saying four songs were behind
 * after they had been written. Counted rather than watched, no run is missed
 * however quick it is.
 */
let finished = 0;
const watchers = new Set<() => void>();

export function markPrepareRunning(on: boolean): void {
  running = Math.max(0, running + (on ? 1 : -1));
  // The last run of however many overlapped: the folder is written and still.
  if (!on && running === 0) prepareFinished();
}

export function prepareRunning(): boolean {
  return running > 0;
}

/** Say the prepared folder has just been written, run or no run. */
export function prepareFinished(): void {
  finished += 1;
  for (const watcher of [...watchers]) watcher();
}

/** How many runs have finished so far; the same number until one does. */
export function preparesFinished(): number {
  return finished;
}

/** Called whenever a run finishes. Returns the way to stop being called. */
export function watchPrepares(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

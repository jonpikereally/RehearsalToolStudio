/**
 * Whether a prepare is running anywhere in the page.
 *
 * A save of the set that lands while its songs are being written must wait,
 * not start a second run over the first; the watcher asks here before it
 * acts, and the run says when it starts and ends. A module of its own so
 * the store can ask without pulling the whole of preparing in with it.
 */
let running = 0;

export function markPrepareRunning(on: boolean): void {
  running = Math.max(0, running + (on ? 1 : -1));
}

export function prepareRunning(): boolean {
  return running > 0;
}

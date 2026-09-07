import type { OutputSet } from './locatePrepared.ts';

/**
 * What the studio opened last, so a launch can offer it back.
 *
 * The chooser asks two things — where the prepared files go, and which
 * Ableton session fills them — and the usual answer to both is “the same as
 * last time”. Kept in localStorage rather than the session's own storage:
 * the point is the *next* launch, days later, not this window.
 *
 * The output is kept whole, as it was listed, so a name can be shown before
 * the band's folder has been read again; whatever comes back from the folder
 * wins once it has.
 */

const LS_OUTPUT = 'ls.recent.output';
const LS_SESSION = 'ls.recent.session';

export function recentOutput(): OutputSet | null {
  try {
    const raw = localStorage.getItem(LS_OUTPUT);
    const set = raw ? (JSON.parse(raw) as OutputSet) : null;
    return set?.folder ? set : null;
  } catch {
    return null;
  }
}

export function rememberRecentOutput(set: OutputSet): void {
  try {
    localStorage.setItem(LS_OUTPUT, JSON.stringify(set));
  } catch {
    /* a machine that can't remember still opens; it just asks every time */
  }
}

/** The last Ableton session opened, by its absolute path. */
export function recentSession(): string | null {
  try {
    return localStorage.getItem(LS_SESSION) || null;
  } catch {
    return null;
  }
}

export function rememberRecentSession(alsPath: string): void {
  try {
    localStorage.setItem(LS_SESSION, alsPath);
  } catch {
    /* as above */
  }
}

/**
 * Whether the chooser was asked for on purpose — File ▸ Open — rather than
 * met on the way in. Asked for, it always asks, however the “always open the
 * last one” settings stand: a menu item that opened nothing would be a bug.
 * Held in memory only, since a reload is a fresh launch.
 */
let asked = false;

export function askForFiles(): void {
  asked = true;
}

/** True once per ask. */
export function takeAsk(): boolean {
  const was = asked;
  asked = false;
  return was;
}

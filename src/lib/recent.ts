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
 * Whether each side is to take what it had last without asking. Kept on their
 * own rather than with the settings, because the chooser is its own window:
 * two windows holding one settings object would write over each other, and
 * these are read at a launch and set from either window.
 */
const LS_ALWAYS_OUTPUT = 'ls.always.output';
const LS_ALWAYS_SESSION = 'ls.always.session';

export interface AlwaysOpen {
  output: boolean;
  session: boolean;
}

export function alwaysOpen(): AlwaysOpen {
  try {
    return {
      output: localStorage.getItem(LS_ALWAYS_OUTPUT) === '1',
      session: localStorage.getItem(LS_ALWAYS_SESSION) === '1',
    };
  } catch {
    return { output: false, session: false };
  }
}

export function setAlwaysOpen(patch: Partial<AlwaysOpen>): AlwaysOpen {
  const now = { ...alwaysOpen(), ...patch };
  try {
    for (const [key, on] of [
      [LS_ALWAYS_OUTPUT, now.output],
      [LS_ALWAYS_SESSION, now.session],
    ] as const) {
      if (on) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    }
  } catch {
    /* nothing to remember with; the chooser simply asks every time */
  }
  return now;
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

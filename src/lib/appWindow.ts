/**
 * Which window this page is, and how it talks to the Mac app.
 *
 * The studio is one window around one page, except for the chooser: opening
 * a set is its own small window, so what is already open stays open behind
 * it and closing it changes nothing. Both windows run the same page; the
 * query says which is which, and the app carries the few messages between
 * them.
 *
 * In a plain browser there is no app to ask, so `askApp` answers false and
 * the caller does the thing in the page instead.
 */

type Handlers = Record<string, { postMessage(message: unknown): void }>;

const handler = (): Handlers[string] | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: Handlers } }).webkit?.messageHandlers?.studio;

/** Whether the page is inside the Mac app rather than a browser. */
export const inMacApp = (): boolean => !!handler();

/** Whether this window is the chooser: the small one, showing only the chooser. */
export const isChooserWindow = (): boolean => new URLSearchParams(window.location.search).has('chooser');

/** Ask the app for something. False when there is no app, so do it here. */
export function askApp(message: Record<string, unknown>): boolean {
  const studio = handler();
  if (!studio) return false;
  try {
    studio.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** Put the chooser window up, or bring it forward if it is already there. */
export const showChooser = (): boolean => askApp({ chooser: true });

/**
 * What the chooser chose, for the main window to open: the set folder whole,
 * as it was listed, and the session that fills it. Sent through the app, so
 * it must be plain data — an object and a string, nothing else.
 */
export interface Chosen {
  set: { folder: string; name: string; songs: number; preparedAt?: string; session?: string };
  session: string;
}

export const chooserChose = (chosen: Chosen): boolean => askApp({ chose: chosen });

/** The chooser's way past itself: the tools, with no set. */
export const chooserWantsTools = (): boolean => askApp({ tools: true });

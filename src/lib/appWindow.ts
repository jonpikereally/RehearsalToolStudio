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

/** Which small window this is, if it is one: the chooser, or the changes. */
export function panelWindow(): 'chooser' | 'changes' | null {
  const query = new URLSearchParams(window.location.search);
  if (query.has('chooser')) return 'chooser';
  if (query.get('window') === 'changes') return 'changes';
  return null;
}

export const isChooserWindow = (): boolean => panelWindow() === 'chooser';

/** Whether the chooser was opened to make a new set folder rather than open one. */
export const choosingNew = (): boolean => new URLSearchParams(window.location.search).has('new');

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

/*
 * What this build of the app can do.
 *
 * A message the app does not understand is dropped in silence — the page
 * asked for a window and nothing came, with nothing to say about it — and
 * the app on disk is rebuilt by hand, so it can be older than the page it is
 * showing. So the app says on load which windows it has, and anything it has
 * not claimed is done in the page instead. An app that says nothing at all
 * is one from before it could say, and is treated as having none.
 */
let known: Set<string> | null = null;
const waiting: ((panels: Set<string>) => void)[] = [];

window.addEventListener('studio:app', (e) => {
  const said = (e as CustomEvent<{ panels?: string[] }>).detail?.panels;
  known = new Set(Array.isArray(said) ? said : []);
  for (const resolve of waiting.splice(0)) resolve(known);
});

/** Wait for the app to say what it can do, or give up and take the page's way. */
export function whenAppKnown(ms = 400): Promise<Set<string>> {
  if (known) return Promise.resolve(known);
  if (!inMacApp()) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    waiting.push(resolve);
    window.setTimeout(() => resolve(known ?? new Set()), ms);
  });
}

const hasPanel = (name: string): boolean => !!known?.has(name);

/** Put the chooser window up, or bring it forward if it is already there. */
export const showChooser = (): boolean => hasPanel('chooser') && askApp({ chooser: true });

/** The same, with the new set folder already asked for. */
export const showNewSet = (): boolean => hasPanel('chooser') && askApp({ chooser: true, making: true });

/** The window of what the studio has done, save by save. */
export const showChanges = (): boolean => hasPanel('changes') && askApp({ panel: 'changes' });

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

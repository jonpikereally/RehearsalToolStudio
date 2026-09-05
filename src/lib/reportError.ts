/**
 * Errors, said somewhere they can be read.
 *
 * The Mac app has no console anyone opens, so an error thrown in the page
 * is written to the launch log through the file server, one line with the
 * stack, beside the launcher's own lines. Unhandled errors and rejections
 * go the same way. Nothing here can throw: an error in reporting an error
 * is swallowed, since there is nowhere further for it to go.
 */

export function reportError(where: string, error: unknown, extra?: string): void {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}${extra ? `\n${extra}` : ''}`
      : `${String(error)}${extra ? `\n${extra}` : ''}`;
  try {
    void fetch('/__fs/note', {
      method: 'POST',
      headers: { 'x-rehearsal-studio': 'window', 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${where} ${location.pathname}${location.search}: ${text}`.slice(0, 4000) }),
    }).catch(() => {});
  } catch {
    /* nowhere further to go */
  }
}

/** Once, at startup: every error nobody caught goes to the log too. */
export function watchErrors(): void {
  window.addEventListener('error', (e) => reportError('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('rejection', e.reason));
}

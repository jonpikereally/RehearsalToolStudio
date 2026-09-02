/** Path helpers shared by the scanner and the Dropbox client. Kept dependency-free
 *  so the scanning logic can be tested without pulling in the Dropbox SDK. */

/** Dropbox wants '' for the root, a leading slash elsewhere, and no trailing slash. */
export function normalisePath(path: string): string {
  const p = path.trim();
  if (p === '' || p === '/') return '';
  return (p.startsWith('/') ? p : '/' + p).replace(/\/+$/, '');
}

/**
 * What a prepared set's folder is called.
 *
 * By default the set's own file name and the day, which is what every set
 * was called before there was a choice. But a folder the band opens on a
 * phone wants a name that means something to them — "Friday at the Dock",
 * not the .als's file name — so the set-wide dialog offers a field, and the
 * choice is remembered here, per set, on this machine. The one-song dialog
 * reads the same memory, so a song prepared on its own lands in the same
 * folder as the rest rather than in a fresh one named for today.
 */

const LS_NAMES = 'ls.prepare.setName';

function read(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_NAMES) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Characters a folder name cannot carry, whatever the filesystem, and runs of space. */
export function safeSetName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

/** The set's file name and today, `Friday 2026-09-05`. */
export function defaultSetName(alsPath: string | null): string {
  const base = alsPath?.split('/').pop()?.replace(/\.als$/i, '') || 'Set';
  return `${base} ${new Date().toISOString().slice(0, 10)}`;
}

export function rememberedSetName(alsPath: string | null): string | null {
  if (!alsPath) return null;
  const name = read()[alsPath.toLowerCase()];
  return name ? name : null;
}

/** Remember a name for this set; an empty name forgets it, back to the default. */
export function rememberSetName(alsPath: string, name: string): void {
  const names = read();
  const clean = safeSetName(name);
  if (clean) names[alsPath.toLowerCase()] = clean;
  else delete names[alsPath.toLowerCase()];
  try {
    localStorage.setItem(LS_NAMES, JSON.stringify(names));
  } catch {
    /* the name simply won't persist beyond this run */
  }
}

/** The name to prepare under now: what was chosen for this set, else today's. */
export function setNameFor(alsPath: string | null): string {
  return rememberedSetName(alsPath) ?? defaultSetName(alsPath);
}

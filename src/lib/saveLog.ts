import { folderBaseOf } from './preparedSet.ts';
/**
 * What the studio has made of each save.
 *
 * Live saves the set every few minutes and the studio answers each one —
 * updating the band's folder, or deciding not to, or failing to. The bar
 * along the top says what is happening now and is then dismissed, which
 * leaves no answer to "what did it do while I was playing?". So each save
 * and each answer to one is written down here, with the time, and shown in
 * a window of its own.
 *
 * Kept in this machine's storage rather than the band's folder: it is a log
 * of what this studio did, not something the band reads. Held to the last
 * few hundred, newest first, so it can't grow without end.
 */

const LS_LOG = 'ls.saveLog';
const KEEP = 300;

export type NoteKind =
  /** Live saved the set. */
  | 'saved'
  /** The prepared set was written again. */
  | 'updated'
  /** Looked at and nothing needed doing. */
  | 'nothing'
  /** Left alone on purpose — never prepared, or every song would be rewritten. */
  | 'held'
  /** Stopped by hand, or it failed. */
  | 'stopped'
  | 'error'
  /** Put back as it was. */
  | 'undone';

export interface SaveNote {
  /** When it happened, as this machine's clock had it. */
  at: number;
  kind: NoteKind;
  /** The session it is about, by file name. */
  session: string;
  /** The set folder it was written into, when one was. */
  set?: string;
  /** One sentence: what happened. */
  text: string;
  /** The songs written, when any were. Older notes have only this. */
  songs?: string[];
  /**
   * Exactly which songs changed, and how: audio written again, submixes
   * written, words and sections refreshed, held back, put back… one group
   * per kind of change, each naming its songs.
   */
  groups?: SongGroup[];
  /** Song by song, what became of each part a run wrote: rendered, a pattern, copied, or skipped and why. */
  parts?: PartDetail[];
}

export interface PartDetail {
  song: string;
  rendered: string[];
  patterns: string[];
  copied: string[];
  skipped: string[];
}

/** One PartDetail per song across the passes of a run (stems, then submixes), skips included. */
export function partDetail(
  ...runs: ({ partsBySong?: { song: string; rendered: string[]; patterns: string[]; copied: string[] }[]; skipped?: { song: string; part: string; reason: string }[] } | null | undefined)[]
): PartDetail[] {
  const by = new Map<string, PartDetail>();
  const of = (song: string) => {
    let d = by.get(song);
    if (!d) by.set(song, (d = { song, rendered: [], patterns: [], copied: [], skipped: [] }));
    return d;
  };
  for (const run of runs) {
    for (const p of run?.partsBySong ?? []) {
      const d = of(p.song);
      d.rendered.push(...p.rendered);
      d.patterns.push(...p.patterns);
      d.copied.push(...p.copied);
    }
    for (const k of run?.skipped ?? []) of(k.song).skipped.push(`${k.part} (${k.reason})`);
  }
  return [...by.values()];
}

export interface SongGroup {
  label: string;
  songs: string[];
}

/** The groups worth saying: those with songs in them, each song once. */
export function songGroups(...pairs: [string, readonly string[] | null | undefined][]): SongGroup[] {
  return pairs
    .map(([label, songs]) => ({ label, songs: [...new Set(songs ?? [])] }))
    .filter((g) => g.songs.length);
}

/** The songs a run moved aside, by name: those it wrote over (`kept`) or added (`!kept`). */
export function asideSongs(aside: readonly { folder: string; kept: boolean }[] | null | undefined, kept?: boolean): string[] {
  return [...new Set((aside ?? []).filter((a) => kept === undefined || a.kept === kept).map((a) => folderBaseOf(a.folder)))];
}

/** Every note, newest first. */
export function saveNotes(): SaveNote[] {
  try {
    const raw = localStorage.getItem(LS_LOG);
    const list = raw ? (JSON.parse(raw) as SaveNote[]) : [];
    return Array.isArray(list) ? list.filter((n) => n && typeof n.at === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * Write one down. The same answer to the same save is not written twice —
 * a bar that re-renders should not become a log of its own re-renders — so
 * a note matching the newest one, save and kind alike, replaces it.
 */
export function note(entry: Omit<SaveNote, 'at'> & { at?: number }): void {
  const now: SaveNote = { at: entry.at ?? Date.now(), ...entry } as SaveNote;
  try {
    const list = saveNotes();
    const newest = list[0];
    const same = newest && newest.kind === now.kind && newest.session === now.session && newest.text === now.text;
    const kept = same ? list.slice(1) : list;
    localStorage.setItem(LS_LOG, JSON.stringify([now, ...kept].slice(0, KEEP)));
    // The window showing the log is another window: tell it there is more.
    window.dispatchEvent(new CustomEvent('studio:note'));
  } catch {
    /* nothing to remember with; the studio still works, it just forgets */
  }
}

export function clearNotes(): void {
  try {
    localStorage.removeItem(LS_LOG);
    window.dispatchEvent(new CustomEvent('studio:note'));
  } catch {
    /* as above */
  }
}

import type { AbleSetEntry } from './ableset';
import { forget, remember, remembered } from './remember';

/**
 * An AbleSet setlist chosen by hand, on the Setlists page, for one set.
 *
 * Finding the setlist on its own — the file AbleSet has loaded, its skips
 * from its log — guesses at a format AbleSet does not document, and a guess
 * can be wrong. This is the way round it: a setlist file picked by a person,
 * whose order and songs are the show, and nothing AbleSet's log says or its
 * other setlists hold is let overrule it. Kept on this Mac, set by set, until
 * cleared.
 *
 * The entries are kept as the file had them, so the choice holds when the
 * file is somewhere the studio cannot read again; when a file of the same
 * name sits beside the set, the scan reads that afresh instead, so a setlist
 * saved again in AbleSet still comes through.
 */
export interface ChosenSetlist {
  /** The setlist's name: its file's, without `.json`. */
  name: string;
  entries: AbleSetEntry[];
  /** When it was chosen. */
  at: number;
}

const key = (setPath: string) => `rts.chosenSetlist.${setPath.replace(/^\/+/, '').toLowerCase()}`;

export function chosenSetlistFor(setPath: string): ChosenSetlist | null {
  const kept = remembered<ChosenSetlist | null>(key(setPath), null);
  return kept && typeof kept.name === 'string' && Array.isArray(kept.entries) ? kept : null;
}

export function chooseSetlist(setPath: string, chosen: ChosenSetlist): void {
  remember(key(setPath), chosen);
}

export function clearChosenSetlist(setPath: string): void {
  forget(key(setPath));
}

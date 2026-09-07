import type { AlsProject } from './alsParser';
import { songKey } from './alsParser.ts';
import type { FileEntry } from './files';
import type { Library, SongId } from '../types';
import { setlistIdFor } from './alsImport.ts';
import { abletLive } from './source.ts';

/**
 * The running order, from AbleSet.
 *
 * AbleSet is what runs the show from this set, and its setlist — not the
 * arrangement — is the order the songs are played in. It keeps that beside
 * the set, under `AbleSet/Setlists/`, one JSON file per setlist: a list of
 * the song locators in order, each by its id, its position in beats and the
 * name it last had. The Studio matches those to the set's own songs by
 * position first, which is exact, and by name when a locator has moved;
 * anything the setlist leaves out follows in arrangement order, so a song
 * added to the set since is not lost, only last.
 *
 * Where AbleSet keeps several setlists for one set, the newest saved is
 * taken as the one being played, and the scan says which.
 */

export const ABLESET_SETLISTS = 'AbleSet/Setlists';

export interface AbleSetEntry {
  /** The locator's position, in beats from the start of the set. */
  time: number;
  name: string;
}

/** The setlist files beside a set, newest saved first. */
export function abletSetlistFiles(files: FileEntry[], alsPath: string): FileEntry[] {
  const dir = alsPath.slice(0, alsPath.lastIndexOf('/') + 1).toLowerCase();
  const under = `${dir}${ABLESET_SETLISTS.toLowerCase()}/`;
  return files
    .filter((f) => f.path.toLowerCase().startsWith(under) && f.name.toLowerCase().endsWith('.json'))
    .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
}

/** What a setlist file holds, or null when it isn't one. */
export function parseAbleSetSetlist(raw: unknown): AbleSetEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AbleSetEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { time, lastKnownName } = item as { time?: unknown; lastKnownName?: unknown };
    if (typeof time !== 'number') return null;
    out.push({ time, name: typeof lastKnownName === 'string' ? lastKnownName : '' });
  }
  return out;
}

/**
 * The set's songs in the setlist's order, by title.
 *
 * A locator's beat is the song's start bar, converted; a count-in locator
 * repeating its song's title sits a bar or two before it and is not what
 * AbleSet points at, so the match is on the exact beat first and the name
 * only after. Each song is placed once; songs the setlist never names come
 * after, as the set has them.
 */
export function orderFromAbleSet(project: AlsProject, entries: AbleSetEntry[]): string[] {
  const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
  const songs = project.songs.map((song, index) => ({
    song,
    index,
    beat: (song.startBar - 1) * beatsPerBar,
    key: songKey(song.title),
  }));
  const placed = new Set<number>();
  const order: string[] = [];
  const take = (index: number) => {
    placed.add(index);
    if (!order.includes(songs[index].song.title)) order.push(songs[index].song.title);
  };
  for (const entry of entries) {
    const byBeat = songs.find((s) => !placed.has(s.index) && Math.abs(s.beat - entry.time) < 1e-3);
    if (byBeat) {
      take(byBeat.index);
      continue;
    }
    const key = songKey(entry.name);
    const byName = key ? songs.find((s) => !placed.has(s.index) && s.key === key) : undefined;
    if (byName) take(byName.index);
  }
  for (const s of songs) if (!placed.has(s.index)) take(s.index);
  return order;
}

/**
 * The order a set's songs are played in, as the library has it: the set's
 * own setlist, which follows AbleSet's when the project keeps one. Titles,
 * for the preparer; null when the library has no such setlist.
 */
export function runningOrderTitles(library: Library, alsPath: string): string[] | null {
  const setlist = library.setlists.find((sl) => sl.id === setlistIdFor(alsPath));
  if (!setlist) return null;
  const titleOf = new Map<SongId, string>(library.songs.map((s) => [s.id, s.title]));
  return setlist.songIds.map((id) => titleOf.get(id)).filter((t): t is string => !!t);
}

/** A running order and where it came from. */
export interface RunningOrder {
  titles: string[];
  note: string;
}

/**
 * The running order AbleSet has for this set right now, when it is newer
 * than anything saved: what its log says it sent itself last, provided the
 * project it has open is this one. `savedAt` is the newest saved setlist's
 * time, against which the log's date is held; a saved file that is newer
 * is the truth, and the log is then let be.
 */
export async function liveRunningOrder(
  project: AlsProject,
  alsPath: string,
  savedAt: number | null,
): Promise<RunningOrder | null> {
  let live;
  try {
    live = await abletLive(alsPath);
  } catch {
    return null;
  }
  if (!live.found || !live.applies || !live.entries?.length) return null;
  const at = live.at ? Date.parse(live.at) : NaN;
  /*
   * Asked of AbleSet itself, this is the order on its screen right now, and
   * it wins over any saved setlist however old the file. Read back out of
   * its log it is only what AbleSet last wrote down — which a reorder does
   * not always make it do — so a setlist saved since is the better answer.
   */
  const asked = live.from === 'ableset';
  if (!asked && savedAt !== null && !Number.isNaN(at) && at <= savedAt) return null;
  const entries = live.entries.map((e) => ({ time: e.time, name: e.lastKnownName }));
  const when = asked || Number.isNaN(at) ? '' : ` as of ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const setlist = live.setlistName ? ` (setlist “${live.setlistName}”)` : '';
  return {
    titles: orderFromAbleSet(project, entries),
    note: asked
      ? `Running order as AbleSet has it open right now${setlist}, saved or not.`
      : `Running order as AbleSet last wrote it down${when}, not yet saved${setlist}.`,
  };
}

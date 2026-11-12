import type { AlsProject } from './alsParser';
import { parseLocatorName, songKey } from './alsParser.ts';
import type { FileEntry } from './files';
import type { Library, SongId } from '../types';
import { setlistIdFor } from './alsImport.ts';
import { abletLive } from './source.ts';
import type { AbleSetLive } from './localSource';

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
  /** Listed, but switched off in AbleSet — disabled or skipped — so not in the show. */
  off?: true;
}

/** AbleSet's flag for a song it lists but will not play, whatever it is called. */
function isOff(item: Record<string, unknown>): boolean {
  const flags = (o: unknown) => {
    if (!o || typeof o !== 'object') return false;
    const f = o as Record<string, unknown>;
    return (
      f.disabled === true || f.isDisabled === true || f.skip === true || f.skipped === true || f.hidden === true ||
      f.excluded === true || f.muted === true || f.enabled === false || f.active === false
    );
  };
  return flags(item) || flags(item.meta) || flags(item.cue);
}

/** The setlist files beside a set, newest saved first. */
export function abletSetlistFiles(files: FileEntry[], alsPath: string): FileEntry[] {
  const dir = alsPath.slice(0, alsPath.lastIndexOf('/') + 1).toLowerCase();
  const under = `${dir}${ABLESET_SETLISTS.toLowerCase()}/`;
  return files
    .filter((f) => f.path.toLowerCase().startsWith(under) && f.name.toLowerCase().endsWith('.json'))
    .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
}

/**
 * The setlist files beside a set, the one AbleSet has loaded first.
 *
 * A set can keep several setlists, and the newest saved is not the one being
 * played: saving the project in AbleSet rewrites every one of them. AbleSet
 * says which it has loaded, while it runs, and its log says which it was last
 * working on; that one goes first, by name. Without either, newest first.
 */
export function setlistFilesFor(files: FileEntry[], alsPath: string, loaded?: string | null): { files: FileEntry[]; loaded: boolean } {
  const all = abletSetlistFiles(files, alsPath);
  const want = loaded?.trim().toLowerCase();
  const at = want ? all.findIndex((f) => f.name.replace(/\.json$/i, '').trim().toLowerCase() === want) : -1;
  if (at < 0) return { files: all, loaded: false };
  return { files: [all[at], ...all.slice(0, at), ...all.slice(at + 1)], loaded: true };
}

/** AbleSet's answer for the set at `path`, or null when it could not be asked. */
export async function askAbleSet(alsPath: string): Promise<AbleSetLive | null> {
  try {
    return await abletLive(alsPath);
  } catch {
    return null;
  }
}

/** What the log last said of the setlist so named, else of whichever setlist it last touched. */
function loggedFor(live: AbleSetLive, name?: string | null): LoggedSetlist | null {
  const want = name?.trim().toLowerCase();
  const named = want ? live.setlists?.find((l) => l.setlistName.trim().toLowerCase() === want) : undefined;
  return named ?? live.logged ?? null;
}

/**
 * What a setlist file holds, or null when it isn't one.
 *
 * Read as liberally as AbleSet's live answer is (see cuesIn in
 * studio-files.mjs): its shape is not documented, and a file this refused
 * to read was a set with no setlist at all — every song in the show, the
 * ones AbleSet leaves out included. So any list of cues with a position,
 * bare or wrapped, in their `order` when they carry one, named by whichever
 * of AbleSet's names for a locator is there.
 */
export function parseAbleSetSetlist(raw: unknown, depth = 0): AbleSetEntry[] | null {
  if (!raw || typeof raw !== 'object' || depth > 4) return null;
  if (Array.isArray(raw)) {
    const cues = raw.filter(
      (m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as { time?: unknown }).time === 'number',
    );
    if (cues.length) {
      const order = (m: Record<string, unknown>) => (typeof m.order === 'number' ? m.order : 0);
      return cues
        .map((m, i) => ({ m, i }))
        .sort((a, b) => order(a.m) - order(b.m) || a.i - b.i)
        .map(({ m }) => ({
          time: m.time as number,
          name: nameOf(m),
          ...(isOff(m) ? { off: true as const } : {}),
        }));
    }
    for (const item of raw) {
      const found = parseAbleSetSetlist(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const doc = raw as Record<string, unknown>;
  for (const key of ['songs', 'cues', 'items', 'entries', 'metaMap', 'setlist', 'data', 'value']) {
    const found = parseAbleSetSetlist(doc[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** The locator's name as AbleSet carries it on a cue, in whichever field it is. */
function nameOf(m: Record<string, unknown>): string {
  const sub = (k: string) => (m[k] && typeof m[k] === 'object' ? (m[k] as Record<string, unknown>) : {});
  const found = [m.lastKnownName, sub('cue').name, sub('meta').raw, sub('meta').name, m.name].find(
    (n): n is string => typeof n === 'string' && !!n,
  );
  return found ?? '';
}

/**
 * A locator's name as the song it names: AbleSet's notation taken off —
 * `#tags`, `+PAUSE` and its kin, `[3:20]`, `{D}`, a stop dot — and then
 * flattened as titles are. AbleSet remembers the locator's whole name, the
 * studio's song has only the title, and the two have to meet.
 */
export function locatorKey(name: string): string {
  const bare = name.trim().replace(/^\.\s*/, '');
  return songKey(parseLocatorName(bare).title);
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
  return matchAbleSet(project, entries).order;
}

/**
 * The setlist's order, and which of the set's songs it actually names.
 *
 * A song the setlist leaves out is not part of the show: it is kept out of
 * the studio's library and never prepared or auto-updated (see
 * scopeToSetlist). `order` still runs through every song, the unnamed last,
 * for a caller that wants the whole set in order.
 */
export function matchAbleSet(
  project: AlsProject,
  entries: AbleSetEntry[],
): {
  order: string[];
  included: string[];
  /** Entry by entry, the title of the set's song it is, or null when it is none of them. */
  matched: (string | null)[];
} {
  const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
  const songs = project.songs.map((song, index) => ({
    song,
    index,
    beat: (song.startBar - 1) * beatsPerBar,
    key: locatorKey(song.raw || song.title) || songKey(song.title),
    title: songKey(song.title),
  }));
  const keyOf = (entry: AbleSetEntry) => locatorKey(entry.name);
  const sameName = (s: (typeof songs)[number], key: string) => !!key && (s.key === key || s.title === key);
  const atBeat = (s: (typeof songs)[number], entry: AbleSetEntry) => Math.abs(s.beat - entry.time) < 1e-3;

  /*
   * Which song each entry is, in three passes, surest first. A locator still
   * where AbleSet last saw it, under the same name, is certain. Then the name
   * alone: a song moved in the arrangement keeps its name, and the beat
   * AbleSet remembers is now somebody else's — matched by the beat first,
   * two songs that swapped places came out as each other. Then the beat
   * alone, for a locator renamed where it stands.
   */
  const match = new Array<number | undefined>(entries.length).fill(undefined);
  const placed = new Set<number>();
  const pass = (fits: (s: (typeof songs)[number], entry: AbleSetEntry, key: string) => boolean) => {
    entries.forEach((entry, i) => {
      if (match[i] !== undefined) return;
      const key = keyOf(entry);
      const found = songs.find((s) => !placed.has(s.index) && fits(s, entry, key));
      if (!found) return;
      match[i] = found.index;
      placed.add(found.index);
    });
  };
  pass((s, entry, key) => atBeat(s, entry) && sameName(s, key));
  pass((s, _entry, key) => sameName(s, key));
  pass((s, entry) => atBeat(s, entry));

  const order: string[] = [];
  // Listed but switched off in AbleSet: placed, so not matched again, but not in the show.
  const off = new Set<string>();
  const on = new Set<string>();
  entries.forEach((entry, i) => {
    const index = match[i];
    if (index === undefined) return;
    const title = songs[index].song.title;
    if (entry.off) off.add(title);
    else on.add(title);
    if (!order.includes(title)) order.push(title);
  });
  // A title listed twice, once on and once off, is in the show.
  const included = order.filter((t) => on.has(t) || !off.has(t));
  for (const s of songs) if (!placed.has(s.index) && !order.includes(s.song.title)) order.push(s.song.title);
  const matched = match.map((index) => (index === undefined ? null : songs[index].song.title));
  return { order, included, matched };
}

/**
 * The set as the studio works on it: only the songs AbleSet's setlist names,
 * when the last scan found that setlist. A song left off it is not in the
 * show — the library lists it, marked so, but nothing prepares, refreshes or
 * auto-updates it. Without such a setlist, the whole set, as before.
 */
export function scopeToSetlist(
  project: AlsProject,
  library: Library,
  alsPath: string,
): { project: AlsProject; left: string[] } {
  const setlist = library.setlists.find((sl) => sl.id === setlistIdFor(alsPath));
  if (!setlist?.fromAbleSet || !setlist.included?.length) return { project, left: [] };
  const keep = new Set(setlist.included.map((t) => t.toLowerCase()));
  const left = [...new Set(project.songs.filter((s) => !keep.has(s.title.toLowerCase())).map((s) => s.title))];
  if (!left.length) return { project, left };
  return { project: { ...project, songs: project.songs.filter((s) => keep.has(s.title.toLowerCase())) }, left };
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
  /** No order of AbleSet's was found for the set: these are the arrangement's. */
  missing?: boolean;
  /** The songs AbleSet's setlist names, when it is AbleSet's order. */
  included?: string[];
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
  /** The saved setlist the scan read, by its file's name, to take its skips from the log. */
  saved?: { name: string; entries: AbleSetEntry[] },
  /** AbleSet's answer, when the caller has already asked. */
  answer?: AbleSetLive | null,
): Promise<RunningOrder | null> {
  const live = answer === undefined ? await askAbleSet(alsPath) : answer;
  if (!live) return null;
  // The log's skips are tied to this set by the setlist's name, not by what AbleSet opened last.
  const fromSaved = () => (saved ? savedWithSkips(project, saved, loggedFor(live, saved.name)) : null);
  if (!live.applies) return fromSaved();
  /*
   * What the log wrote down is of whichever setlist it last touched; the
   * one AbleSet has loaded is the one wanted, when the log has it.
   */
  let found = live.found ? { at: live.at ?? null, setlistName: live.setlistName ?? '', entries: live.entries ?? [] } : null;
  if (live.from === 'log' && live.loaded?.name) {
    const of = loggedFor(live, live.loaded.name);
    if (of && of.setlistName.trim().toLowerCase() === live.loaded.name.trim().toLowerCase()) found = of;
  }
  if (!found?.entries.length) return fromSaved();
  // A saved setlist that is not the one AbleSet's log is about is not overruled by it.
  if (live.from === 'log' && saved && found.setlistName && found.setlistName.trim().toLowerCase() !== saved.name.trim().toLowerCase()) {
    return fromSaved();
  }
  const at = found.at ? Date.parse(found.at) : NaN;
  /*
   * Asked of AbleSet itself, this is the order on its screen right now, and
   * it wins over any saved setlist however old the file. Read back out of
   * its log it is only what AbleSet last wrote down — which a reorder does
   * not always make it do — so a setlist saved since is the better answer.
   */
  const asked = live.from === 'ableset';
  if (!asked && savedAt !== null && !Number.isNaN(at) && at <= savedAt) return fromSaved();
  const entries = found.entries.map((e) => ({ time: e.time, name: e.lastKnownName, ...(e.off ? { off: true as const } : {}) }));
  const when = asked || Number.isNaN(at) ? '' : ` as of ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const setlist = found.setlistName ? ` (setlist “${found.setlistName}”)` : '';
  const matched = matchAbleSet(project, entries);
  return {
    titles: matched.order,
    included: matched.included,
    note: asked
      ? `Running order as AbleSet has it open right now${setlist}, saved or not.`
      : `Running order as AbleSet last wrote it down${when}, not yet saved${setlist}.`,
  };
}

/** What AbleSet's log last said of a setlist: its order, and which songs it skips. */
export interface LoggedSetlist {
  at: string | null;
  setlistName: string;
  entries: { time: number; lastKnownName: string; off?: true }[];
}

/**
 * A saved setlist's songs, with the ones skipped in AbleSet marked so.
 *
 * AbleSet's saved file is only the order — ids, beats and names — and says
 * nothing of the songs skipped on it; those are only in its log. Read alone,
 * a saved file put every skipped song back in the show. The log's skips are
 * taken only from the same setlist, by name, and matched to the file's
 * songs by beat or by name. Null when the log has none to give.
 */
export function savedWithSkips(
  project: AlsProject,
  saved: { name: string; entries: AbleSetEntry[] },
  logged: LoggedSetlist | null,
): RunningOrder | null {
  const entries = skipsFromLog(saved, logged);
  if (!entries) return null;
  const matched = matchAbleSet(project, entries);
  const skipped = entries.filter((e) => e.off).length;
  return {
    titles: matched.order,
    included: matched.included,
    note: `Running order from AbleSet's setlist “${saved.name}”, with the ${skipped === 1 ? 'song' : `${skipped} songs`} skipped in AbleSet left out.`,
  };
}

/** The saved entries marked off where the log's newest order of the same setlist skips them; null when it skips none. */
export function skipsFromLog(saved: { name: string; entries: AbleSetEntry[] }, logged: LoggedSetlist | null): AbleSetEntry[] | null {
  if (!logged?.entries.length) return null;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!logged.setlistName || !same(logged.setlistName, saved.name)) return null;
  const off = logged.entries.filter((e) => e.off);
  if (!off.length) return null;
  const skippedHere = (e: AbleSetEntry) =>
    off.some((o) => Math.abs(o.time - e.time) < 1e-3) || off.some((o) => !!o.lastKnownName && same(o.lastKnownName, e.name));
  let any = false;
  const out = saved.entries.map((e) => {
    if (e.off || !skippedHere(e)) return e;
    any = true;
    return { ...e, off: true as const };
  });
  return any ? out : null;
}

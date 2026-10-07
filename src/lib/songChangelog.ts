import type { PreparedPart, PreparedSongInfo } from './preparedSet.ts';

/**
 * A song's history, as the band's site shows it on the song's page.
 *
 * Every time Studio writes a song — a prepare, a refresh of its words, a
 * submix pass — the entry about to be written is held against the one the
 * folder already had, and what is different is said in a band's words: which
 * parts were rendered again, a section that moved, the bars of the chords
 * that changed. One entry per write that changed something; nothing for one
 * that did not. Entries are only ever added: the ones already published are
 * carried forward as they were, oldest first, the newest fifty kept.
 *
 * The site reads `changelog` on each song of set.json and of the band's
 * library: `at` (ISO 8601 with a zone), `summary` (one line) and `details`
 * (a line each, optional). It drops an entry without both of the first two,
 * keeps fifty, and cuts a line at 300 characters and details at 20 — so this
 * keeps to the same.
 */

export interface ChangelogEntry {
  at: string;
  summary: string;
  details?: string[];
}

export const CHANGELOG_KEEP = 50;
const LINE_MAX = 300;
const DETAILS_MAX = 20;

/** The song's history so far, as the write in hand will publish it. */
export type WithChangelog = PreparedSongInfo & { changelog?: ChangelogEntry[] };

const line = (text: string): string => (text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text);

/** "Bass", "Bass and Keys", "Bass, Keys and Drums". */
function listed(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A part's name as a band would say it: "ref vox" is "Ref Vox". */
function partName(p: PreparedPart): string {
  const raw = (p.name || p.label || '').trim();
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

const isSubmix = (p: PreparedPart) => !!(p.submixOf || p.submixFor);
const memberOf = (p: PreparedPart) => {
  const m = p.submixFor;
  return Array.isArray(m) ? m.join(', ') : (m ?? partName(p));
};

/**
 * What makes a part the part it is. An audio part is a file: a new render
 * dates it anew, a copy keeps the date. A click or cues part is a pattern,
 * written afresh every time, so it is what it strikes and when that counts.
 */
const partStamp = (p: PreparedPart) =>
  p.kind === 'sampler' ? JSON.stringify([p.rev ?? null, p.notes ?? null]) : JSON.stringify([p.renderedAt ?? null]);

/** Bars as a band reads them: "17–24, 33". */
function barRanges(bars: number[]): string {
  const sorted = [...new Set(bars.map((b) => Math.floor(b)))].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** Audio parts, then submixes: added, removed, rendered again. */
function partChanges(prev: PreparedPart[], next: PreparedPart[], submixes: boolean): string[] {
  const pick = (list: PreparedPart[]) => list.filter((p) => isSubmix(p) === submixes);
  const keyOf = (p: PreparedPart) => (submixes ? memberOf(p) : partName(p)).toLowerCase();
  const before = new Map(pick(prev).map((p) => [keyOf(p), p]));
  const after = new Map(pick(next).map((p) => [keyOf(p), p]));
  const nameOf = (p: PreparedPart) => (submixes ? `the submix for ${memberOf(p)}` : partName(p));
  const added = [...after.entries()].filter(([k]) => !before.has(k)).map(([, p]) => nameOf(p));
  const removed = [...before.entries()].filter(([k]) => !after.has(k)).map(([, p]) => nameOf(p));
  const differs = [...after.entries()].filter(([k, p]) => before.has(k) && partStamp(before.get(k)!) !== partStamp(p));
  const redone = differs.filter(([, p]) => p.kind !== 'sampler').map(([, p]) => nameOf(p));
  const patterns = differs.filter(([, p]) => p.kind === 'sampler').map(([, p]) => nameOf(p));
  const audio = [...after.values()].filter((p) => p.kind !== 'sampler').length;
  const out: string[] = [];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (redone.length) {
    const all = !submixes && redone.length === audio && audio > 2;
    out.push(all ? `All ${audio} parts re-rendered` : `${cap(listed(redone))} re-rendered`);
  }
  if (patterns.length) out.push(`${cap(listed(patterns))} changed`);
  if (added.length) out.push(`${cap(listed(added))} added`);
  if (removed.length) out.push(`${cap(listed(removed))} removed`);
  return out;
}

/** Sections: moved, added, taken out — paired by name, in order, so a third chorus is the third chorus. */
function markerChanges(prev: PreparedSongInfo['markers'], next: PreparedSongInfo['markers']): string[] {
  const byName = (list: PreparedSongInfo['markers']) => {
    const m = new Map<string, { name: string; bars: number[] }>();
    for (const mk of list ?? []) {
      const k = mk.name.trim().toLowerCase();
      const e = m.get(k) ?? { name: mk.name.trim(), bars: [] };
      e.bars.push(mk.bar);
      m.set(k, e);
    }
    for (const e of m.values()) e.bars.sort((a, b) => a - b);
    return m;
  };
  const a = byName(prev);
  const b = byName(next);
  const out: string[] = [];
  for (const [k, e] of b) {
    const was = a.get(k)?.bars ?? [];
    e.bars.forEach((bar, i) => {
      if (i >= was.length) out.push(`${e.name} added at bar ${bar}`);
      else if (was[i] !== bar) out.push(`${e.name} moved to bar ${bar}`);
    });
    for (let i = e.bars.length; i < was.length; i++) out.push(`${e.name} at bar ${was[i]} removed`);
  }
  for (const [k, e] of a) if (!b.has(k)) for (const bar of e.bars) out.push(`${e.name} at bar ${bar} removed`);
  return out;
}

/** Chart lanes, chords and lyrics: which lane, which bars. */
function laneChanges(prev: PreparedSongInfo, next: PreparedSongInfo): string[] {
  const lanes = (s: PreparedSongInfo) =>
    new Map(
      (s.lanes?.length ? s.lanes : s.chords?.length ? [{ id: 'chords', name: 'Chords', kind: 'chords' as const, items: s.chords }] : []).map(
        (l) => [l.name.trim().toLowerCase(), l],
      ),
    );
  const a = lanes(prev);
  const b = lanes(next);
  const out: string[] = [];
  const atBars = (items: { bar: number; text: string }[]) => {
    const m = new Map<number, string[]>();
    for (const it of items) {
      const bar = Math.floor(it.bar);
      m.set(bar, [...(m.get(bar) ?? []), `${it.bar}:${it.text}`]);
    }
    return m;
  };
  for (const [k, lane] of b) {
    const was = a.get(k);
    if (!was) {
      out.push(`${lane.name} added`);
      continue;
    }
    const x = atBars(was.items);
    const y = atBars(lane.items);
    const bars = [...new Set([...x.keys(), ...y.keys()])].filter((bar) => (x.get(bar) ?? []).join('|') !== (y.get(bar) ?? []).join('|'));
    if (bars.length) out.push(`${lane.name} changed in bar${bars.length === 1 ? '' : 's'} ${barRanges(bars)}`);
  }
  for (const [k, lane] of a) if (!b.has(k)) out.push(`${lane.name} removed`);
  return out;
}

/** What is different about a song between two writes, a line each, the audio first. */
export function songChanges(prev: PreparedSongInfo, next: PreparedSongInfo): string[] {
  const out: string[] = [];
  out.push(...partChanges(prev.parts ?? [], next.parts ?? [], false));
  out.push(...partChanges(prev.parts ?? [], next.parts ?? [], true));
  if ((prev.tempo ?? null) !== (next.tempo ?? null) && next.tempo !== undefined) {
    out.push(prev.tempo !== undefined ? `Tempo ${prev.tempo} → ${next.tempo} BPM` : `Tempo set to ${next.tempo} BPM`);
  }
  if (JSON.stringify(prev.tempoMap ?? []) !== JSON.stringify(next.tempoMap ?? [])) {
    out.push(next.tempoMap?.length ? `Tempo changes now at bar${next.tempoMap.length === 1 ? '' : 's'} ${next.tempoMap.map((t) => `${t.bar} (${t.bpm})`).join(', ')}` : 'Tempo changes removed');
  }
  if ((prev.timeSignature ?? null) !== (next.timeSignature ?? null) && next.timeSignature) {
    out.push(prev.timeSignature ? `Time signature ${prev.timeSignature} → ${next.timeSignature}` : `Time signature set to ${next.timeSignature}`);
  }
  if (JSON.stringify(prev.signatureMap ?? []) !== JSON.stringify(next.signatureMap ?? [])) {
    out.push(next.signatureMap?.length
      ? `Time signature changes now at bar${next.signatureMap.length === 1 ? '' : 's'} ${next.signatureMap.map((m) => `${m.bar} (${m.timeSignature})`).join(', ')}`
      : 'Time signature changes removed');
  }
  if ((prev.originalKey ?? null) !== (next.originalKey ?? null)) {
    out.push(
      next.originalKey ? (prev.originalKey ? `Key ${prev.originalKey} → ${next.originalKey}` : `Key set to ${next.originalKey}`) : 'Key removed',
    );
  }
  if (prev.bars !== undefined && next.bars !== undefined && Math.abs(prev.bars - next.bars) > 1e-3) {
    out.push(`Length ${prev.bars} → ${next.bars} bars`);
  }
  out.push(...markerChanges(prev.markers, next.markers));
  out.push(...laneChanges(prev, next));
  if (Math.abs((prev.firstBarOffsetSec ?? 0) - (next.firstBarOffsetSec ?? 0)) > 1e-4) {
    out.push(`Lead-in ${(prev.firstBarOffsetSec ?? 0).toFixed(3)} s → ${(next.firstBarOffsetSec ?? 0).toFixed(3)} s`);
  }
  return out;
}

/**
 * The entry about to be written, with its history: everything the last
 * publish had, carried forward as it was, and one new entry when something
 * changed — the person's own words as the summary when they gave any, what
 * Studio saw in the details. A first write is "First published".
 */
export function withChangelog(
  prev: WithChangelog | null | undefined,
  next: PreparedSongInfo,
  when: { at: string; note?: string },
): WithChangelog {
  const history = (prev?.changelog ?? []).filter((e) => e && typeof e.at === 'string' && typeof e.summary === 'string');
  const note = when.note?.trim() ? line(when.note.trim()) : undefined;
  let entry: ChangelogEntry | null = null;
  if (!prev) {
    entry = { at: when.at, summary: 'First published', ...(note ? { details: [note] } : {}) };
  } else {
    const changes = songChanges(prev, next).map(line);
    if (changes.length) {
      const details = changes.length > DETAILS_MAX ? [...changes.slice(0, DETAILS_MAX - 1), `…and ${changes.length - DETAILS_MAX + 1} more`] : changes;
      // A few changes are the summary themselves; more, and the first leads with the rest beneath.
      const joined = changes.join('; ');
      entry = note
        ? { at: when.at, summary: note, details }
        : joined.length <= 140
          ? { at: when.at, summary: joined }
          : { at: when.at, summary: line(`${changes[0]}, and ${changes.length - 1} more change${changes.length === 2 ? '' : 's'}`), details };
    }
  }
  const changelog = entry ? [...history, entry].slice(-CHANGELOG_KEEP) : history;
  const { changelog: _old, ...rest } = next as WithChangelog;
  return changelog.length ? { ...rest, changelog } : rest;
}

/**
 * Two accounts of one song's history as one: every entry of either, each
 * once, oldest first, the newest fifty. For the band's library, which keeps
 * what it had published and takes what the set's file says now — so a
 * set.json written afresh never takes a song's history away.
 */
export function mergeChangelogs(...lists: (ChangelogEntry[] | null | undefined)[]): ChangelogEntry[] {
  const seen = new Map<string, ChangelogEntry>();
  for (const list of lists) {
    for (const e of list ?? []) {
      if (!e || typeof e.at !== 'string' || typeof e.summary !== 'string' || !e.summary.trim()) continue;
      seen.set(`${e.at}|${e.summary}`, e);
    }
  }
  return [...seen.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-CHANGELOG_KEEP);
}

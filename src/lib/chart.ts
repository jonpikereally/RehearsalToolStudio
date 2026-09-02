import type { ChartLane, Song, TimedText } from '../types';

/**
 * Laying lyrics and chords out as a chart.
 *
 * Two shapes, depending on what the song has. With lyrics, each line is a row
 * and the chords that fall under it sit above the words, as on a chord sheet.
 * With chords alone — which is most of these sets — they're laid out a few bars
 * to a row so the shape of the song is readable at a glance.
 */

export interface ChartChord {
  bar: number;
  text: string;
}

export interface ChartRow {
  /** Bar the row begins at. */
  bar: number;
  /** Bar the row ends before; Infinity on the last row. */
  endBar: number;
  chords: ChartChord[];
  /**
   * The lines of text on this row — usually one, but several when more than one
   * lane has something at the same moment (a lyric and a cue, say). Empty on a
   * chords-only chart.
   */
  lines: string[];
  /** The section this row falls in, shown when it changes. */
  section?: string;
}

/** How many bars share a row when there are no lyrics to group by. */
const BARS_PER_ROW = 4;

function sorted(items: TimedText[] | undefined): TimedText[] {
  return [...(items ?? [])].sort((a, b) => a.bar - b.bar);
}

/**
 * The song's text tracks.
 *
 * Songs imported from a set carry their tracks named and separate. Anything
 * else has at most the one lyric line and one chord line, which are presented
 * here as lanes too so the rest of the code needs only one shape.
 */
export function chartLanes(song: Song): ChartLane[] {
  if (song.lanes?.length) return song.lanes;
  const lanes: ChartLane[] = [];
  if (song.lyrics?.length) lanes.push({ id: 'lyrics', name: 'Lyrics', kind: 'lyrics', items: song.lyrics });
  if (song.chords?.length) lanes.push({ id: 'chords', name: 'Chords', kind: 'chords', items: song.chords });
  return lanes;
}

export function hasChart(song: Song): boolean {
  return chartLanes(song).length > 0;
}

export function buildChart(song: Song, hidden: readonly string[] = []): ChartRow[] {
  const visible = chartLanes(song).filter((lane) => !hidden.includes(lane.id));
  const ofKind = (kind: ChartLane['kind']) =>
    sorted(visible.filter((l) => l.kind === kind).flatMap((l) => l.items));

  const lyrics = ofKind('lyrics');
  const chords = ofKind('chords');
  if (!lyrics.length && !chords.length) return [];

  const sections = [...song.markers].sort((a, b) => a.bar - b.bar);
  const sectionAt = (bar: number): string | undefined => {
    let name: string | undefined;
    for (const s of sections) {
      if (s.bar <= bar + 1e-6) name = s.name;
      else break;
    }
    return name;
  };

  const rows: ChartRow[] = lyrics.length
    ? lyricRows(lyrics)
    : chordRows(chords, song);

  // Attach chords to whichever row covers them.
  for (const chord of chords) {
    const row = rows.find((r) => chord.bar >= r.bar - 1e-6 && chord.bar < r.endBar);
    if (row) row.chords.push({ bar: chord.bar, text: chord.text });
  }

  // Only label a row when the section actually changes.
  let previous: string | undefined;
  for (const row of rows) {
    const name = sectionAt(row.bar);
    if (name && name !== previous) row.section = name;
    previous = name;
  }

  return rows;
}

/**
 * A row per moment, not per line.
 *
 * Lines from different lanes landing on the same bar belong together; giving
 * each its own row would make one of them zero bars wide, and a row that spans
 * no time can hold no chords.
 */
function lyricRows(lyrics: TimedText[]): ChartRow[] {
  const byBar = new Map<number, string[]>();
  for (const line of lyrics) {
    const at = byBar.get(line.bar);
    if (at) at.push(line.text);
    else byBar.set(line.bar, [line.text]);
  }
  const bars = [...byBar.keys()].sort((a, b) => a - b);
  return bars.map((bar, i) => ({
    bar,
    endBar: bars[i + 1] ?? Infinity,
    chords: [],
    lines: byBar.get(bar)!,
  }));
}

function chordRows(chords: TimedText[], song: Song): ChartRow[] {
  const rows: ChartRow[] = [];
  const first = Math.floor(chords[0].bar);
  const last = Math.ceil(chords[chords.length - 1].bar) + 1;

  // Align rows to the bar line so a row always starts where a bar does.
  const perRow = Math.max(1, Math.round(BARS_PER_ROW * (4 / (song.timeSigNum || 4))));
  for (let bar = first; bar < last; bar += perRow) {
    rows.push({ bar, endBar: bar + perRow, chords: [], lines: [] });
  }
  if (rows.length) rows[rows.length - 1].endBar = Infinity;
  return rows;
}

/** Index of the row covering `bar`, or -1 before the chart starts. */
export function rowAtBar(rows: ChartRow[], bar: number): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (bar >= rows[i].bar - 1e-6) return i;
  }
  return -1;
}

/** The chord sounding at `bar`, for the big readout. */
export function chordAtBar(song: Song, bar: number): string | null {
  const chords = sorted(song.chords);
  let current: string | null = null;
  for (const c of chords) {
    if (c.bar <= bar + 1e-6) current = c.text;
    else break;
  }
  return current;
}

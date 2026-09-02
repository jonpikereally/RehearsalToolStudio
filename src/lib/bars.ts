import type { Song, TempoPoint } from '../types';

/**
 * Bar ↔ time conversion.
 *
 * A song may change tempo partway through — Fix You goes from 136 to 140 at
 * bar 91 — so time is piecewise: constant within each stretch, and the offsets
 * accumulate across them. A song with no tempo map behaves exactly as a single
 * constant tempo, which is the common case.
 */

type TimeSong = Pick<Song, 'bpm' | 'timeSigNum' | 'timeSigDen' | 'firstBarOffsetSec'> & {
  tempoMap?: TempoPoint[];
  tempoScale?: number;
};

/** Quarter notes per bar, honouring the denominator: 6/8 is three quarters. */
function quartersPerBar(song: Pick<Song, 'timeSigNum' | 'timeSigDen'>): number {
  return song.timeSigNum * (4 / song.timeSigDen);
}

/** Seconds per beat at a given tempo. */
export function secPerBeat(song: Pick<Song, 'bpm'>): number {
  return 60 / song.bpm;
}

export interface TempoSegment {
  startBar: number;
  startSec: number;
  secPerBar: number;
  bpm: number;
}

/**
 * The tempo map as sorted, deduplicated points always starting at bar 1.
 * Ableton writes a step change as two points at one instant, so the later
 * value at a bar is the one that takes effect.
 */
/**
 * The stretch applied to the recording, as a multiplier on every tempo.
 *
 * One number covering the whole song: bar positions then scale with the audio,
 * so everything — markers, the click, loops, the chart — stays lined up without
 * any of them knowing that a stretch happened.
 */
function scaleOf(song: TimeSong): number {
  const scale = song.tempoScale;
  return scale && scale > 0 ? scale : 1;
}

function tempoPoints(song: TimeSong): TempoPoint[] {
  const byBar = new Map<number, number>();
  for (const p of song.tempoMap ?? []) {
    if (p.bpm >= 20 && p.bpm <= 300) byBar.set(p.bar, p.bpm);
  }
  const points = [...byBar.entries()]
    .map(([bar, bpm]) => ({ bar, bpm }))
    .sort((a, b) => a.bar - b.bar);

  // Everything before the first change runs at the song's own tempo.
  if (!points.length || points[0].bar > 1) points.unshift({ bar: 1, bpm: song.bpm });

  const scale = scaleOf(song);
  return scale === 1 ? points : points.map((p) => ({ ...p, bpm: p.bpm * scale }));
}

/** Each stretch of constant tempo, with the time its first bar begins. */
export function tempoSegments(song: TimeSong): TempoSegment[] {
  const points = tempoPoints(song);
  const perBar = (bpm: number) => quartersPerBar(song) * (60 / bpm);

  const segments: TempoSegment[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const previous = segments[i - 1];
    const startSec = previous
      ? previous.startSec + (point.bar - previous.startBar) * previous.secPerBar
      : song.firstBarOffsetSec;
    segments.push({ startBar: point.bar, startSec, secPerBar: perBar(point.bpm), bpm: point.bpm });
  }
  return segments;
}

/** True when the song's tempo actually changes at some point. */
export function hasTempoChanges(song: TimeSong): boolean {
  return tempoPoints(song).length > 1;
}

/** Seconds per bar at bar 1 — the whole song, unless it changes tempo. */
export function secPerBar(song: Pick<Song, 'bpm' | 'timeSigNum' | 'timeSigDen'> & { tempoScale?: number }): number {
  const scale = song.tempoScale && song.tempoScale > 0 ? song.tempoScale : 1;
  return quartersPerBar(song) * (60 / (song.bpm * scale));
}

/** Seconds per bar at a particular bar. */
export function secPerBarAt(song: TimeSong, bar: number): number {
  return segmentForBar(tempoSegments(song), bar).secPerBar;
}

export function tempoAt(song: TimeSong, bar: number): number {
  return segmentForBar(tempoSegments(song), bar).bpm;
}

function segmentForBar(segments: TempoSegment[], bar: number): TempoSegment {
  let found = segments[0];
  for (const s of segments) {
    if (s.startBar <= bar) found = s;
    else break;
  }
  return found;
}

function segmentForSec(segments: TempoSegment[], sec: number): TempoSegment {
  let found = segments[0];
  for (const s of segments) {
    if (s.startSec <= sec) found = s;
    else break;
  }
  return found;
}

/** Convert a 1-based bar number (may be fractional) to seconds. */
export function barToSec(bar: number, song: TimeSong): number {
  const segment = segmentForBar(tempoSegments(song), bar);
  return segment.startSec + (bar - segment.startBar) * segment.secPerBar;
}

/** Convert a time in seconds to a fractional 1-based bar number. */
export function secToBar(sec: number, song: TimeSong): number {
  const segment = segmentForSec(tempoSegments(song), sec);
  return segment.startBar + (sec - segment.startSec) / segment.secPerBar;
}

/** The start time of the bar containing `sec`. */
export function barStartSec(sec: number, song: TimeSong): number {
  return barToSec(Math.floor(secToBar(sec, song)), song);
}

/**
 * Jump by whole bars from the current position.
 *
 * Moving backwards snaps to the current bar line first when we're more than
 * `graceBeats` into the bar — the same behaviour as a "previous track" button,
 * so tapping back once restarts the bar you're in rather than skipping one.
 */
export function nudgeBars(
  currentSec: number,
  bars: number,
  song: TimeSong,
  opts: { graceBeats?: number } = {},
): number {
  const graceBeats = opts.graceBeats ?? 0.5;
  const bar = secToBar(currentSec, song);
  const intoBarBeats = (bar - Math.floor(bar)) * song.timeSigNum;

  let targetBar: number;
  if (bars < 0 && intoBarBeats > graceBeats) {
    // Snap back to the top of this bar, then apply the remaining jumps.
    targetBar = Math.floor(bar) + (bars + 1);
  } else {
    targetBar = Math.floor(bar) + bars;
  }
  return barToSec(Math.max(1, targetBar), song);
}

/** Format a position as "bar.beat", e.g. "17.3". */
export function formatBarBeat(sec: number, song: TimeSong): string {
  const bar = secToBar(sec, song);
  if (bar < 1) return `–.–`;
  const whole = Math.floor(bar);
  const beat = Math.floor((bar - whole) * song.timeSigNum) + 1;
  return `${whole}.${beat}`;
}

/** Format seconds as m:ss. */
export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Total whole bars in a file of `duration` seconds. */
export function totalBars(duration: number, song: TimeSong): number {
  return Math.max(1, Math.floor(secToBar(duration, song)));
}

/* -------------------------------- metronome ------------------------------- */

export interface ClickBeat {
  sec: number;
  accent: boolean;
}

/**
 * Every beat in the song, as absolute times.
 *
 * Worked out here rather than in the audio engine so the click follows the
 * tempo map for free — with a changing tempo the beats are not evenly spaced,
 * and stepping bar by bar is the only way to keep them on the grid.
 */
export function clickBeats(song: TimeSong, duration: number): ClickBeat[] {
  const beats: ClickBeat[] = [];
  if (!(duration > 0)) return beats;

  const perBar = song.timeSigNum;
  const lastBar = totalBars(duration, song) + 1;

  for (let bar = 1; bar <= lastBar; bar++) {
    const barStart = barToSec(bar, song);
    if (barStart > duration) break;
    const beatLength = secPerBarAt(song, bar) / perBar;
    for (let beat = 0; beat < perBar; beat++) {
      const sec = barStart + beat * beatLength;
      if (sec < 0 || sec >= duration) continue;
      beats.push({ sec, accent: beat === 0 });
    }
  }
  return beats;
}

/**
 * A warped clip through more than one tempo.
 *
 * Live plays a warped clip by its warp markers: each says "this second of the
 * file is this beat of the clip", and between two of them the file runs at
 * whatever rate puts the one on the other. The song's tempo map then says
 * how long each beat lasts. Together they give, for every moment of the
 * song, the moment of the file that sounds — and while that is a straight
 * line, the clip is one stretch of the file at one speed, which is how
 * nearly every stem is: exported at the song's tempo, warped by a pair of
 * markers, in a song that keeps one tempo.
 *
 * A file that changes tempo itself — a record warped bar by bar onto a set
 * that follows it from 72 to 81 — is not a straight line, and taking it as
 * one, at the average rate of its markers, played Amsterdam six per cent slow
 * from its first bar and drifting further behind the click all the way
 * through. Such a clip is cut here into pieces, each a straight line within a
 * few milliseconds, each with its own speed and its own slice of the file.
 * Only a clip that bends is cut; one that does not is left as it was.
 */

/** "This second of the file is this beat of the clip." */
export interface WarpMarker {
  sec: number;
  beat: number;
}

/** One straight stretch of a warped clip, in project beats and file seconds. */
export interface WarpPiece {
  /** Where the piece starts and ends on the arrangement, in project beats. */
  fromBeat: number;
  toBeat: number;
  /** The slice of the file it plays, in the file's own seconds. */
  sourceStartSec: number;
  sourceEndSec: number;
  /** How much faster than its file the piece plays: file seconds per song second. */
  speed: number;
}

/**
 * How far a piece may stray from the true line before it is cut, in
 * seconds. Live's own grid is finer than any ear, and five milliseconds is
 * well under what a player would notice against a click.
 */
export const WARP_TOLERANCE_SEC = 0.005;

/**
 * How long one piece of a cut clip overlaps the next, fading out as it fades
 * in, in seconds: enough to hide the seam where two stretches of one file at
 * two speeds meet, too short to hear as anything.
 */
export const WARP_CROSSFADE_SEC = 0.01;

/** The markers in a clip's XML, in file order, each moving forward in both file and beat. */
export function warpMarkersIn(body: string): WarpMarker[] {
  const all = [...body.matchAll(/<WarpMarker Id="\d+" SecTime="([-\d.e]+)" BeatTime="([-\d.e]+)"/g)]
    .map((m) => ({ sec: parseFloat(m[1]), beat: parseFloat(m[2]) }))
    .filter((m) => Number.isFinite(m.sec) && Number.isFinite(m.beat))
    .sort((a, b) => a.sec - b.sec);
  // A marker that goes nowhere — the same second, or a beat no later — says nothing about a rate.
  const out: WarpMarker[] = [];
  for (const m of all) {
    const last = out[out.length - 1];
    if (last && (m.sec - last.sec <= 1e-9 || m.beat - last.beat <= 1e-9)) continue;
    out.push(m);
  }
  return out;
}

/**
 * The second of the file at a beat of the clip, through the markers. Past
 * the last marker the file runs on at the last pair's rate, and before the
 * first at the first pair's, as Live plays it.
 */
export function fileSecAtBeat(markers: WarpMarker[], beat: number): number {
  if (markers.length < 2) return NaN;
  let i = 0;
  while (i < markers.length - 2 && beat > markers[i + 1].beat) i++;
  const a = markers[i];
  const b = markers[i + 1];
  return a.sec + ((beat - a.beat) * (b.sec - a.sec)) / (b.beat - a.beat);
}

/**
 * A warped clip cut into straight pieces: one, the common case, when it is a
 * straight line already; null when the markers give no line at all.
 *
 * `fromBeat`–`toBeat` is the stretch of the arrangement to cover, in project
 * beats; the clip plays its beat `clipBeatAt(fromBeat)` there and runs on
 * beat for beat. `secAt` is the song's clock, in seconds at a project beat,
 * through its tempo map; `tempoBeats` are the project beats where that
 * tempo changes, which are corners in the line as much as the markers are.
 */
export function warpPieces(args: {
  markers: WarpMarker[];
  fromBeat: number;
  toBeat: number;
  clipBeatAt: (projectBeat: number) => number;
  secAt: (projectBeat: number) => number;
  tempoBeats: number[];
  toleranceSec?: number;
}): WarpPiece[] | null {
  const { markers, fromBeat, toBeat, clipBeatAt, secAt, tempoBeats } = args;
  const tolerance = args.toleranceSec ?? WARP_TOLERANCE_SEC;
  if (markers.length < 2 || !(toBeat > fromBeat)) return null;

  // Every corner the line can have inside the stretch: the markers, and the tempo changes.
  const offset = clipBeatAt(fromBeat) - fromBeat;
  const corners = new Set<number>([fromBeat, toBeat]);
  for (const m of markers) {
    const beat = m.beat - offset;
    if (beat > fromBeat + 1e-6 && beat < toBeat - 1e-6) corners.add(beat);
  }
  for (const beat of tempoBeats) if (beat > fromBeat + 1e-6 && beat < toBeat - 1e-6) corners.add(beat);
  const points = [...corners]
    .sort((a, b) => a - b)
    .map((beat) => ({ beat, out: secAt(beat), file: fileSecAtBeat(markers, beat + offset) }));
  if (points.some((p) => !Number.isFinite(p.out) || !Number.isFinite(p.file))) return null;

  /*
   * The fewest pieces that keep within the tolerance: each runs as far as it
   * can while every corner it passes over sits within a few milliseconds of
   * the straight line between its ends.
   */
  const straight = (i: number, j: number): boolean => {
    const a = points[i];
    const b = points[j];
    const span = b.out - a.out;
    if (!(span > 0)) return false;
    for (let k = i + 1; k < j; k++) {
      const p = points[k];
      const onLine = a.file + ((p.out - a.out) * (b.file - a.file)) / span;
      if (Math.abs(onLine - p.file) > tolerance) return false;
    }
    return true;
  };
  const ends: number[] = [0];
  let at = 0;
  while (at < points.length - 1) {
    let next = at + 1;
    while (next + 1 < points.length && straight(at, next + 1)) next++;
    ends.push(next);
    at = next;
  }

  const pieces: WarpPiece[] = [];
  for (let n = 0; n < ends.length - 1; n++) {
    const a = points[ends[n]];
    const b = points[ends[n + 1]];
    const speed = (b.file - a.file) / (b.out - a.out);
    // A piece within a few milliseconds of its own speed plays as it is.
    const asIs = Math.abs(speed - 1) * (b.out - a.out) <= tolerance;
    pieces.push({
      fromBeat: a.beat,
      toBeat: b.beat,
      sourceStartSec: a.file,
      sourceEndSec: b.file,
      speed: asIs ? 1 : speed,
    });
  }
  return pieces;
}

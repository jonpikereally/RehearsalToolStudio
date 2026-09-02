/**
 * Linear timecode, as an audio file.
 *
 * LTC is SMPTE timecode encoded as sound, so a rig can be fed position down an
 * ordinary audio cable. Every frame is 80 bits carrying the time, a sync word,
 * and some flags, sent as biphase mark: each bit is one full cycle of the
 * carrier, and a 1 has an extra transition in the middle of it. That is the
 * whole format — no filtering, no shaping, just square edges at the right
 * moments — which is why it can be written here rather than needing a device.
 *
 * A file generated here lets the app drive a show it didn't program, which is
 * the only thing in it that points outward at a rig rather than inward at
 * practice.
 */

export type LtcFrameRate = 24 | 25 | 30;

/**
 * Timecode is generated at 48 kHz.
 *
 * At 48 kHz every supported frame rate divides into a whole number of samples
 * per bit — 25, 24 and 20 — so every edge lands exactly where it should. At
 * 44.1 kHz a bit is 22.97 samples and the edges have to be rounded; a receiver
 * locking to edges would very likely cope, but "very likely" is a poor
 * foundation for the thing that keeps a show in time.
 */
export const LTC_SAMPLE_RATE = 48000;

/** The sync word that closes every frame, low bit first: 0011111111111101. */
const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

export interface LtcTime {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

export function ltcTimeAt(frame: number, fps: LtcFrameRate): LtcTime {
  const frames = frame % fps;
  const total = Math.floor(frame / fps);
  return {
    hours: Math.floor(total / 3600) % 24,
    minutes: Math.floor(total / 60) % 60,
    seconds: total % 60,
    frames,
  };
}

/**
 * One frame as its 80 bits.
 *
 * Written by bit position rather than by pushing fields in order, because the
 * time fields are *interleaved* with the user bits — frame units, then four
 * spare bits, then frame tens, and so on. Building it as a running list looks
 * tidier and quietly puts seconds where the user bits belong, which is exactly
 * the mistake this shape prevents.
 *
 * Bit positions, low bit first, from SMPTE 12M:
 *
 *   0–3 frame units · 8–9 frame tens · 10 drop frame · 11 colour frame
 *   16–19 second units · 24–26 second tens
 *   32–35 minute units · 40–42 minute tens
 *   48–51 hour units · 56–57 hour tens
 *   64–79 sync word
 *
 * Everything else is user bits and flags, left at zero: this is timecode to run
 * a show to, not a carrier for a payload.
 */
export function ltcFrameBits(time: LtcTime): number[] {
  const bits = new Array<number>(80).fill(0);

  const put = (at: number, count: number, value: number) => {
    for (let i = 0; i < count; i++) bits[at + i] = (value >> i) & 1;
  };
  /** A field is two BCD digits sitting at two different offsets. */
  const putBcd = (
    value: number,
    unitsAt: number,
    unitsBits: number,
    tensAt: number,
    tensBits: number,
  ) => {
    put(unitsAt, unitsBits, value % 10);
    put(tensAt, tensBits, Math.floor(value / 10));
  };

  putBcd(time.frames, 0, 4, 8, 2);
  putBcd(time.seconds, 16, 4, 24, 3);
  putBcd(time.minutes, 32, 4, 40, 3);
  putBcd(time.hours, 48, 4, 56, 2);

  for (let i = 0; i < SYNC_WORD.length; i++) bits[64 + i] = SYNC_WORD[i];
  return bits;
}

/**
 * Encode timecode to samples, biphase mark.
 *
 * The level flips at every bit boundary, and again halfway through a 1. Written
 * hard to ±amplitude rather than smoothed, because a receiver looks for edges
 * and a rounded edge is a late one.
 */
export function renderLtc(
  seconds: number,
  fps: LtcFrameRate,
  sampleRate: number,
  startFrame = 0,
  amplitude = 0.5,
): Float32Array {
  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const samplesPerFrame = sampleRate / fps;
  const out = new Float32Array(Math.round(totalFrames * samplesPerFrame));

  let level = 1;
  let at = 0;

  for (let f = 0; f < totalFrames; f++) {
    const bits = ltcFrameBits(ltcTimeAt(startFrame + f, fps));
    // Bit boundaries are computed from the frame's own start so rounding can't
    // accumulate: an eightieth of a sample per bit becomes a drifting frame
    // over a five-minute song.
    const frameStart = f * samplesPerFrame;

    for (let b = 0; b < 80; b++) {
      const from = Math.round(frameStart + (b * samplesPerFrame) / 80);
      const to = Math.round(frameStart + ((b + 1) * samplesPerFrame) / 80);

      level = -level; // every bit begins with a transition
      if (bits[b] === 0) {
        for (let i = from; i < to && i < out.length; i++) out[i] = level * amplitude;
      } else {
        const mid = Math.round((from + to) / 2);
        for (let i = from; i < mid && i < out.length; i++) out[i] = level * amplitude;
        level = -level; // and a 1 transitions again in the middle
        for (let i = mid; i < to && i < out.length; i++) out[i] = level * amplitude;
      }
      at = to;
    }
  }

  return out.subarray(0, Math.min(at, out.length)) as Float32Array;
}

export function formatTimecode(time: LtcTime): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(time.hours)}:${two(time.minutes)}:${two(time.seconds)}:${two(time.frames)}`;
}

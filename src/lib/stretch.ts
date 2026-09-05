/**
 * Pitch shifting and time stretching, offline, with Signalsmith Stretch.
 *
 * The engine is Signalsmith's — a phase-vocoder that keeps transients whole,
 * which is what drums and consonants need and what the old time-domain
 * stretcher smeared — compiled to WebAssembly and published for the web as
 * an AudioWorklet node. A worklet is built for playing along live; the
 * studio wants a file rendered ahead of time, and rendered exactly: every
 * stem of a song shifted to precisely the same length, every downbeat
 * landing where the bar grid says. So this drives the engine's own
 * exports directly, block by block, the way its command-line example does,
 * and never goes near an audio context.
 *
 * The engine has two latencies. It reads `inputLatency` samples ahead, so
 * the first of them is fed as a pre-roll through `seek`; and its output
 * runs `outputLatency` samples behind, so that much is dropped from the
 * front and recovered from the tail with `flush`. What comes out then is
 * the input's length over the rate, aligned to well under a millisecond —
 * measured, not assumed, against a click train at both sample rates.
 */

export interface StretchModule {
  _presetDefault(channels: number, sampleRate: number): void;
  _presetCheaper(channels: number, sampleRate: number): void;
  _reset(): void;
  _inputLatency(): number;
  _outputLatency(): number;
  _setBuffers(channels: number, length: number): number;
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void;
  _seek(inputSamples: number, playbackRate: number): void;
  _process(inputSamples: number, outputSamples: number): void;
  _flush(outputSamples: number): void;
  HEAP8: Int8Array;
}

/**
 * The engine from the text of its published module.
 *
 * The package ships one file: an Emscripten factory for the WebAssembly,
 * followed by the worklet that wraps it, and exports only the wrapper. The
 * factory is what the studio wants, and it sits whole at the top of the
 * file, before the first line of the worklet — so the text up to that line
 * is evaluated as a function of its own, and hands the factory back. Pinned
 * to the package version in package.json; a release that moves the seam
 * fails here, loudly, rather than somewhere in a render.
 */
export async function loadStretch(moduleSource: string): Promise<StretchModule> {
  const seam = moduleSource.indexOf('function registerWorkletProcessor');
  if (seam < 0) throw new Error('signalsmith-stretch: the module is not laid out as expected');
  const factory = new Function(`${moduleSource.slice(0, seam)}; return SignalsmithStretch;`)() as () => Promise<StretchModule>;
  const engine = await factory();
  if (typeof engine._process !== 'function' || typeof engine._flush !== 'function') {
    throw new Error('signalsmith-stretch: the engine lacks the exports this needs');
  }
  return engine;
}

export interface StretchJob {
  left: Float32Array;
  right: Float32Array | null;
  sampleRate: number;
  semitones: number;
  /** Playback speed: 1 unchanged, 1.1 a tenth faster (and shorter). */
  tempo: number;
  /** 1 renders and returns one channel from `left` alone. */
  channels: 1 | 2;
  /** Cheaper preset: quicker, a little rougher. Default quality otherwise. */
  cheaper?: boolean;
  onProgress?: (ratio: number) => void;
}

/** Frequencies above this are shifted as noise rather than as pitch. */
const TONALITY_HZ = 8000;

/** Output samples rendered per call; input follows at the rate. */
const BLOCK = 4096;

/**
 * Render `job` through `engine`: `left`/`right` shifted by `semitones`
 * and stretched by `1/tempo`, as exactly `round(frames / tempo)` samples per
 * channel. The engine is reconfigured for every job, so one instance
 * serves any number of them in turn.
 */
export function stretchOffline(engine: StretchModule, job: StretchJob): Float32Array[] {
  const { sampleRate, semitones, channels } = job;
  const tempo = job.tempo > 0 ? job.tempo : 1;
  const inputs = channels === 1 ? [job.left] : [job.left, job.right ?? job.left];
  const inFrames = job.left.length;
  const outFrames = Math.round(inFrames / tempo);

  (job.cheaper ? engine._presetCheaper : engine._presetDefault).call(engine, channels, sampleRate);
  engine._reset();
  engine._setTransposeSemitones(semitones, TONALITY_HZ / sampleRate);
  const inLatency = engine._inputLatency();
  const outLatency = engine._outputLatency();

  // Room for the pre-roll, for a block's worth of input at this rate, and a margin.
  const bufLen = Math.max(inLatency, outLatency, Math.ceil(BLOCK * tempo) + 64, BLOCK) + 64;
  const base = engine._setBuffers(channels, bufLen) / 4;
  const inAt = (c: number) => base + bufLen * c;
  const outAt = (c: number) => base + bufLen * (channels + c);
  // The heap can move when the engine grows it; always looked up fresh.
  const heap = () => new Float32Array(engine.HEAP8.buffer);

  const feed = (from: number, count: number) => {
    const h = heap();
    for (let c = 0; c < channels; c++) {
      const src = inputs[c];
      const dst = h.subarray(inAt(c), inAt(c) + count);
      const real = Math.max(0, Math.min(count, inFrames - from));
      if (real > 0) dst.set(src.subarray(from, from + real));
      if (real < count) dst.fill(0, real);
    }
  };

  const out = Array.from({ length: channels }, () => new Float32Array(outFrames + outLatency));
  let produced = 0;
  const take = (count: number) => {
    const h = heap();
    for (let c = 0; c < channels; c++) out[c].set(h.subarray(outAt(c), outAt(c) + count), produced);
    produced += count;
  };

  // Pre-roll: the engine's look-ahead, consumed without producing.
  feed(0, inLatency);
  engine._seek(inLatency, tempo);
  let consumed = inLatency;

  let rendered = 0;
  let lastReport = 0;
  while (rendered < outFrames) {
    const outN = Math.min(BLOCK, outFrames - rendered);
    // Input keeps to the rate cumulatively, so rounding never drifts.
    const inTarget = Math.min(inFrames, inLatency + Math.round((rendered + outN) * tempo));
    const inN = Math.max(0, inTarget - consumed);
    feed(consumed, inN);
    consumed += inN;
    engine._process(inN, outN);
    take(outN);
    rendered += outN;
    const ratio = rendered / outFrames;
    if (ratio - lastReport > 0.02) {
      lastReport = ratio;
      job.onProgress?.(ratio);
    }
  }
  // The tail still inside the engine — exactly its output latency.
  engine._flush(outLatency);
  take(outLatency);

  // Everything ran one output-latency late; the front is that lateness.
  return out.map((channel) => channel.subarray(outLatency, outLatency + outFrames));
}

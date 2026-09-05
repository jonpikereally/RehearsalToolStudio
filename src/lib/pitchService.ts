import type { RenderRequest, RenderResponse } from './pitch.worker';
import { getRender, putRender, renderKey } from './idb';

/**
 * Pitch-shifted renders, cached.
 *
 * Renders are stored as interleaved 16-bit PCM: half the size of float32, and
 * well beyond transparent for practice playback. The cache key includes the
 * sample rate because a render is only reusable in a context running at the
 * same rate (plugging in headphones can change it).
 */

export interface RenderProgress {
  /** 0..1 for the variant currently rendering. */
  ratio: number;
  variantName: string;
  index: number;
  total: number;
}

function spawnWorker(): Worker {
  return new Worker(new URL('./pitch.worker.ts', import.meta.url), { type: 'module' });
}

/*
 * Workers kept warm between jobs.
 *
 * The engine is WebAssembly, and a browser compiles WebAssembly in tiers:
 * quickly and slowly at first, then properly once it has seen the code run.
 * Measured, that is one render at real time, one at five times it, and
 * eighty times it from then on — so a worker thrown away after each job
 * paid that every job, and a set of shifted stems never got to the fast
 * part. Finished workers wait here for the next job instead; only a
 * cancelled or failed one is terminated, since terminate() is what makes
 * cancelling instant. A handful is enough, and any more are let go.
 */
const idle: Worker[] = [];
const IDLE_WORKERS = 4;

function acquireWorker(): Worker {
  return idle.pop() ?? spawnWorker();
}

function releaseWorker(worker: Worker): void {
  worker.onmessage = null;
  worker.onerror = null;
  if (idle.length < IDLE_WORKERS) idle.push(worker);
  else worker.terminate();
}

/** A job on a warm worker; cancelling terminates it, and the pool grows one back. */
function renderInWorker(
  req: Omit<RenderRequest, 'type' | 'jobId'>,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<{ pcm: Int16Array; channels: number; frames: number }> {
  return new Promise((resolve, reject) => {
    const worker = acquireWorker();
    const jobId = Math.random().toString(36).slice(2);

    const finish = (keep: boolean) => {
      signal?.removeEventListener('abort', onAbort);
      if (keep) releaseWorker(worker);
      else worker.terminate();
    };
    const onAbort = () => {
      finish(false);
      reject(new DOMException('Render cancelled', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent<RenderResponse>) => {
      const msg = event.data;
      if (msg.jobId !== jobId) return;
      if (msg.type === 'progress') return onProgress(msg.ratio);
      if (msg.type === 'error') {
        finish(false);
        return reject(new Error(msg.message));
      }
      finish(true);
      resolve({ pcm: msg.pcm, channels: msg.channels, frames: msg.frames });
    };
    worker.onerror = (err) => {
      finish(false);
      reject(new Error(err.message || 'Pitch worker failed'));
    };

    const message: RenderRequest = { type: 'render', jobId, ...req };
    // These are already private copies, so hand ownership over instead of
    // letting postMessage clone them — measured at 38ms against 4ms per stem,
    // and it avoids allocating another 90MB.
    const transfer: Transferable[] = [message.left.buffer];
    if (message.right) transfer.push(message.right.buffer);
    worker.postMessage(message, transfer);
  });
}

/* ------------------------------ PCM packing ------------------------------ */

function fromInt16(
  pcm: ArrayBuffer,
  channels: number,
  frames: number,
  ctx: BaseAudioContext,
  sampleRate: number,
): AudioBuffer {
  const view = new Int16Array(pcm);
  const buffer = ctx.createBuffer(channels, frames, sampleRate);
  const left = buffer.getChannelData(0);
  if (channels === 1) {
    for (let i = 0; i < frames; i++) left[i] = view[i] / 0x8000;
    return buffer;
  }
  const right = buffer.getChannelData(1);
  for (let i = 0; i < frames; i++) {
    left[i] = view[i * 2] / 0x8000;
    right[i] = view[i * 2 + 1] / 0x8000;
  }
  return buffer;
}

/* --------------------------------- public -------------------------------- */

export interface ShiftArgs {
  ctx: BaseAudioContext;
  /** Dropbox path — part of the cache key. */
  path: string;
  /** Dropbox rev, so a re-export invalidates old renders. */
  rev: string;
  semitones: number;
  /** Playback speed: 1 unchanged, 0.9 a tenth slower. Pitch is unaffected. */
  tempo?: number;
  source: AudioBuffer;
  budgetBytes: number;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * Return `source` transposed by `semitones`, from cache when possible.
 * A `semitones` of 0 returns the original buffer untouched.
 */
export async function getShiftedBuffer(args: ShiftArgs): Promise<AudioBuffer> {
  const { ctx, semitones, source, budgetBytes } = args;
  const tempo = args.tempo && args.tempo > 0 ? args.tempo : 1;
  if (semitones === 0 && tempo === 1) return source;

  const render = await shiftedPcm(args);
  if (!render.cached) {
    void putRender(render.entry, budgetBytes).catch(() => {
      /* a full cache shouldn't break playback */
    });
  }
  const { pcm, channels, frames, sampleRate } = render.entry;
  return fromInt16(pcm, channels, frames, ctx, sampleRate);
}

/**
 * Render a shift into the cache and keep nothing.
 *
 * For work done ahead of need: preparing a set shifts a song's clips several
 * at a time before printing its parts one by one, and what carries the result
 * from the first pass to the second is the cache, not memory — a song's worth
 * of shifted stems held as floats is what runs the encoder out of room.
 * Returns null once the render is safely stored, and the buffer itself only
 * when the cache would not take it, so the caller can hold it instead.
 */
export async function primeShiftedRender(args: ShiftArgs): Promise<AudioBuffer | null> {
  const { ctx, semitones, budgetBytes } = args;
  const tempo = args.tempo && args.tempo > 0 ? args.tempo : 1;
  if (semitones === 0 && tempo === 1) return null;

  const render = await shiftedPcm(args);
  if (render.cached) return null;
  try {
    await putRender(render.entry, budgetBytes);
    return null;
  } catch {
    const { pcm, channels, frames, sampleRate } = render.entry;
    return fromInt16(pcm, channels, frames, ctx, sampleRate);
  }
}

interface ShiftRender {
  /** True when the cache already had it, so nothing needs writing. */
  cached: boolean;
  entry: { key: string; pcm: ArrayBuffer; channels: number; sampleRate: number; frames: number; bytes: number };
}

/** The shifted PCM: from the cache when it is there, from the worker when not. */
async function shiftedPcm(args: ShiftArgs): Promise<ShiftRender> {
  const { path, rev, semitones, source, onProgress, signal } = args;
  const tempo = args.tempo && args.tempo > 0 ? args.tempo : 1;

  const sampleRate = source.sampleRate;
  // Tempo joins the key: the same file at the same pitch but a different speed
  // is a different render, and must not be served from the other one's cache.
  const key = `${renderKey(path, rev, semitones)}x${tempo.toFixed(4)}@${sampleRate}`;
  const expectedFrames = Math.round(source.length / tempo);

  const cached = await getRender(key);
  if (cached && cached.frames === expectedFrames && cached.sampleRate === sampleRate) {
    onProgress?.(1);
    return {
      cached: true,
      entry: { key, pcm: cached.pcm, channels: cached.channels, sampleRate, frames: cached.frames, bytes: cached.bytes },
    };
  }

  const left = source.getChannelData(0);
  const right = source.numberOfChannels > 1 ? source.getChannelData(1) : null;
  // Keep a mono source mono, rather than storing two identical channels.
  const channels = source.numberOfChannels === 1 ? 1 : 2;

  const rendered = await renderInWorker(
    {
      left: new Float32Array(left),
      right: right ? new Float32Array(right) : null,
      sampleRate,
      semitones,
      tempo,
      channels,
    },
    (ratio) => onProgress?.(ratio),
    signal,
  );

  /*
   * The worker's own frame count, not the source's: a stretch changes the
   * length. Taking it from the source was harmless while only the pitch could
   * change, and silently truncated every stretched render to the original
   * length once tempo was added.
   */
  const outFrames = rendered.frames;
  return {
    cached: false,
    entry: {
      key,
      pcm: rendered.pcm.buffer as ArrayBuffer,
      channels,
      sampleRate,
      frames: outFrames,
      bytes: rendered.pcm.byteLength,
    },
  };
}

/**
 * How many shifts to run at once when a set is being prepared.
 *
 * A core each, leaving one for the page and the encoder, and never more than
 * four: each worker holds its stem as floats going in and 16-bit coming out,
 * which for a long stereo stem is a couple of hundred megabytes apiece.
 */
export function shiftLanes(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, cores - 1));
}

/** Musical name for a transposition, e.g. "+2" or "-3". */
export function formatSemitones(n: number): string {
  if (n === 0) return 'Original';
  return n > 0 ? `+${n}` : `${n}`;
}

const NOTES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_INDEX: Record<string, number> = {
  c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, fb: 4, 'e#': 5,
  f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11, cb: 11,
};

/**
 * Transpose a written key like "F#m" by `semitones`. Returns null when the key
 * can't be parsed, so the UI can fall back to showing the semitone offset.
 */
export function transposeKeyName(key: string | undefined, semitones: number): string | null {
  if (!key) return null;
  // At the original key, keep the spelling as written — Eb should not become D#.
  if (semitones === 0) return key.trim();
  const m = key.trim().match(/^([A-Ga-g][#b♯♭]?)(.*)$/);
  if (!m) return null;
  const root = m[1].replace('♯', '#').replace('♭', 'b').toLowerCase();
  const index = NOTE_INDEX[root];
  if (index == null) return null;
  const shifted = (((index + semitones) % 12) + 12) % 12;
  return NOTES_SHARP[shifted] + m[2];
}

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

/** One worker per job so that cancelling is just a terminate(). */
function renderInWorker(
  req: Omit<RenderRequest, 'type' | 'jobId'>,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<{ pcm: Int16Array; channels: number; frames: number }> {
  return new Promise((resolve, reject) => {
    const worker = spawnWorker();
    const jobId = Math.random().toString(36).slice(2);

    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Render cancelled', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent<RenderResponse>) => {
      const msg = event.data;
      if (msg.jobId !== jobId) return;
      if (msg.type === 'progress') return onProgress(msg.ratio);
      if (msg.type === 'error') {
        cleanup();
        return reject(new Error(msg.message));
      }
      cleanup();
      resolve({ pcm: msg.pcm, channels: msg.channels, frames: msg.frames });
    };
    worker.onerror = (err) => {
      cleanup();
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
  const { ctx, path, rev, semitones, source, budgetBytes, onProgress, signal } = args;
  const tempo = args.tempo && args.tempo > 0 ? args.tempo : 1;
  if (semitones === 0 && tempo === 1) return source;

  const sampleRate = source.sampleRate;
  // Tempo joins the key: the same file at the same pitch but a different speed
  // is a different render, and must not be served from the other one's cache.
  const key = `${renderKey(path, rev, semitones)}x${tempo.toFixed(4)}@${sampleRate}`;
  const expectedFrames = Math.round(source.length / tempo);

  const cached = await getRender(key);
  if (cached && cached.frames === expectedFrames && cached.sampleRate === sampleRate) {
    onProgress?.(1);
    return fromInt16(cached.pcm, cached.channels, cached.frames, ctx, sampleRate);
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
  const buffer = fromInt16(rendered.pcm.buffer as ArrayBuffer, channels, outFrames, ctx, sampleRate);

  void putRender(
    {
      key,
      pcm: rendered.pcm.buffer as ArrayBuffer,
      channels,
      sampleRate,
      frames: outFrames,
      bytes: rendered.pcm.byteLength,
    },
    budgetBytes,
  ).catch(() => {
    /* a full cache shouldn't break playback */
  });

  return buffer;
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

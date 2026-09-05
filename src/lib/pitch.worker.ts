/// <reference lib="webworker" />
// By path, not by package name: the package's exports map offers only the
// worklet, and the text of the whole file is what the engine is drawn from.
import stretchSource from '../../node_modules/signalsmith-stretch/SignalsmithStretch.mjs?raw';
import { loadStretch, stretchOffline, type StretchModule } from './stretch.ts';

/**
 * Offline pitch shifting and time stretching, in a worker of its own.
 *
 * The engine is Signalsmith Stretch — see stretch.ts for how it is driven
 * and why. Rendering ahead of time, rather than as the song plays, keeps
 * playback CPU at zero, which matters because every part of the song is
 * playing at once; and a worker per job means the page never waits, and
 * cancelling is just a terminate().
 */

export interface RenderRequest {
  type: 'render';
  jobId: string;
  left: Float32Array;
  right: Float32Array | null;
  sampleRate: number;
  semitones: number;
  /** Playback speed: 1 is unchanged, 0.9 is a tenth slower. Pitch is unaffected. */
  tempo: number;
  /** 1 keeps a mono source mono, halving both the transfer and the cache. */
  channels: 1 | 2;
}

export type RenderResponse =
  | { type: 'progress'; jobId: string; ratio: number }
  /** Interleaved 16-bit PCM, packed here so the main thread never walks the samples. */
  | { type: 'done'; jobId: string; pcm: Int16Array; channels: number; frames: number }
  | { type: 'error'; jobId: string; message: string };

let engine: Promise<StretchModule> | null = null;

async function render(req: RenderRequest): Promise<RenderResponse> {
  const { jobId, channels } = req;
  engine ??= loadStretch(stretchSource);
  const out = stretchOffline(await engine, {
    left: req.left,
    right: req.right,
    sampleRate: req.sampleRate,
    semitones: req.semitones,
    tempo: req.tempo,
    channels,
    onProgress: (ratio) => {
      const progress: RenderResponse = { type: 'progress', jobId, ratio };
      self.postMessage(progress);
    },
  });

  // Pack to 16-bit here rather than on the main thread: walking eleven million
  // samples per stem there was enough to stall the UI on every key change.
  const frames = out[0].length;
  const pcm = new Int16Array(frames * channels);
  const toPcm = (v: number) => {
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    return c < 0 ? c * 0x8000 : c * 0x7fff;
  };
  if (channels === 1) {
    for (let i = 0; i < frames; i++) pcm[i] = toPcm(out[0][i]);
  } else {
    const [l, r] = out;
    for (let i = 0; i < frames; i++) {
      pcm[i * 2] = toPcm(l[i]);
      pcm[i * 2 + 1] = toPcm(r[i]);
    }
  }
  return { type: 'done', jobId, pcm, channels, frames };
}

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const req = event.data;
  if (req?.type !== 'render') return;
  void render(req)
    .then((result) => {
      if (result.type === 'done') self.postMessage(result, [result.pcm.buffer]);
      else self.postMessage(result);
    })
    .catch((err: unknown) => {
      const message: RenderResponse = {
        type: 'error',
        jobId: req.jobId,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(message);
    });
};

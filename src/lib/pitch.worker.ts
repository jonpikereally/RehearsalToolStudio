/// <reference lib="webworker" />
import { SimpleFilter, SoundTouch, type SampleSource } from 'soundtouchjs';

/**
 * Offline pitch shifting.
 *
 * SoundTouch resamples by the pitch ratio and time-stretches by its inverse, so
 * the result keeps the original duration and therefore the original bar grid.
 * Rendering ahead of time (rather than in real time) keeps playback CPU at zero,
 * which matters because every variant of the song is playing at once.
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

/**
 * Bounds-checked replacement for the library's own WebAudioBufferSource, which
 * reads past the end of the channel data and can return a negative frame count.
 *
 * It also serves silence for `tailFrames` beyond the real audio. SoundTouch's
 * `fillOutputBuffer` refuses to process a final partial block, so without a
 * silent tail to push it through, the last few hundred milliseconds of every
 * render are dropped — which would leave transposed audio shorter than the
 * original and break the bar grid.
 */
class ArraySource implements SampleSource {
  private readonly total: number;

  constructor(
    private left: Float32Array,
    private right: Float32Array,
    tailFrames: number,
  ) {
    this.total = left.length + tailFrames;
  }

  extract(target: Float32Array, numFrames: number, position: number): number {
    const available = Math.max(0, Math.min(numFrames, this.total - position));
    const realEnd = this.left.length;
    for (let i = 0; i < available; i++) {
      const index = position + i;
      const inRange = index < realEnd;
      target[i * 2] = inRange ? this.left[index] : 0;
      target[i * 2 + 1] = inRange ? this.right[index] : 0;
    }
    // Zero any tail the caller might otherwise read as stale data.
    for (let i = available; i < numFrames; i++) {
      target[i * 2] = 0;
      target[i * 2 + 1] = 0;
    }
    return available;
  }
}

const CHUNK = 8192;

/**
 * Silence fed after the real audio so the pipeline flushes. Must comfortably
 * exceed SoundTouch's 16384-frame input threshold, scaled for the resampler
 * consuming more input than it emits when shifting up.
 */
const FLUSH_TAIL_FRAMES = 1 << 18; // 262144 frames ≈ 5.9 s at 44.1 kHz

function render(req: RenderRequest): RenderResponse {
  const { left, right, semitones, jobId } = req;
  const tempo = req.tempo > 0 ? req.tempo : 1;
  const inFrames = left.length;
  const rightChannel = right ?? left;

  /*
   * Stretching changes the length: at tempo 0.9 the audio takes 1/0.9 as long.
   * Rounding here is what keeps every stem of a song exactly the same length —
   * they all start from the same frame count, so they all land on the same one.
   */
  const frames = Math.round(inFrames / tempo);

  const outLeft = new Float32Array(frames);
  const outRight = new Float32Array(frames);

  const soundtouch = new SoundTouch();
  soundtouch.rate = 1;
  soundtouch.tempo = tempo;
  soundtouch.pitchSemitones = semitones;

  const filter = new SimpleFilter(
    new ArraySource(left, rightChannel, FLUSH_TAIL_FRAMES),
    soundtouch,
  );

  const interleaved = new Float32Array(CHUNK * 2);
  let written = 0;
  let lastReport = 0;

  while (written < frames) {
    const got = filter.extract(interleaved, CHUNK);
    if (got <= 0) break; // source exhausted

    const n = Math.min(got, frames - written);
    for (let i = 0; i < n; i++) {
      outLeft[written + i] = interleaved[i * 2];
      outRight[written + i] = interleaved[i * 2 + 1];
    }
    written += n;

    const ratio = written / frames;
    if (ratio - lastReport > 0.02) {
      lastReport = ratio;
      const progress: RenderResponse = { type: 'progress', jobId, ratio };
      self.postMessage(progress);
    }
  }

  // Pack to 16-bit here rather than on the main thread: walking eleven million
  // samples per stem there was enough to stall the UI on every key change.
  const channels = req.channels;
  const pcm = new Int16Array(frames * channels);
  const toPcm = (v: number) => {
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    return c < 0 ? c * 0x8000 : c * 0x7fff;
  };
  if (channels === 1) {
    for (let i = 0; i < frames; i++) pcm[i] = toPcm(outLeft[i]);
  } else {
    for (let i = 0; i < frames; i++) {
      pcm[i * 2] = toPcm(outLeft[i]);
      pcm[i * 2 + 1] = toPcm(outRight[i]);
    }
  }

  // The stretch algorithm can finish a few frames short; the tail is silence
  // anyway and holding the exact length keeps every variant frame-aligned.
  return { type: 'done', jobId, pcm, channels, frames };
}

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const req = event.data;
  if (req?.type !== 'render') return;
  try {
    const result = render(req);
    if (result.type === 'done') {
      self.postMessage(result, [result.pcm.buffer]);
    } else {
      self.postMessage(result);
    }
  } catch (err: any) {
    const message: RenderResponse = {
      type: 'error',
      jobId: req.jobId,
      message: err?.message ?? String(err),
    };
    self.postMessage(message);
  }
};

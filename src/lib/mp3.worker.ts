import { Mp3Encoder } from '@breezystack/lamejs';

/**
 * MP3 encoding, off the main thread.
 *
 * A five-minute stereo track is some thirteen million samples and takes several
 * seconds to encode; done on the main thread the whole app would sit frozen
 * through it. The same reason the pitch renders live in a worker.
 *
 * Float samples arrive already gain-corrected — the caller decides how loud the
 * mix is, this only turns it into a file.
 */

export interface EncodeRequest {
  jobId: string;
  left: Float32Array;
  right: Float32Array | null;
  sampleRate: number;
  /** kbps. 192 is transparent enough for practice and about 1.4 MB a minute. */
  bitrate: number;
}

export type EncodeResponse =
  | { type: 'progress'; jobId: string; ratio: number }
  | { type: 'done'; jobId: string; bytes: ArrayBuffer }
  | { type: 'error'; jobId: string; message: string };

/** lamejs wants 16-bit integers, and takes them a block at a time. */
const BLOCK = 1152;

function toInt16(samples: Float32Array, at: number, count: number, out: Int16Array): void {
  for (let i = 0; i < count; i++) {
    const v = samples[at + i];
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    out[i] = c < 0 ? c * 0x8000 : c * 0x7fff;
  }
}

function encode(req: EncodeRequest): EncodeResponse {
  const { left, right, sampleRate, bitrate, jobId } = req;
  const channels = right ? 2 : 1;
  const encoder = new Mp3Encoder(channels, sampleRate, bitrate);

  const frames = left.length;
  const chunks: Uint8Array[] = [];
  const l = new Int16Array(BLOCK);
  const r = new Int16Array(BLOCK);
  let lastReport = 0;

  for (let at = 0; at < frames; at += BLOCK) {
    const count = Math.min(BLOCK, frames - at);
    toInt16(left, at, count, l);
    if (right) toInt16(right, at, count, r);

    // A short final block has to be passed at its real length, not padded, or
    // the file ends with a fragment of whatever the buffer held before.
    const block =
      count === BLOCK
        ? right
          ? encoder.encodeBuffer(l, r)
          : encoder.encodeBuffer(l)
        : right
          ? encoder.encodeBuffer(l.subarray(0, count), r.subarray(0, count))
          : encoder.encodeBuffer(l.subarray(0, count));
    if (block.length) chunks.push(new Uint8Array(block));

    const ratio = at / frames;
    if (ratio - lastReport > 0.02) {
      lastReport = ratio;
      const progress: EncodeResponse = { type: 'progress', jobId, ratio };
      self.postMessage(progress);
    }
  }

  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));

  let size = 0;
  for (const c of chunks) size += c.length;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { type: 'done', jobId, bytes: bytes.buffer };
}

self.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const req = event.data;
  try {
    const done = encode(req);
    // Transferred rather than copied: the file can be several megabytes.
    self.postMessage(done, done.type === 'done' ? [done.bytes] : []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'error', jobId: req.jobId, message } satisfies EncodeResponse);
  }
};

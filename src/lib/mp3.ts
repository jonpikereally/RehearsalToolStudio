import type { EncodeRequest, EncodeResponse } from './mp3.worker';

/**
 * Turning a rendered mix into a file small enough to live on a phone.
 *
 * MP3 rather than AAC or Opus: the browser ships no encoder at all, so one has
 * to be carried either way, and MP3 needs no container muxing and plays on
 * anything a band member might own. lamejs is LGPL, as SoundTouch already is.
 *
 * At 192 kbps a five-minute song is about 7 MB a part, against 50 MB as WAV.
 */

export const DEFAULT_BITRATE = 192;

/**
 * MP3 decodes back slightly longer than it went in.
 *
 * The encoder needs a lead-in, and browsers don't all trim it, so a 5.00s
 * buffer comes back around 5.04s with the extra at the *front*. Every part of a
 * song gets the same padding, so they stay locked to each other — but the whole
 * song sits a fraction late against its bar grid, which is what
 * `firstBarOffsetSec` exists to absorb. Measure rather than assume: it depends
 * on the encoder build, and `measurePadding` reports what this one actually
 * does.
 */
export async function measurePadding(sampleRate = 48000): Promise<number> {
  const seconds = 2;
  const ctx = new OfflineAudioContext(1, sampleRate * seconds, sampleRate);
  const probe = ctx.createBuffer(1, sampleRate * seconds, sampleRate);
  const data = probe.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;

  const blob = await encodeMp3(probe, { bitrate: 128 });
  const back = await new OfflineAudioContext(1, sampleRate, sampleRate).decodeAudioData(
    await blob.arrayBuffer(),
  );
  return Math.max(0, back.duration - seconds);
}

function spawnWorker(): Worker {
  return new Worker(new URL('./mp3.worker.ts', import.meta.url), { type: 'module' });
}

let nextJob = 0;

/**
 * How long the encoder may go quiet before it is declared dead.
 *
 * It reports every two per cent, which on any part is well under a second of
 * work, so a minute of silence is not slowness — it is a worker that has gone.
 * A worker the browser kills, typically for memory, fires no error event and
 * posts no message, so without this the promise simply never settles and the
 * dialog sits at whatever percentage it had reached. Ten minutes at 82% is not
 * a thing anyone should have to guess at.
 */
const STALL_MS = 60_000;

export interface EncodeOptions {
  bitrate?: number;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** Encode a rendered buffer to MP3. Mono in, mono out; anything else is stereo. */
export function encodeMp3(buffer: AudioBuffer, opts: EncodeOptions = {}): Promise<Blob> {
  const { bitrate = DEFAULT_BITRATE, onProgress, signal } = opts;

  return new Promise<Blob>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Encode cancelled', 'AbortError'));
      return;
    }

    const jobId = `mp3_${++nextJob}`;
    const worker = spawnWorker();

    let reached = 0;
    let heard = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - heard < STALL_MS) return;
      finish(() =>
        reject(
          new Error(
            `the encoder stopped responding at ${Math.round(reached * 100)}% — it was most ` +
              'likely killed for memory. Close other songs and try this part on its own.',
          ),
        ),
      );
    }, 5_000);

    const finish = (fn: () => void) => {
      clearInterval(watchdog);
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new DOMException('Encode cancelled', 'AbortError')));
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
      const msg = event.data;
      if (msg.jobId !== jobId) return;
      heard = Date.now();
      if (msg.type === 'progress') {
        reached = msg.ratio;
        onProgress?.(msg.ratio);
        return;
      }
      if (msg.type === 'error') {
        finish(() => reject(new Error(msg.message)));
        return;
      }
      finish(() => resolve(new Blob([msg.bytes], { type: 'audio/mpeg' })));
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'Encoder failed')));
    // A message that cannot be deserialised is still the worker answering, and
    // still the end of this job — not something to wait out.
    worker.onmessageerror = () => finish(() => reject(new Error('the encoder sent something unreadable')));

    // Copied out of the AudioBuffer so they can be transferred rather than
    // cloned — several megabytes each, and cloning them shows on the main thread.
    const left = new Float32Array(buffer.getChannelData(0));
    const right =
      buffer.numberOfChannels > 1 ? new Float32Array(buffer.getChannelData(1)) : null;

    const request: EncodeRequest = {
      jobId,
      left,
      right,
      sampleRate: buffer.sampleRate,
      bitrate,
    };
    const transfer: Transferable[] = [left.buffer];
    if (right) transfer.push(right.buffer);
    worker.postMessage(request, transfer);
  });
}

/**
 * Apply a gain to a buffer, returning a copy.
 *
 * Rendering can sum past full scale, and unlike a WAV of integers an MP3 will
 * simply distort — so the caller pulls the mix down before it reaches the
 * encoder rather than after.
 */
export function withGain(buffer: AudioBuffer, gain: number): AudioBuffer {
  if (gain === 1) return buffer;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }
  return buffer;
}

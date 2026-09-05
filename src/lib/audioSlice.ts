/**
 * Cutting a stretch out of a PCM file without reading the rest of it.
 *
 * A frozen track's file is Live's render of the whole arrangement, so in a
 * set of twenty songs it is two hours long and, as 32-bit float at 48 kHz,
 * a couple of gigabytes — far past what a browser will decode in one go,
 * and twenty times more than any one song wants. But it is plain PCM in a
 * WAV or an AIFF, whose headers say exactly where each sample sits, so a
 * song's stretch of it can be fetched as a byte range and wrapped in a
 * header of its own: a small, ordinary file the decoder takes as it takes
 * any other. Nothing is resampled or converted here; the samples are the
 * file's own, and the decoder still does what it does to every file.
 */

export interface PcmHeader {
  kind: 'wav' | 'aiff';
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Bytes per frame across all channels. */
  frameBytes: number;
  /** Where the sample data begins in the file, in bytes. */
  dataOffset: number;
  /** How many frames the file holds. */
  frames: number;
  /** WAV: the format tag (1 PCM, 3 float, 0xFFFE extensible). AIFC: its compression type. */
  format: number | string;
  /** The `fmt ` chunk verbatim, to be written back unchanged. */
  fmt?: Uint8Array;
  /** AIFC's compression type and name, kept verbatim for the same reason. */
  aifcCompression?: Uint8Array;
}

const ascii = (view: DataView, at: number, n: number): string => {
  let out = '';
  for (let i = 0; i < n; i++) out += String.fromCharCode(view.getUint8(at + i));
  return out;
};

/**
 * What the first few kilobytes of a file say about the rest of it, or null
 * when they are not a WAV or an AIFF this can cut. `fileSize` bounds the
 * data chunk when the header's own count is missing or wrong — a file still
 * being written says zero.
 */
export function probePcmHeader(head: ArrayBuffer, fileSize: number): PcmHeader | null {
  const view = new DataView(head);
  if (head.byteLength < 12) return null;
  const magic = ascii(view, 0, 4);
  if (magic === 'RIFF' && ascii(view, 8, 4) === 'WAVE') return probeWav(view, fileSize);
  if (magic === 'FORM' && /^AIF[FC]$/.test(ascii(view, 8, 4))) return probeAiff(view, fileSize, ascii(view, 8, 4) === 'AIFC');
  return null;
}

function probeWav(view: DataView, fileSize: number): PcmHeader | null {
  let at = 12;
  let fmt: Uint8Array | null = null;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let blockAlign = 0;
  while (at + 8 <= view.byteLength) {
    const id = ascii(view, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      if (at + 8 + Math.min(size, 40) > view.byteLength) return null;
      fmt = new Uint8Array(view.buffer.slice(at, at + 8 + size));
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      blockAlign = view.getUint16(at + 20, true);
      bits = view.getUint16(at + 22, true);
      // Extensible carries the real tag in its sub-format GUID's first word.
      if (format === 0xfffe && size >= 26) format = view.getUint16(at + 32, true);
    } else if (id === 'data') {
      if (!fmt || !channels || !sampleRate || !blockAlign) return null;
      if (format !== 1 && format !== 3) return null; // only integer and float PCM
      const dataOffset = at + 8;
      const declared = size === 0 || size === 0xffffffff ? fileSize - dataOffset : size;
      const bytes = Math.max(0, Math.min(declared, fileSize - dataOffset));
      return {
        kind: 'wav',
        sampleRate,
        channels,
        bitsPerSample: bits,
        frameBytes: blockAlign,
        dataOffset,
        frames: Math.floor(bytes / blockAlign),
        format,
        fmt,
      };
    }
    at += 8 + size + (size % 2); // chunks are word aligned
  }
  return null;
}

/** An 80-bit IEEE extended float, which is how AIFF writes a sample rate. */
function extendedToNumber(view: DataView, at: number): number {
  const sign = view.getUint8(at) & 0x80 ? -1 : 1;
  const exponent = ((view.getUint8(at) & 0x7f) << 8) | view.getUint8(at + 1);
  const hi = view.getUint32(at + 2);
  const lo = view.getUint32(at + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

function probeAiff(view: DataView, fileSize: number, aifc: boolean): PcmHeader | null {
  let at = 12;
  let channels = 0;
  let frames = 0;
  let bits = 0;
  let sampleRate = 0;
  let compression: Uint8Array | undefined;
  let compressionType = 'NONE';
  while (at + 8 <= view.byteLength) {
    const id = ascii(view, at, 4);
    const size = view.getUint32(at + 4);
    if (id === 'COMM') {
      if (at + 8 + 18 > view.byteLength) return null;
      channels = view.getInt16(at + 8);
      frames = view.getUint32(at + 10);
      bits = view.getInt16(at + 14);
      sampleRate = extendedToNumber(view, at + 16);
      if (aifc && size > 18) {
        compressionType = ascii(view, at + 26, 4);
        compression = new Uint8Array(view.buffer.slice(at + 26, at + 8 + size));
      }
    } else if (id === 'SSND') {
      if (!channels || !sampleRate || !bits) return null;
      if (!/^(NONE|sowt|fl32|FL32|fl64|FL64)$/.test(compressionType)) return null; // only plain PCM
      const offset = view.getUint32(at + 8);
      const dataOffset = at + 16 + offset;
      const frameBytes = channels * Math.ceil(bits / 8);
      const inFile = Math.floor(Math.max(0, fileSize - dataOffset) / frameBytes);
      return {
        kind: 'aiff',
        sampleRate,
        channels,
        bitsPerSample: bits,
        frameBytes,
        dataOffset,
        frames: frames > 0 ? Math.min(frames, inFile) : inFile,
        format: compressionType,
        aifcCompression: compression,
      };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** The byte range of `frames` frames from `startFrame`, clipped to the file. */
export function byteRangeOf(header: PcmHeader, startFrame: number, frames: number): { start: number; end: number; frames: number } {
  const from = Math.max(0, Math.min(header.frames, Math.floor(startFrame)));
  const count = Math.max(0, Math.min(header.frames - from, Math.ceil(frames)));
  return {
    start: header.dataOffset + from * header.frameBytes,
    end: header.dataOffset + (from + count) * header.frameBytes,
    frames: count,
  };
}

/** How many frames `seconds` is in this file, rounded down to a frame. */
export function frameAt(header: PcmHeader, seconds: number): number {
  return Math.max(0, Math.floor(seconds * header.sampleRate));
}

/**
 * The slice as a file of its own: the same samples under a header that
 * says only they exist. WAV stays WAV and AIFF stays AIFF, so every field
 * the decoder reads is one the original carried.
 */
export function wrapPcmSlice(header: PcmHeader, data: ArrayBuffer): ArrayBuffer {
  const frames = Math.floor(data.byteLength / header.frameBytes);
  const dataBytes = frames * header.frameBytes;
  if (header.kind === 'wav') {
    const fmt = header.fmt!;
    const pad = dataBytes % 2;
    const out = new ArrayBuffer(12 + fmt.byteLength + 8 + dataBytes + pad);
    const view = new DataView(out);
    const bytes = new Uint8Array(out);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    view.setUint32(4, out.byteLength - 8, true);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    bytes.set(fmt, 12);
    let at = 12 + fmt.byteLength;
    bytes.set([0x64, 0x61, 0x74, 0x61], at); // data
    view.setUint32(at + 4, dataBytes, true);
    bytes.set(new Uint8Array(data, 0, dataBytes), at + 8);
    return out;
  }

  const aifc = !!header.aifcCompression;
  const commSize = 18 + (header.aifcCompression?.byteLength ?? 0);
  const out = new ArrayBuffer(12 + 8 + commSize + (commSize % 2) + 16 + dataBytes + (dataBytes % 2));
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  bytes.set([0x46, 0x4f, 0x52, 0x4d], 0); // FORM
  view.setUint32(4, out.byteLength - 8);
  bytes.set(aifc ? [0x41, 0x49, 0x46, 0x43] : [0x41, 0x49, 0x46, 0x46], 8); // AIFC / AIFF
  let at = 12;
  bytes.set([0x43, 0x4f, 0x4d, 0x4d], at); // COMM
  view.setUint32(at + 4, commSize);
  view.setInt16(at + 8, header.channels);
  view.setUint32(at + 10, frames);
  view.setInt16(at + 14, header.bitsPerSample);
  writeExtended(view, at + 16, header.sampleRate);
  if (header.aifcCompression) bytes.set(header.aifcCompression, at + 26);
  at += 8 + commSize + (commSize % 2);
  bytes.set([0x53, 0x53, 0x4e, 0x44], at); // SSND
  view.setUint32(at + 4, 8 + dataBytes);
  view.setUint32(at + 8, 0);
  view.setUint32(at + 12, 0);
  bytes.set(new Uint8Array(data, 0, dataBytes), at + 16);
  return out;
}

function writeExtended(view: DataView, at: number, value: number): void {
  if (value === 0) {
    for (let i = 0; i < 10; i++) view.setUint8(at + i, 0);
    return;
  }
  let exponent = Math.floor(Math.log2(value));
  let mantissa = value / 2 ** exponent; // 1 <= mantissa < 2
  exponent += 16383;
  mantissa *= 2 ** 63;
  const hi = Math.floor(mantissa / 2 ** 32);
  const lo = Math.floor(mantissa % 2 ** 32);
  view.setUint8(at, (exponent >> 8) & 0x7f);
  view.setUint8(at + 1, exponent & 0xff);
  view.setUint32(at + 2, hi);
  view.setUint32(at + 6, lo);
}

/** How many bytes of a file's head are enough to find its data chunk. */
export const PCM_HEAD_BYTES = 64 * 1024;

/** A byte range of a file, and how long the whole file is. */
export type RangeReader = (start: number, end: number) => Promise<{ bytes: ArrayBuffer; size: number }>;

/**
 * The stretch of a PCM file from `startSec` for `durationSec`, as a file of
 * its own, plus where it actually begins — a frame boundary at or just
 * before `startSec`. Null when the file is not one this can cut, in which
 * case the whole of it is the only option. A window beyond the end of the
 * file comes back as a few frames of silence.
 */
export async function readPcmWindow(
  read: RangeReader,
  startSec: number,
  durationSec: number,
): Promise<{ bytes: ArrayBuffer; fromSec: number } | null> {
  const head = await read(0, PCM_HEAD_BYTES);
  const header = probePcmHeader(head.bytes, head.size);
  if (!header) return null;
  const startFrame = frameAt(header, startSec);
  const range = byteRangeOf(header, startFrame, durationSec * header.sampleRate);
  /*
   * A window past the end of the file is a clip of nothing: Live leaves a
   * stub of a freeze clip at the very end of what it rendered. A few frames
   * of silence stand in, rather than the whole file fetched to play none of it.
   */
  if (range.frames <= 0) {
    return { bytes: wrapPcmSlice(header, new ArrayBuffer(header.frameBytes * 64)), fromSec: startFrame / header.sampleRate };
  }
  const data = await read(range.start, range.end);
  return { bytes: wrapPcmSlice(header, data.bytes), fromSec: startFrame / header.sampleRate };
}

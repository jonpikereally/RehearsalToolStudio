/**
 * Printing the current mix to a file.
 *
 * The whole point is that a bounce is *what you were hearing*: the same faders,
 * pans, mutes and solo, and the same key and speed, since the buffers in the
 * engine are already transposed and stretched. Mute the vocal and print, and
 * you have an instrumental.
 *
 * Rendered offline, which is much faster than realtime and doesn't disturb
 * playback.
 */

export interface BounceTrack {
  buffer: AudioBuffer;
  /** Fader position, as the engine has it. */
  level: number;
  /** -1 hard left, 0 centre, +1 hard right. */
  pan: number;
  /** Stretches this part sounds in. Absent means throughout. */
  regions?: { startSec: number; endSec: number }[];
  /** Song time at which the file's first sample plays. Absent means bar 1. */
  fileStartSec?: number;
}

/** Mix the tracks down through the same graph shape the engine plays them with. */
export async function renderMix(
  tracks: BounceTrack[],
  onProgress?: (ratio: number) => void,
): Promise<AudioBuffer> {
  if (!tracks.length) throw new Error('Nothing is audible to print — every channel is silent.');

  const sampleRate = tracks[0].buffer.sampleRate;
  const frames = Math.max(
    ...tracks.map((t) => Math.ceil(Math.max(0, t.fileStartSec ?? 0) * sampleRate) + t.buffer.length),
  );
  // Always stereo: panning a mono source produces two channels anyway.
  const ctx = new OfflineAudioContext(2, frames, sampleRate);

  for (const track of tracks) {
    const source = ctx.createBufferSource();
    source.buffer = track.buffer;
    const gain = ctx.createGain();
    if (track.regions) {
      /*
       * The arrangement, printed. A stem file usually runs the whole song even
       * where the part drops out, so without this the print would contain
       * something the song itself doesn't play.
       */
      const g = gain.gain;
      const startsInside = track.regions.some((r) => r.startSec <= 0 && r.endSec > 0);
      g.setValueAtTime(startsInside ? track.level : 0, 0);
      for (const region of track.regions) {
        if (region.startSec > 0) g.setValueAtTime(track.level, region.startSec);
        g.setValueAtTime(0, region.endSec);
      }
    } else {
      gain.gain.value = track.level;
    }
    source.connect(gain);

    if (typeof ctx.createStereoPanner === 'function' && track.pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = track.pan;
      gain.connect(panner);
      panner.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    // Placed where the set puts it: later than bar 1, or entered partway.
    const at = track.fileStartSec ?? 0;
    if (at >= 0) source.start(at, 0);
    else source.start(0, Math.min(-at, track.buffer.duration));
  }

  onProgress?.(0.1);
  const mixed = await ctx.startRendering();
  onProgress?.(1);
  return mixed;
}

/**
 * True peak of a rendered mix, so the caller can warn about clipping.
 *
 * Summing several stems at unity can easily exceed 0 dBFS, and a WAV of
 * floats-turned-integers just wraps to a nasty crackle if it does.
 */
export function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * A 16-bit PCM WAV.
 *
 * WAV rather than MP3 because it needs no encoder: the browser ships no MP3
 * encoder, and pulling one in is a dependency and a licence for something the
 * band will mostly play once. The cost is size — about 10 MB a minute.
 *
 * `gain` is applied on the way out, which is how the caller pulls a hot mix
 * back under 0 dBFS rather than letting it wrap.
 */
export function encodeWav(buffer: AudioBuffer, gain = 1): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;

  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const ascii = (offset: string | number, text?: string) => {
    const at = offset as number;
    const s = text as string;
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const left = buffer.getChannelData(0);
  const right = channels > 1 ? buffer.getChannelData(1) : left;
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const raw = (c === 0 ? left[i] : right[i]) * gain;
      const clamped = raw < -1 ? -1 : raw > 1 ? 1 : raw;
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

/**
 * A file name the scan will read back as a version of the same song.
 *
 * Everything except the title has to sit inside the round brackets: they are
 * the version tag, and anything outside them is read as the song's name, so a
 * date left loose would split the print off into a song of its own.
 *
 * `Fix You (no vocal v2 2026-08-13 rehearsaltool).wav`
 */
export function bounceFileName(
  songTitle: string,
  label: string,
  version: number,
  when = new Date(),
): string {
  const clean = label.replace(/[\\/:*?"<>|[\]{}()]/g, '').trim() || 'mix';
  const date = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  ].join('-');
  return `${songTitle} (${clean} v${version} ${date} rehearsaltool).wav`;
}

/**
 * The next version number for this label.
 *
 * Counts prints already sitting in the library under the same name, so a second
 * "no vocal" is v2 rather than colliding — the upload wouldn't overwrite it in
 * any case, but "(1)" appended by Dropbox says less than a version number.
 */
export function nextVersion(existingNames: string[], label: string): number {
  const clean = label.trim().toLowerCase();
  let highest = 0;
  for (const name of existingNames) {
    const m = name.toLowerCase().match(/^(.*?)\s+v(\d+)\b/);
    if (m && m[1] === clean) highest = Math.max(highest, Number(m[2]));
  }
  return highest + 1;
}

/**
 * Where a print belongs: beside the stems it was made from.
 *
 * An Ableton project keeps its stems in their own folder, well away from the
 * set file, and that is where the rest of the song's audio lives — dropping a
 * bounce next to the .als instead would scatter one song across two places.
 */
export function bounceFolder(
  variants: { path: string; role?: string }[],
  fallback: string,
): string {
  const stem = variants.find((v) => v.role === 'stem') ?? variants[0];
  if (!stem) return fallback;
  const cut = stem.path.lastIndexOf('/');
  return cut > 0 ? stem.path.slice(0, cut) : fallback;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

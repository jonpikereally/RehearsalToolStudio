/**
 * Rendering a track's clips down to one continuous part.
 *
 * A track in a set is a row of clips: pieces of one or more files, each placed
 * at a point in the song, possibly starting part way into its file, possibly
 * faded, possibly switched off. Playing "the track" means playing all of that,
 * which the browser can't do from a single file — so it is flattened here into
 * one buffer the length of the song, which the player then treats as an
 * ordinary stem.
 *
 * Rendered offline: faster than realtime, and silent.
 */

export interface ClipPlacement {
  /** The decoded source file this clip plays from. */
  buffer: AudioBuffer;
  /** Where the clip sits in the song. */
  startSec: number;
  endSec: number;
  /** How far into the file the clip begins. */
  sourceStartSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** The clip's level, linear; 1 when absent. Fades ramp to it. */
  gain?: number;
}

/** How much of a fade to allow, as a share of the clip; a fade can't outlast it. */
function clampFade(fade: number, span: number): number {
  if (!(fade > 0)) return 0;
  return Math.min(fade, span / 2);
}

/**
 * Flatten clips into one buffer of `durationSec`.
 *
 * Gaps between clips are silence, which is the point: a part that drops out for
 * eight bars has eight bars of nothing rather than the file playing underneath.
 */
export async function renderTrack(
  clips: ClipPlacement[],
  durationSec: number,
  sampleRate: number,
  channels = 2,
): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const ctx = new OfflineAudioContext(channels, frames, sampleRate);

  for (const clip of clips) {
    const span = clip.endSec - clip.startSec;
    if (span <= 0) continue;

    /*
     * How much of the file is actually left at this offset. A clip can be drawn
     * longer than its file — Ableton just plays silence past the end — so the
     * source is asked only for what exists, and the rest of the span stays
     * silent rather than looping or erroring.
     */
    const available = clip.buffer.duration - clip.sourceStartSec;
    if (available <= 0) continue;
    const playFor = Math.min(span, available);

    const source = ctx.createBufferSource();
    source.buffer = clip.buffer;

    const gain = ctx.createGain();
    const fadeIn = clampFade(clip.fadeInSec, playFor);
    const fadeOut = clampFade(clip.fadeOutSec, playFor);
    const startAt = Math.max(0, clip.startSec);
    const endAt = startAt + playFor;

    const level = clip.gain ?? 1;
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(level, startAt + fadeIn);
    } else {
      gain.gain.setValueAtTime(level, startAt);
    }
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(level, endAt - fadeOut);
      gain.gain.linearRampToValueAtTime(0, endAt);
    }

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(startAt, clip.sourceStartSec, playFor);
  }

  return ctx.startRendering();
}

/**
 * Whether a track needs rendering at all.
 *
 * One clip, playing its file from the top for the whole song, is the file — so
 * it can be used as it is rather than copied through an offline render for
 * nothing. This is the common case for exported stems, and skipping it is the
 * difference between a set preparing in seconds and in minutes.
 */
export function needsRender(
  clips: { startSec: number; endSec: number; sourceStartSec: number; fadeInSec: number; fadeOutSec: number }[],
  durationSec: number,
): boolean {
  if (clips.length !== 1) return true;
  const [only] = clips;
  return (
    only.startSec > 0.001 ||
    only.sourceStartSec > 0.001 ||
    only.endSec < durationSec - 0.001 ||
    only.fadeInSec > 0.001 ||
    only.fadeOutSec > 0.001
  );
}

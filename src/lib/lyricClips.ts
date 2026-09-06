import type { AlsProject } from './alsParser';
import type { ChordClip } from './chordTrack.ts';
import type { TranscribedSegment } from './lyricsStudio.ts';

/**
 * Timed words from Lyrics Studio as clips on the set's own ruler.
 *
 * Lyrics Studio answers in arrangement seconds and beats, through the set's
 * tempo map, so a word is where it was sung whatever the tempo did. Here
 * those become named clips: one per line, per section or per word, as the
 * person asked, each running until it ends or the next begins, and never
 * overlapping — Live trims overlapping clips on load and says so line by
 * line.
 */

export type LyricFineness = 'line' | 'section' | 'word';

export const FINENESS_LABEL: Record<LyricFineness, string> = {
  line: 'A clip per line',
  section: 'A clip per section',
  word: 'A clip per word',
};

interface Span {
  startBeat: number;
  endBeat: number;
  endSec: number;
  startSec: number;
  text: string;
}

export function lyricClipsFrom(
  segments: TranscribedSegment[],
  project: AlsProject,
  fineness: LyricFineness,
  /** Two lines closer than this, in seconds, are one section. */
  gapSec = 2,
): ChordClip[] {
  const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
  const toBar = (beat: number) => beat / beatsPerBar + 1;

  let spans: Span[];
  if (fineness === 'word') {
    spans = segments.flatMap((s) =>
      s.words.length
        ? s.words.map((w) => ({ startBeat: w.startBeat, endBeat: w.endBeat, startSec: w.start, endSec: w.end, text: w.text }))
        : [{ startBeat: s.startBeat, endBeat: s.endBeat, startSec: s.start, endSec: s.end, text: s.text }],
    );
  } else if (fineness === 'line') {
    spans = segments.map((s) => ({ startBeat: s.startBeat, endBeat: s.endBeat, startSec: s.start, endSec: s.end, text: s.text }));
  } else {
    spans = [];
    for (const s of segments) {
      const last = spans[spans.length - 1];
      if (last && s.start - last.endSec < gapSec) {
        last.endBeat = s.endBeat;
        last.endSec = s.end;
        last.text = `${last.text} ${s.text}`;
      } else {
        spans.push({ startBeat: s.startBeat, endBeat: s.endBeat, startSec: s.start, endSec: s.end, text: s.text });
      }
    }
  }

  const clips = spans
    .filter((s) => s.text.trim())
    .sort((a, b) => a.startBeat - b.startBeat)
    .map((s) => ({
      // On a sixteenth, as a hand would place it.
      bar: Math.round(toBar(s.startBeat) * 16) / 16,
      text: s.text.replace(/\s+/g, ' ').trim(),
      bars: Math.max(0.25, Math.round(((s.endBeat - s.startBeat) / beatsPerBar) * 16) / 16),
    }));
  for (let i = 0; i < clips.length; i++) {
    const next = clips[i + 1];
    if (next) clips[i].bars = Math.max(0.25, Math.min(clips[i].bars, next.bar - clips[i].bar));
  }
  return clips;
}

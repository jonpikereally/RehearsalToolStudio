import type { TimedText } from '../types';

/**
 * Timed text as something you can type.
 *
 * The chart stores lyrics and chords as `{bar, text}` pairs; a person types
 * lines. The bridge is a bar in square brackets at the head of a line:
 *
 *   [1] Look at the stars
 *   [5] Look how they shine for you
 *
 * Lines without a bracket follow the previous line by a phrase — four bars —
 * because most lyrics move at that pace and a guess you can see beats a form
 * you must fill in. Chords want a bar on every line; the same parser serves,
 * the editor just says so in its placeholder.
 */

const LINE = /^\s*\[(\d+(?:\.\d+)?)\]\s*(.*)$/;

/** A phrase, when a line doesn't say where it lands. */
const BARS_PER_LINE = 4;

export function parseTimedLines(text: string): TimedText[] {
  const out: TimedText[] = [];
  let nextBar = 1;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = LINE.exec(line);
    const bar = m ? Number(m[1]) : nextBar;
    const words = (m ? m[2] : line).trim();
    if (!words) continue;
    out.push({ bar, text: words });
    nextBar = bar + BARS_PER_LINE;
  }
  return out.sort((a, b) => a.bar - b.bar);
}

export function formatTimedLines(items: TimedText[] | undefined): string {
  return (items ?? []).map((item) => `[${item.bar}] ${item.text}`).join('\n');
}

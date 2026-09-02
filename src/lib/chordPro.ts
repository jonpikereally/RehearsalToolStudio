import type { AlsProject, AlsSong } from './alsParser';
import { isNashvilleLane, looksNashville } from './nashville.ts';

/**
 * A song's chart as ChordPro (chordpro.org).
 *
 * The `.lrc` beside it is for a machine: timestamps to scroll by, no chords,
 * no sections. This is for a person — chords over the words, sections named,
 * key and tempo at the top — and every chart app and songbook printer reads
 * it, so a prepared set is worth something outside this app too.
 *
 * Chords are placed by bar, which is all a set knows. Where a set marks a
 * chord mid-line, that chord lands at the head of the line rather than over
 * the syllable it belongs to: the set never said which syllable. Bars with
 * chords and no words become chord-only lines, so an intro or a solo still
 * shows its changes.
 */

export interface ChartLine {
  bar: number;
  text: string;
}

const directive = (name: string, value: string | number | undefined) =>
  value === undefined || value === '' ? null : `{${name}: ${value}}`;

/**
 * The lane to write chords from: names rather than numbers, a chart being
 * something to play from. A set that only wrote numbers charts in numbers —
 * the numbers it has beat the names it hasn't.
 */
function chordSource(song: AlsSong): ChartLine[] {
  const lanes = (song.lanes ?? []).filter((lane) => lane.kind === 'chords' && lane.items.length);
  const spelled = lanes.find((lane) => !isNashvilleLane(lane.name) && !looksNashville(lane.items));
  return (spelled ?? lanes[0])?.items ?? song.chords ?? [];
}

export function chordProFor(song: AlsSong, project: AlsProject): string | null {
  const lyrics = [...(song.lyrics ?? [])].sort((a, b) => a.bar - b.bar);
  const chords = [...chordSource(song)].sort((a, b) => a.bar - b.bar);
  if (!lyrics.length && !chords.length) return null;

  const sections = [...(song.sections ?? [])].sort((a, b) => a.bar - b.bar);

  const head = [
    directive('title', song.title),
    directive('key', song.key ?? undefined),
    directive('tempo', Math.round(song.bpm ?? project.tempo)),
    directive('time', `${project.timeSigNum}/${project.timeSigDen}`),
  ].filter(Boolean) as string[];

  /*
   * One pass down the bars, taking whichever comes next. A section heading
   * opens a block, a lyric line takes the chords standing over it, and chords
   * with no line under them stand on their own.
   */
  const out: string[] = [];
  let ci = 0;
  let si = 0;
  const chordsUpTo = (bar: number): string[] => {
    const taken: string[] = [];
    while (ci < chords.length && chords[ci].bar < bar) {
      const text = chords[ci].text.trim();
      if (text) taken.push(`[${text}]`);
      ci++;
    }
    return taken;
  };
  const sectionsUpTo = (bar: number) => {
    while (si < sections.length && sections[si].bar <= bar) {
      // Changes standing before this heading belong to the section that is
      // ending, not the one about to start.
      const before = chordsUpTo(sections[si].bar);
      if (before.length) out.push(before.join(' '));
      const name = sections[si].text.trim();
      if (name) out.push('', `{comment: ${name}}`);
      si++;
    }
  };

  for (const line of lyrics) {
    sectionsUpTo(line.bar);
    // Chords up to and including this line's own bar belong over it.
    const over = chordsUpTo(line.bar + 1);
    const words = line.text.trim();
    if (!words) {
      if (over.length) out.push(over.join(' '));
      continue;
    }
    out.push(`${over.join('')}${words}`);
  }

  // Anything past the last lyric — an outro's changes, a whole instrumental.
  sectionsUpTo(Infinity);
  const rest = chordsUpTo(Infinity);
  if (rest.length) out.push(rest.join(' '));

  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${head.join('\n')}\n\n${body}\n`;
}

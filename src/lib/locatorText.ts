import type { AlsProject, AlsSong } from './alsParser';
import type { ChordClip } from './chordTrack.ts';
import { songLengthSec } from './infoTrack.ts';

/**
 * A song's locator name, written out from what the set knows.
 *
 * The locator is where a song's facts are kept in these sets — its key, its
 * tempo, how long it runs — and typing them onto forty locators is the kind
 * of job that gets done for six. This writes the name each locator should
 * have, in one of the two shapes the parser reads: AbleSet's own, or the
 * slash-separated setlist form these sets grew up with. Each comes out as a
 * one-bar MIDI clip at the song's start, on a track of its own, so the text
 * sits on the timeline beside the locator it is for, ready to be copied
 * across in Live. Which facts, and which shape, are choices.
 *
 * What is written is read back by `parseLocatorName` exactly: the title as
 * the title, the key as the key, and so on. Nothing is put in a name that
 * would come back as something else.
 */

export interface LocatorFields {
  key: boolean;
  tempo: boolean;
  length: boolean;
  tags: boolean;
  /** AbleSet's own flags the locator carries now — +END, +PAUSE — kept on. */
  flags: boolean;
}

export const DEFAULT_LOCATOR_FIELDS: LocatorFields = {
  key: true,
  tempo: true,
  length: true,
  tags: true,
  flags: true,
};

export const LOCATOR_FIELD_LABEL: Record<keyof LocatorFields, string> = {
  key: 'Key',
  tempo: 'Tempo',
  length: 'Length',
  tags: 'Tags',
  flags: 'Flags (+END, +PAUSE…)',
};

/**
 * AbleSet's syntax — `Title [3:00] {F / 100 BPM} #tag +END` — or the setlist
 * form, `Title / 3:00 / F / 100BPM #tag +END`.
 */
export type LocatorFormat = 'ableset' | 'setlist';

export const LOCATOR_FORMAT_LABEL: Record<LocatorFormat, string> = {
  ableset: 'AbleSet',
  setlist: 'Setlist',
};

export const DEFAULT_LOCATOR_TRACK = 'ADD THIS LOCATOR TEXT';

function clock(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** One line of text, as a name must be. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The name one song's locator should carry.
 *
 * A song is timed through its tempo map, not read off the locator it has
 * now; a key typed by hand wins over the locator's. Time signatures are not
 * written: `3/4` is a slash, and a slash is what separates the fields.
 */
export function locatorTextFor(
  song: AlsSong,
  project: AlsProject,
  fields: LocatorFields,
  format: LocatorFormat,
  keyOverride?: string,
): string {
  // A slash in a title is a field break to the setlist form — and to the parser.
  const title = format === 'setlist' ? flat(song.title).replace(/\s*\/\s*/g, '-') : flat(song.title);
  const key = fields.key ? flat(keyOverride?.trim() || song.key || '') : '';
  const bpm = song.bpm ?? song.startBpm;
  const tempo = fields.tempo && bpm ? `${Math.round(bpm * 10) / 10}` : '';
  const sec = fields.length ? songLengthSec(song, project) : 0;
  const length = sec > 0 ? clock(sec) : fields.length ? song.durationText ?? '' : '';
  const trailing = [
    ...(fields.tags ? song.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)) : []),
    ...(fields.flags ? song.flags.map((f) => `+${f.toUpperCase()}`) : []),
  ];

  if (format === 'setlist') {
    return [title, length, key, tempo ? `${tempo}BPM` : '']
      .filter(Boolean)
      .join(' / ')
      .concat(trailing.length ? ` ${trailing.join(' ')}` : '');
  }
  const inside = [key, tempo ? `${tempo} BPM` : ''].filter(Boolean).join(' / ');
  return [title, length ? `[${length}]` : '', inside ? `{${inside}}` : '', ...trailing].filter(Boolean).join(' ');
}

export interface LocatorClipsResult {
  clips: ChordClip[];
  /** The songs that got a clip, in set order. */
  songs: string[];
}

/**
 * One one-bar clip per chosen song, at its first bar on the set's own
 * timeline, named with the locator text.
 */
export function locatorClipsFor(
  project: AlsProject,
  titles: string[],
  fields: LocatorFields,
  format: LocatorFormat,
  opts: { keyFor?: Record<string, string> } = {},
): LocatorClipsResult {
  const wanted = new Set(titles);
  const clips: ChordClip[] = [];
  const songs: string[] = [];
  const seen = new Set<string>();
  for (const song of project.songs) {
    // A count-in locator repeats its song's title; the first is the song.
    if (!wanted.has(song.title) || seen.has(song.title)) continue;
    seen.add(song.title);
    clips.push({ bar: song.startBar, text: locatorTextFor(song, project, fields, format, opts.keyFor?.[song.title]), bars: 1 });
    songs.push(song.title);
  }
  return { clips, songs };
}

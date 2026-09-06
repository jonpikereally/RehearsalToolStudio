import type { AlsProject, AlsSong } from './alsParser';
import type { ChordClip } from './chordTrack.ts';

/**
 * Song information as MIDI clips.
 *
 * One clip at the top of each song, on a track of its own, whose name
 * carries the song's facts — the key it's played in, the tempo, the
 * length, the sections, the notes from the set — so they sit on the
 * timeline in Live for whoever is looking, without a word being typed
 * twice. Which facts is a choice, since a singer wants the key and a
 * drummer the tempo and neither wants the other's screen full. Named with
 * +LYRICS, the track is AbleSet's too, and the clip is written in its
 * markup; named anything else, it is plain text for Live.
 *
 * The clip runs the length of the song by default, so the information is
 * on screen throughout; a first-bar clip shows it only as the song starts.
 */

export interface InfoFields {
  title: boolean;
  key: boolean;
  tempo: boolean;
  timeSig: boolean;
  length: boolean;
  sections: boolean;
  notes: boolean;
  tags: boolean;
}

export const DEFAULT_INFO_FIELDS: InfoFields = {
  title: true,
  key: true,
  tempo: true,
  timeSig: true,
  length: true,
  sections: false,
  notes: true,
  tags: false,
};

export const INFO_FIELD_LABEL: Record<keyof InfoFields, string> = {
  title: 'Title',
  key: 'Key',
  tempo: 'Tempo',
  timeSig: 'Time signature',
  length: 'Length',
  sections: 'Sections',
  notes: 'Notes',
  tags: 'Tags',
};

export const DEFAULT_INFO_TRACK = 'ADD THIS SONG INFO';

/**
 * How a clip's lines are joined depends on who reads it. A track flagged
 * +LYRICS is read by AbleSet, which bolds between double stars; any other
 * track is read by a person in Live, where that would be noise, so its clip
 * is plain. Lines are separated by a slash either way.
 */
export function abletReads(trackName: string): boolean {
  return /\+LYRICS\b/i.test(trackName);
}

/**
 * How the lines of one clip are separated. A slash, not AbleSet's own
 * backslash: a clip name on the timeline reads as one line either way, and
 * a slash reads as a break to a person where a backslash reads as a typo.
 */
const BREAK = ' / ';
const PLAIN_BREAK = ' / ';

/** Text a clip name can carry: no line breaks of its own, no stray backslashes. */
function clean(text: string): string {
  return text.replace(/\\/g, '/').replace(/\s*\n+\s*/g, BREAK).replace(/\s+/g, ' ').trim();
}

/** `3:55`, from a song's bars through its tempo map. */
export function songLengthSec(song: AlsSong, project: AlsProject): number {
  const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
  const bars = song.endBar - song.startBar + 1;
  const changes = [...song.tempoChanges].sort((a, b) => a.bar - b.bar);
  let bpm = song.bpm ?? song.startBpm ?? project.tempo;
  let at = 1;
  let sec = 0;
  for (const change of changes) {
    if (change.bar <= 1) {
      bpm = change.bpm;
      continue;
    }
    if (change.bar > bars + 1) break;
    sec += ((change.bar - at) * beatsPerBar * 60) / bpm;
    at = change.bar;
    bpm = change.bpm;
  }
  return sec + ((bars + 1 - at) * beatsPerBar * 60) / bpm;
}

function clock(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The lines one song's clip carries, in the order they read best. */
export function infoLinesFor(
  song: AlsSong,
  project: AlsProject,
  fields: InfoFields,
  keyOverride?: string,
  /** AbleSet's markup — bold title — or plain text for a clip read in Live. */
  forAbleSet = true,
): string[] {
  const lines: string[] = [];
  if (fields.title) lines.push(forAbleSet ? `**${clean(song.title)}**` : clean(song.title));
  const key = keyOverride?.trim() || song.key;
  if (fields.key && key) lines.push(`Key: ${clean(key)}`);
  const bpm = song.bpm ?? song.startBpm;
  const facts: string[] = [];
  if (fields.tempo && bpm) facts.push(`${Math.round(bpm * 10) / 10} BPM`);
  if (fields.timeSig) facts.push(`${song.timeSigNum ?? project.timeSigNum}/${song.timeSigDen ?? project.timeSigDen}`);
  if (fields.length) {
    const bars = song.endBar - song.startBar + 1;
    facts.push(`${bars} bar${bars === 1 ? '' : 's'} · ${clock(songLengthSec(song, project))}`);
  }
  if (facts.length) lines.push(facts.join(' · '));
  if (fields.sections && song.sections.length) {
    lines.push(`Sections: ${song.sections.map((s) => clean(s.text)).filter(Boolean).join(' · ')}`);
  }
  if (fields.notes && song.notes?.trim()) lines.push(forAbleSet ? clean(song.notes) : clean(song.notes).split(BREAK).join(PLAIN_BREAK));
  if (fields.tags && song.tags.length) lines.push(song.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' '));
  return lines;
}

export interface InfoClipsResult {
  clips: ChordClip[];
  /** The songs that got a clip, in set order. */
  songs: string[];
  /** Songs asked for that had nothing to say under the chosen fields. */
  empty: string[];
}

/**
 * One clip per chosen song, at its first bar on the set's own timeline,
 * running the song's length or a single bar.
 */
export function infoClipsFor(
  project: AlsProject,
  titles: string[],
  fields: InfoFields,
  opts: { wholeSong?: boolean; keyFor?: Record<string, string>; forAbleSet?: boolean } = {},
): InfoClipsResult {
  const forAbleSet = opts.forAbleSet !== false;
  const wanted = new Set(titles);
  const clips: ChordClip[] = [];
  const songs: string[] = [];
  const empty: string[] = [];
  const seen = new Set<string>();
  for (const song of project.songs) {
    // A count-in locator repeats its song's title; the first is the song.
    if (!wanted.has(song.title) || seen.has(song.title)) continue;
    seen.add(song.title);
    const lines = infoLinesFor(song, project, fields, opts.keyFor?.[song.title], forAbleSet);
    if (!lines.length) {
      empty.push(song.title);
      continue;
    }
    const bars = Math.max(1, song.endBar - song.startBar + 1);
    clips.push({ bar: song.startBar, text: lines.join(forAbleSet ? BREAK : PLAIN_BREAK), bars: opts.wholeSong === false ? 1 : bars });
    songs.push(song.title);
  }
  return { clips, songs, empty };
}

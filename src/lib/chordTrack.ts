import type { AlsProject } from './alsParser';
import { addThis, cleanTrack, esc, extractBlock, idMinter, sub, trackInsertPoint } from './alsEdit.ts';
import { NOTATION_LANE, convertChord, deriveChordLanes, isNashvilleLane, keyAt, laneNotation, notationOf, parseKey, type ChordNotation } from './nashville.ts';
import type { ChartLane } from '../types';

/**
 * Writing a chord track into an Ableton set.
 *
 * A set writes its chords one way — numbers or names — and the other has to
 * be worked out. Doing that in the player only helps whoever opens the player;
 * written back into the set it is there in Ableton, there in AbleSet, and
 * there for anything else that reads the file. So the helper puts it in the
 * set: a `+LYRICS` track of named clips, which is how AbleSet spells a chord
 * track and how this app reads one back.
 *
 * Clips are placed at their own bar on the set's timeline, so each song's
 * chords land inside that song.
 */

export interface ChordClip {
  /** Bars from the start of the set, 1-based, as Live's ruler counts. */
  bar: number;
  text: string;
  /** How many bars the clip runs; one, as a chord clip is drawn, without. */
  bars?: number;
}

export interface ChordTrackResult {
  xml: string;
  trackName: string;
  clipsWritten: number;
  /** Songs that had chords to convert, and songs that had no key to do it with. */
  songsConverted: string[];
  songsWithoutKey: string[];
}

/**
 * The chords a set is missing, as clips on the set's own timeline.
 *
 * Each song is converted in its own key, and a song whose locator never said
 * one is left alone and named — a guessed key would put a whole song's chart
 * a semitone out, which is worse than an empty bar.
 */
export function chordClipsFor(
  project: AlsProject,
  /** Keys supplied by hand, by song title, for songs whose locator names none. */
  supplied: Record<string, string> = {},
  /** Titles to convert; the whole set when absent. */
  only?: string[],
  /**
   * The notation to write. Without one, whichever of names and numbers the
   * set is missing — the older behaviour. With one, every song that has
   * chords in any other notation is converted to it, and a song that has
   * it already is left alone.
   */
  target?: ChordNotation,
): {
  clips: ChordClip[];
  trackName: string;
  converted: string[];
  withoutKey: string[];
  /** Songs that already had the chosen notation, and so got nothing. */
  alreadyHad: string[];
} {
  const clips: ChordClip[] = [];
  const converted: string[] = [];
  const withoutKey: string[] = [];
  const alreadyHad: string[] = [];
  let toNumbers: boolean | null = null;

  const wanted = only?.length ? new Set(only) : null;
  for (const song of project.songs) {
    if (wanted && !wanted.has(song.title)) continue;
    const lanes = (song.lanes ?? []).filter((l) => l.kind === 'chords' && l.items.length);
    if (!lanes.length) continue;
    // What the set says, else what was typed in for it — and the key marks
    // inside the song, so a chord after a modulation is counted in the new key.
    const changes = song.keyChanges ?? [];
    const key = keyAt(1, song.key ?? (supplied[song.title]?.trim() || null), changes);
    if (!key) {
      withoutKey.push(song.title);
      continue;
    }

    let added: { name: string; items: { bar: number; text: string }[] } | undefined;
    if (target) {
      /*
       * Chord by chord, not lane by lane. A track written mostly in numbers
       * with a few names left in it — or one song in numerals among songs
       * in names — is judged by each chord: what is already the chosen kind
       * stays, the rest is converted, and the song counts as done only when
       * every chord of some lane is already that kind.
       */
      const bare = (text: string) => text.trim().replace(/^\[|\]$/g, '');
      if (lanes.some((l) => l.items.every((i) => !bare(i.text) || notationOf([{ text: bare(i.text) }]) === target))) {
        alreadyHad.push(song.title);
        continue;
      }
      const parsed = parseKey(key);
      if (!parsed) {
        withoutKey.push(song.title);
        continue;
      }
      const keyFor = (bar: number) => parseKey(keyAt(bar, key, changes)) ?? parsed;
      // Names are the surest source, since numbers and numerals both come from them.
      const source = lanes.find((l) => laneNotation(l) === 'names') ?? lanes[0];
      added = {
        name: NOTATION_LANE[target],
        items: source.items.map((item) => ({
          bar: item.bar,
          text: convertChord(bare(item.text), target, keyFor(item.bar)) ?? item.text,
        })),
      };
    } else {
      const grown = deriveChordLanes(lanes as ChartLane[], key, changes);
      added = grown.find((l) => !lanes.some((had) => had.id === l.id));
      if (!added) continue; // the set already wrote both languages for this song

      // One track for the set, so every song must be going the same way.
      const wantsNumbers = isNashvilleLane(added.name);
      if (toNumbers === null) toNumbers = wantsNumbers;
      else if (toNumbers !== wantsNumbers) continue;
    }

    converted.push(song.title);
    for (const item of added.items) {
      // Song-relative bars onto the set's own ruler.
      const bar = song.startBar + (item.bar - 1);
      const text = item.text.trim();
      // In brackets, as AbleSet reads a chord on a lyrics track: the parser
      // took them off on the way in, and a bare name would show as a word.
      if (text) clips.push({ bar, text: /^\[.*\]$/.test(text) ? text : `[${text}]` });
    }
  }

  clips.sort((a, b) => a.bar - b.bar);
  /*
   * Each clip runs to the next chord, or a bar, whichever comes first. A
   * chart that changes every half bar was getting bar-long clips that
   * overlapped, and Live trimmed every one of them on load, saying so in
   * its log line by line.
   */
  for (let i = 0; i < clips.length; i++) {
    const next = clips[i + 1];
    const gap = next ? next.bar - clips[i].bar : 1;
    clips[i].bars = Math.max(0.25, Math.min(1, gap));
  }
  return {
    clips,
    trackName: addThis(`${target ? NOTATION_LANE[target] : toNumbers ? 'Nash Chords' : 'Chords'} +LYRICS`),
    converted,
    withoutKey,
    alreadyHad,
  };
}

/**
 * Which notations the chosen songs already have chords in, and how many
 * songs have chords at all — so the choice of what to write can say which
 * are already there.
 */
export function chordNotationsIn(
  project: AlsProject,
  only?: string[],
): { withChords: number; have: Record<ChordNotation, number>; mixed: number } {
  const wanted = only?.length ? new Set(only) : null;
  const have: Record<ChordNotation, number> = { names: 0, numbers: 0, roman: 0 };
  let withChords = 0;
  let mixed = 0;
  const seen = new Set<string>();
  for (const song of project.songs) {
    if ((wanted && !wanted.has(song.title)) || seen.has(song.title)) continue;
    seen.add(song.title);
    const lanes = (song.lanes ?? []).filter((l) => l.kind === 'chords' && l.items.length);
    if (!lanes.length) continue;
    withChords++;
    // A song has a kind when some lane of it is that kind throughout; a
    // lane that mixes kinds is counted as mixed, and as having none.
    const done = new Set<ChordNotation>();
    let mixes = false;
    for (const lane of lanes) {
      const kinds = new Set(
        lane.items.map((i) => i.text.trim().replace(/^\[|\]$/g, '')).filter(Boolean).map((t) => notationOf([{ text: t }])),
      );
      if (kinds.size === 1) done.add([...kinds][0]);
      else if (kinds.size > 1) mixes = true;
    }
    for (const k of done) have[k]++;
    if (mixes) mixed++;
  }
  return { withChords, have, mixed };
}

/** Put those clips into the set as a new MIDI track. */
export function addChordTrack(
  xml: string,
  clips: ChordClip[],
  trackName: string,
  project: AlsProject,
): ChordTrackResult {
  if (!clips.length) throw new Error('No chords to write.');
  const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
  const ids = idMinter(xml);

  /*
   * The skeletons come from a MIDI track that actually holds arrangement
   * clips — anchored on the timeline's own events, so a clip sitting in a
   * session slot can't be picked up by mistake.
   */
  const arranged = xml.search(/<ClipTimeable>\s*<ArrangerAutomation>\s*<Events>\s*<MidiClip/);
  if (arranged < 0) throw new Error('The set has no MIDI track with clips to model one on.');
  const trackT = extractBlock(xml, /<MidiTrack Id="\d+"[^>]*>/, xml.lastIndexOf('<MidiTrack Id=', arranged))?.text;
  const clipT = extractBlock(xml, /<MidiClip Id="\d+"[^>]*>/, arranged)?.text;
  if (!trackT || !clipT) throw new Error('Could not read a MIDI track to model one on.');

  const written = clips.map((clip, i) => {
    const start = (clip.bar - 1) * beatsPerBar;
    const length = Math.max(0.25, clip.bars ?? 1) * beatsPerBar;
    const end = start + length;
    let c = clipT.replace(
      /^(\s*)<MidiClip Id="\d+" Time="[-\d.]+">/,
      `$1<MidiClip Id="${i}" Time="${start}">`,
    );
    c = sub(c, /<CurrentStart Value="[-\d.]+"/, `<CurrentStart Value="${start}"`, 'clip start');
    c = sub(c, /<CurrentEnd Value="[-\d.]+"/, `<CurrentEnd Value="${end}"`, 'clip end');
    c = sub(
      c,
      /<Loop>[\s\S]*?<\/Loop>/,
      `<Loop>
											<LoopStart Value="0" />
											<LoopEnd Value="${length}" />
											<StartRelative Value="0" />
											<LoopOn Value="false" />
											<OutMarker Value="${length}" />
											<HiddenLoopStart Value="0" />
											<HiddenLoopEnd Value="${length}" />
										</Loop>`,
      'clip loop',
    );
    c = sub(c, /<Name Value="[^"]*"/, `<Name Value="${esc(clip.text)}"`, 'clip name');
    c = sub(c, /<Disabled Value="(?:true|false)"/, '<Disabled Value="false"', 'disabled flag');
    // The model clip's notes are its song's; a chord clip carries only a name.
    c = sub(c, /<KeyTracks>[\s\S]*?<\/KeyTracks>|<KeyTracks \/>/, '<KeyTracks />', 'notes');
    return ids.renumber(c);
  });

  let track = trackT.replace(/^(\s*)<MidiTrack Id="\d+"/, `$1<MidiTrack Id="${ids.next()}"`);
  track = cleanTrack(track, trackName);

  const events = extractBlock(track, /<Events(?: \/)?>/, track.search(/<ClipTimeable>\s*<ArrangerAutomation>/));
  if (!events) throw new Error('The model track has no events container.');
  track = ids.renumber(
    track.slice(0, events.start) + `<Events>\n${written.join('\n')}\n</Events>` + track.slice(events.end),
  );

  const at = trackInsertPoint(xml);
  const out = (xml.slice(0, at) + '\t\t\t' + track + '\n' + xml.slice(at)).replace(
    /<NextPointeeId Value="\d+"/,
    `<NextPointeeId Value="${ids.value()}"`,
  );
  return { xml: out, trackName: addThis(trackName), clipsWritten: written.length, songsConverted: [], songsWithoutKey: [] };
}

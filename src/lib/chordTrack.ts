import type { AlsProject } from './alsParser';
import { cleanTrack, esc, extractBlock, idMinter, sub, trackInsertPoint } from './alsEdit.ts';
import { deriveChordLanes, isNashvilleLane } from './nashville.ts';
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
): {
  clips: ChordClip[];
  trackName: string;
  converted: string[];
  withoutKey: string[];
} {
  const clips: ChordClip[] = [];
  const converted: string[] = [];
  const withoutKey: string[] = [];
  let toNumbers: boolean | null = null;

  const wanted = only?.length ? new Set(only) : null;
  for (const song of project.songs) {
    if (wanted && !wanted.has(song.title)) continue;
    const lanes = (song.lanes ?? []).filter((l) => l.kind === 'chords' && l.items.length);
    if (!lanes.length) continue;
    // What the set says, else what was typed in for it.
    const key = song.key ?? supplied[song.title]?.trim();
    if (!key) {
      withoutKey.push(song.title);
      continue;
    }

    const grown = deriveChordLanes(lanes as ChartLane[], key);
    const added = grown.find((l) => !lanes.some((had) => had.id === l.id));
    if (!added) continue; // the set already wrote both languages for this song

    // One track for the set, so every song must be going the same way.
    const wantsNumbers = isNashvilleLane(added.name);
    if (toNumbers === null) toNumbers = wantsNumbers;
    else if (toNumbers !== wantsNumbers) continue;

    converted.push(song.title);
    for (const item of added.items) {
      // Song-relative bars onto the set's own ruler.
      const bar = song.startBar + (item.bar - 1);
      if (item.text.trim()) clips.push({ bar, text: item.text.trim() });
    }
  }

  clips.sort((a, b) => a.bar - b.bar);
  return {
    clips,
    trackName: toNumbers ? 'Nash Chords +LYRICS' : 'Chords +LYRICS',
    converted,
    withoutKey,
  };
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
    const length = Math.max(1, clip.bars ?? 1) * beatsPerBar;
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
  return { xml: out, trackName, clipsWritten: written.length, songsConverted: [], songsWithoutKey: [] };
}

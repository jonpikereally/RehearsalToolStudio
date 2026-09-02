/**
 * Writing a Slates track into an Ableton set.
 *
 * Each spoken title becomes an audio clip that finishes exactly on its song's
 * locator, so the slate plays over the count-in and the downbeat arrives clean.
 * The track and clip skeletons are harvested from the set itself and patched —
 * nobody can write Live's schema from scratch and be believed — the same way
 * the test-set generator works, and with the same scars honoured: every id in
 * the pointee namespace is renumbered fresh (targets, <Pointee>, and the
 * dotted ControllerTargets.N variants), because Live refuses a set over one
 * duplicate.
 *
 * Pure text in, pure text out: gzip and file handles are the caller's problem,
 * which is what lets the self-test hold this to account in Node.
 */

export interface SlateClip {
  /** The song's title, which is also the clip's name. */
  title: string;
  /** The WAV's name inside the project's Slates folder. */
  fileName: string;
  durationSec: number;
  sizeBytes: number;
  /** Where the song begins, in beats from the start of the set. */
  startBeat: number;
  /** The tempo governing the count-in, for turning seconds into beats. */
  bpm: number;
}

export interface SlateTrackResult {
  xml: string;
  clipsWritten: number;
  /** The track the clips landed on, and whether the set already had it. */
  trackName: string;
  reusedTrack: boolean;
}

import { cleanTrack, esc, extractBlock, idMinter, sub, trackInsertPoint } from './alsEdit.ts';

const SAMPLE_RATE = 44100;


export function addSlatesTrack(xml: string, slates: SlateClip[], nowSec: number): SlateTrackResult {
  if (!slates.length) throw new Error('No slates to write.');

  const ids = idMinter(xml);

  const trackT = extractBlock(xml, /<AudioTrack Id="\d+"[^>]*>/)?.text;
  if (!trackT) throw new Error('The set has no audio track to model the Slates track on.');
  const clipT = extractBlock(xml, /<AudioClip Id="\d+"[^>]*>/)?.text;
  if (!clipT) throw new Error('The set has no audio clip to model the slate clips on.');

  const fresh = ids.renumber;

  /* ---------------------------------- clips --------------------------------- */

  let clipId = 1;
  const clips = slates.map((slate) => {
    const beats = (slate.durationSec * slate.bpm) / 60;
    // The slate starts exactly on its song's locator, running forward from it.
    const start = slate.startBeat;
    const end = slate.startBeat + beats;

    let c = clipT.replace(
      /^(\s*)<AudioClip Id="\d+" Time="[-\d.]+">/,
      `$1<AudioClip Id="${clipId++}" Time="${start}">`,
    );
    c = sub(c, /<CurrentStart Value="[-\d.]+"/, `<CurrentStart Value="${start}"`, 'clip start');
    c = sub(c, /<CurrentEnd Value="[-\d.]+"/, `<CurrentEnd Value="${end}"`, 'clip end');
    // Unwarped: the voice plays at its own speed whatever the set's tempo does,
    // so the loop block speaks seconds.
    c = sub(
      c,
      /<Loop>[\s\S]*?<\/Loop>/,
      `<Loop>
											<LoopStart Value="0" />
											<LoopEnd Value="${slate.durationSec}" />
											<StartRelative Value="0" />
											<LoopOn Value="false" />
											<OutMarker Value="${slate.durationSec}" />
											<HiddenLoopStart Value="0" />
											<HiddenLoopEnd Value="${slate.durationSec}" />
										</Loop>`,
      'clip loop',
    );
    c = sub(c, /<Name Value="[^"]*"/, `<Name Value="${esc(slate.title)}"`, 'clip name');
    c = sub(c, /<IsWarped Value="(?:true|false)"/, '<IsWarped Value="false"', 'warp flag');
    c = sub(c, /<Disabled Value="(?:true|false)"/, '<Disabled Value="false"', 'disabled flag');
    c = c.replace(/<IsSongTempoLeader Value="true"/, '<IsSongTempoLeader Value="false"');
    // The project-relative path is the one identity the browser can know.
    const ref = `<SampleRef>
											<FileRef>
												<RelativePathType Value="3" />
												<RelativePath Value="Slates/${esc(slate.fileName)}" />
												<Path Value="" />
												<Type Value="2" />
												<LivePackName Value="" />
												<LivePackId Value="" />
												<OriginalFileSize Value="${slate.sizeBytes}" />
												<OriginalCrc Value="0" />
											</FileRef>
											<LastModDate Value="${Math.floor(nowSec)}" />
											<SourceContext />
											<SampleUsageHint Value="0" />
											<DefaultDuration Value="${Math.round(slate.durationSec * SAMPLE_RATE)}" />
											<DefaultSampleRate Value="${SAMPLE_RATE}" />
										</SampleRef>`;
    c = sub(c, /<SampleRef>[\s\S]*?<\/SampleRef>/, ref, 'sample reference');
    return fresh(c);
  });

  /* ---------------------------------- track --------------------------------- */

  const tracksClose = xml.indexOf('</Tracks>');
  if (tracksClose < 0) throw new Error('The set has no Tracks section.');

  /** Put the clips into a track's arranger, replacing whatever was there. */
  const withClips = (track: string): string => {
    const arranger = track.search(/<Sample>\s*<ArrangerAutomation>/);
    if (arranger < 0) throw new Error('The slate track has no arranger timeline.');
    const events = extractBlock(track, /<Events(?: \/)?>/, arranger);
    if (!events) throw new Error('The slate track has no events container.');
    return (
      track.slice(0, events.start) + `<Events>\n${clips.join('\n')}\n</Events>` + track.slice(events.end)
    );
  };

  /*
   * A rig that already has a Slate track has it routed, grouped and mixed the
   * way the show needs — so the clips go there, replacing that track's old
   * arrangement clips, and nothing else about it is touched. Only a set with
   * no such track gets a new one, modelled on its first audio track.
   */
  let existing: { start: number; end: number; text: string } | null = null;
  for (let at = 0; at < tracksClose; ) {
    const block = extractBlock(xml, /<AudioTrack Id="\d+"[^>]*>/, at);
    if (!block || block.start >= tracksClose) break;
    const name = (block.text.match(/<EffectiveName Value="([^"]*)"/) ?? [])[1] ?? '';
    if (/^slates?$/i.test(name.trim())) {
      existing = block;
      break;
    }
    at = block.end;
  }

  let out: string;
  let trackName: string;
  if (existing) {
    trackName = (existing.text.match(/<EffectiveName Value="([^"]*)"/) ?? [])[1] ?? 'Slate';
    out = xml.slice(0, existing.start) + withClips(existing.text) + xml.slice(existing.end);
  } else {
    trackName = 'Slates';
    let track = trackT.replace(/^(\s*)<AudioTrack Id="\d+"/, `$1<AudioTrack Id="${ids.next()}"`);
    track = cleanTrack(track, 'Slates');
    track = sub(track, /(<Speaker>[\s\S]{0,200}?<Manual Value=")(?:true|false)/, '$1true', 'speaker');
    track = sub(track, /(<Volume>[\s\S]{0,200}?<Manual Value=")[^"]+/, '$11', 'volume');
    track = fresh(withClips(track));

    const at = trackInsertPoint(xml);
    out = xml.slice(0, at) + '\t\t\t' + track + '\n' + xml.slice(at);
  }

  out = out.replace(/<NextPointeeId Value="\d+"/, `<NextPointeeId Value="${ids.value()}"`);
  return { xml: out, clipsWritten: clips.length, trackName, reusedTrack: !!existing };
}

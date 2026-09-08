import type { AlsProject } from './alsParser';
import type { Patch } from '../types';
import { addThis, cleanTrack, esc, extractBlock, idMinter, sub, trackInsertPoint } from './alsEdit.ts';

/**
 * Patch changes written into a set as MIDI clips, the way the set makes
 * them itself.
 *
 * A rig is driven from clips on a MIDI track: the program and bank in
 * the clip's own box, the control changes as envelopes, the channel from
 * the track's output routing. The studio used to write its changes as
 * locators, a notation of its own that nobody who drives a rig from
 * clips would ever read. Now it writes clips — one track per person whose
 * changes they are, modelled on a rig track already in the set so the
 * routing and the controller numbering are the set's own — named so the
 * copy says what to do with it.
 *
 * Only the program, the bank and the CCs go in, as flat envelopes: a
 * change is a moment, and a clip runs to the next change or a bar. Notes
 * are not written yet.
 */

export interface RigChange {
  /** Bars from the start of the set, 1-based, as Live's ruler counts. */
  bar: number;
  /** The clip's name: what the change is called, for reading in Live. */
  name: string;
  patch: Patch;
}

export interface RigTrackSpec {
  /** Whose changes these are: a track is made per person. */
  member: string;
  /** What they play through, for the track's name. */
  rig?: string;
  changes: RigChange[];
}

export interface RigTrackResult {
  xml: string;
  tracks: { name: string; clips: number; /** CCs the model track had no envelope target for. */ dropped: number }[];
}

/**
 * `+PATCH`, on the end of the name of any track that sends patch changes.
 *
 * The set says what a track is in its name — AbleSet reads `+LYRICS` that
 * way — and until now a track that drove a rig was only guessed at, from
 * words like MIDI, Cortex or PC in its name. A guess is wrong both ways: a
 * track called "Program" that plays a pad is read as a rig, and one called
 * "Ben's board" is not read at all. Marked, there is nothing to guess.
 *
 * The mark goes at the end, after anything else the name carries, and the
 * flag is not part of the name: what the app shows, and what a member's
 * changes are filed under, is the name without it.
 */
export const PATCH_FLAG = '+PATCH';

const PATCH_MARK = /\s*\+\s*PATCH(?:ES)?\b/i;

/** Whether a track's name says it sends patch changes. */
export const sendsPatches = (name: string): boolean => PATCH_MARK.test(name);

/** The name without the mark, which is what anything but the set itself wants. */
export const withoutPatchFlag = (name: string): string => name.replace(new RegExp(PATCH_MARK, 'gi'), '').trim();

/** The name with the mark on the end, put there once however often this is asked. */
export const withPatchFlag = (name: string): string => `${withoutPatchFlag(name)} ${PATCH_FLAG}`;

/** The name a member's rig track carries, before ADD THIS is put in front. */
export function rigTrackName(member: string, rig?: string): string {
  return withPatchFlag(`RIG ${member.trim()}${rig?.trim() ? ` (${rig.trim()})` : ''}`);
}

/** Whose track a rig track is, from its name: `RIG Alex (Quad Cortex) +PATCH`. */
export function rigTrackMember(name: string): { member: string; rig?: string } | null {
  const m = /^(?:ADD THIS\s+)?RIG\b[\s:\-–—]*([^()]*?)\s*(?:\(([^)]*)\))?\s*$/i.exec(withoutPatchFlag(name));
  if (!m || !m[1].trim()) return null;
  return { member: m[1].trim(), ...(m[2]?.trim() ? { rig: m[2].trim() } : {}) };
}

interface TrackBlock {
  text: string;
  start: number;
  end: number;
  name: string;
}

function midiTracks(xml: string): TrackBlock[] {
  const out: TrackBlock[] = [];
  let from = 0;
  for (;;) {
    const block = extractBlock(xml, /<MidiTrack Id="\d+"[^>]*>/, from);
    if (!block) break;
    const name = block.text.match(/<EffectiveName Value="([^"]*)"/)?.[1] ?? '';
    out.push({ text: block.text, start: block.start, end: block.end, name });
    from = block.end;
  }
  return out;
}

/** Whether a MIDI track is a fit model: routed out, with a clip on its timeline to copy. */
function usableModel(track: TrackBlock): boolean {
  return /<ClipTimeable>\s*<ArrangerAutomation>\s*<Events>\s*<MidiClip/.test(track.text) && /<ControllerTargets\.\d+ Id=/.test(track.text);
}

/**
 * The track to copy for a member: their own rig track when the set has
 * one, so the routing is theirs; else any rig-looking MIDI track routed to
 * a device; else any MIDI track with a clip to model on.
 */
function modelFor(tracks: TrackBlock[], member: string): TrackBlock | null {
  const usable = tracks.filter(usableModel);
  const theirs = usable.find((t) => rigTrackMember(t.name)?.member.toLowerCase() === member.toLowerCase());
  if (theirs) return theirs;
  const routed = usable.find((t) => /<MidiOutputRouting>[\s\S]*?<Target Value="MidiOut\/External/.test(t.text));
  return routed ?? usable[0] ?? null;
}

/** A tolerant `sub`: leave a field alone when the model's schema lacks it. */
function setIfPresent(chunk: string, re: RegExp, replacement: string): string {
  return re.test(chunk) ? chunk.replace(re, replacement) : chunk;
}

function envelopeXml(id: number, pointee: string, value: number): string {
  const v = Math.min(127, Math.max(0, Math.round(value)));
  return `<ClipEnvelope Id="${id}">
											<EnvelopeTarget>
												<PointeeId Value="${pointee}" />
											</EnvelopeTarget>
											<Automation>
												<Events>
													<FloatEvent Id="0" Time="-63072000" Value="${v}" />
													<FloatEvent Id="1" Time="0" Value="${v}" />
												</Events>
												<AutomationTransformViewState>
													<IsTransformPending Value="false" />
													<TimeAndValueTransforms />
												</AutomationTransformViewState>
											</Automation>
											<LoopSlot>
												<Value />
											</LoopSlot>
											<ScrollerTimePreserver>
												<LeftTime Value="0" />
												<RightTime Value="0" />
											</ScrollerTimePreserver>
										</ClipEnvelope>`;
}

export function addRigTracks(xml: string, specs: RigTrackSpec[], project: AlsProject): RigTrackResult {
  const wanted = specs.filter((s) => s.changes.length);
  if (!wanted.length) throw new Error('No patch changes to write.');
  const beatsPerBar = project.timeSigNum * (4 / project.timeSigDen);
  const tracks = midiTracks(xml);
  if (!tracks.some(usableModel)) {
    throw new Error('The set has no MIDI track with a clip on its timeline to model a rig track on — add one clip to any MIDI track and save.');
  }
  const ids = idMinter(xml);
  const made: RigTrackResult['tracks'] = [];
  const built: string[] = [];

  for (const spec of wanted) {
    const model = modelFor(tracks, spec.member)!;
    const clipT = extractBlock(model.text, /<MidiClip Id="\d+"[^>]*>/, model.text.search(/<ClipTimeable>/))?.text;
    if (!clipT) throw new Error(`Could not read a clip on “${model.name}” to model on.`);

    // The track first, empty and renumbered, so its controller ids are known.
    let track = model.text.replace(/^(\s*)<MidiTrack Id="\d+"/, `$1<MidiTrack Id="${ids.next()}"`);
    track = cleanTrack(track, rigTrackName(spec.member, spec.rig));
    const events = extractBlock(track, /<Events(?: \/)?>/, track.search(/<ClipTimeable>\s*<ArrangerAutomation>/));
    if (!events) throw new Error('The model track has no events container.');
    const MARK = '<!--RIG-CLIPS-->';
    track = ids.renumber(track.slice(0, events.start) + MARK + track.slice(events.end));
    const pointeeFor = new Map<number, string>();
    for (const m of track.matchAll(/<ControllerTargets\.(\d+) Id="(\d+)"/g)) pointeeFor.set(parseInt(m[1], 10), m[2]);

    const changes = [...spec.changes].sort((a, b) => a.bar - b.bar);
    let dropped = 0;
    const clips = changes.map((change, i) => {
      const next = changes[i + 1];
      const bars = Math.max(0.25, Math.min(1, next ? next.bar - change.bar : 1));
      const start = (change.bar - 1) * beatsPerBar;
      const length = bars * beatsPerBar;
      let c = clipT.replace(/^(\s*)<MidiClip Id="\d+" Time="[-\d.]+">/, `$1<MidiClip Id="${i}" Time="${start}">`);
      c = sub(c, /<CurrentStart Value="[-\d.]+"/, `<CurrentStart Value="${start}"`, 'clip start');
      c = sub(c, /<CurrentEnd Value="[-\d.]+"/, `<CurrentEnd Value="${start + length}"`, 'clip end');
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
      c = sub(c, /<Name Value="[^"]*"/, `<Name Value="${esc(change.name || 'patch')}"`, 'clip name');
      c = sub(c, /<Disabled Value="(?:true|false)"/, '<Disabled Value="false"', 'disabled flag');
      c = sub(c, /<KeyTracks>[\s\S]*?<\/KeyTracks>|<KeyTracks \/>/, '<KeyTracks />', 'notes');
      // Live shows these one-based; the file holds the bytes, -1 for none.
      const { program, bank, controls = [] } = change.patch;
      c = setIfPresent(c, /<ProgramChange Value="-?\d+"/, `<ProgramChange Value="${program === undefined ? -1 : Math.min(127, Math.max(0, Math.round(program)))}"`);
      c = setIfPresent(c, /<BankSelectCoarse Value="-?\d+"/, `<BankSelectCoarse Value="${bank === undefined ? -1 : (Math.max(0, Math.round(bank)) >> 7) & 0x7f}"`);
      c = setIfPresent(c, /<BankSelectFine Value="-?\d+"/, `<BankSelectFine Value="${bank === undefined ? -1 : Math.max(0, Math.round(bank)) & 0x7f}"`);
      // Each CC an envelope, pointed at the track's own target for it.
      const envelopes: string[] = [];
      for (const control of controls) {
        const pointee = pointeeFor.get(Math.round(control.cc) + 2);
        if (!pointee) {
          dropped++;
          continue;
        }
        envelopes.push(envelopeXml(envelopes.length, pointee, control.value));
      }
      c = sub(
        c,
        /<Envelopes>\s*<Envelopes(?: \/)?>[\s\S]*?<\/Envelopes>\s*<\/Envelopes>|<Envelopes>\s*<Envelopes \/>\s*<\/Envelopes>/,
        envelopes.length ? `<Envelopes>\n\t\t\t\t\t\t\t\t\t\t<Envelopes>\n${envelopes.join('\n')}\n\t\t\t\t\t\t\t\t\t\t</Envelopes>\n\t\t\t\t\t\t\t\t\t</Envelopes>` : '<Envelopes>\n\t\t\t\t\t\t\t\t\t\t<Envelopes />\n\t\t\t\t\t\t\t\t\t</Envelopes>',
        'clip envelopes',
      );
      return ids.renumber(c);
    });

    track = track.replace(MARK, `<Events>\n${clips.join('\n')}\n</Events>`);
    built.push(track);
    made.push({ name: addThis(rigTrackName(spec.member, spec.rig)), clips: clips.length, dropped });
  }

  // At the top, in the order given: each goes in above the last, so reversed.
  let out = xml;
  for (const track of [...built].reverse()) {
    const at = trackInsertPoint(out);
    out = out.slice(0, at) + '\t\t\t' + track + '\n' + out.slice(at);
  }
  out = out.replace(/<NextPointeeId Value="\d+"/, `<NextPointeeId Value="${ids.value()}"`);
  return { xml: out, tracks: made };
}

/**
 * Patch changes sent to whatever is on stage.
 *
 * A marker says where a section starts; a patch says what the guitar rig or
 * keyboard should be on when it does. These are saved with the song, so a set
 * worked out on the laptop is there on the phone at the gig — which does mean
 * anyone sharing the folder sees them. A patch number means something
 * different on every rig, so someone else's are information, not instructions.
 *
 * Web MIDI is Chromium-only and asks permission the first time. Where it isn't
 * available the app simply doesn't offer it, rather than showing controls that
 * can't work.
 */

import type { Patch, PatchClip, Song } from '../types';

const LS_PATCHES = 'ls.midi.patches';
const LS_CLIPS = 'ls.midi.clips';
const LS_OUTPUT = 'ls.midi.output';
const LS_ENABLED = 'ls.midi.on';
const LS_DEVICE = 'ls.midi.device';
const LS_CHANNEL = 'ls.midi.channel';

/*
 * `Patch` and `PatchClip` live in the core model now that they are saved with
 * the song, and are re-exported here so the rest of the MIDI code reads the
 * same as it did.
 */
export type { Patch, PatchClip } from '../types';

type AllClips = Record<string, PatchClip[]>;

/** Marker-keyed patches, as they were stored before clips. */
type SongPatches = Record<string, Patch>;
type AllPatches = Record<string, SongPatches>;

export function midiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

function readAll(): AllPatches {
  try {
    const raw = localStorage.getItem(LS_PATCHES);
    return raw ? (JSON.parse(raw) as AllPatches) : {};
  } catch {
    return {};
  }
}

function writeAll(value: AllPatches): void {
  try {
    localStorage.setItem(LS_PATCHES, JSON.stringify(value));
  } catch {
    /* not worth failing over */
  }
}

export function patchesFor(songId: string): SongPatches {
  return readAll()[songId] ?? {};
}

/* ---------------------------------- clips --------------------------------- */

/*
 * Clips used to live here, one entry per song, on whichever device programmed
 * them. They live in the library now; what remains is the one-way move of
 * anything still on a device from before that.
 */

function readClips(): AllClips {
  try {
    const raw = localStorage.getItem(LS_CLIPS);
    return raw ? (JSON.parse(raw) as AllClips) : {};
  } catch {
    return {};
  }
}

function writeClips(value: AllClips): void {
  try {
    localStorage.setItem(LS_CLIPS, JSON.stringify(value));
  } catch {
    /* not worth failing over */
  }
}

let nextId = 0;
const newClipId = () => `p_${Date.now().toString(36)}_${nextId++}`;

const byBar = (clips: PatchClip[]): PatchClip[] => [...clips].sort((a, b) => a.bar - b.bar);

/**
 * A song's clips, in bar order, taking in anything left on this device.
 *
 * Two older shapes get folded in: clips kept per device, and before that
 * patches hung off markers. What is found is returned for the caller to save
 * into the library — and left where it is until the caller says it landed, so
 * a save that doesn't happen can't take them with it.
 *
 * Returns null when there was nothing to bring in, so the caller can tell "no
 * change" from "an empty list is the answer".
 */
export function clipsToAdopt(song: Song): PatchClip[] | null {
  const onDevice = readClips()[song.id];
  if (onDevice?.length) return byBar([...(song.patchClips ?? []), ...onDevice]);

  const marked = readAll()[song.id];
  if (!marked) return null;

  const fromMarkers = Object.entries(marked)
    .map(([markerId, patch]) => {
      const marker = song.markers.find((m) => m.id === markerId);
      // A patch whose marker has gone has no bar left to sit on.
      return marker ? { id: newClipId(), bar: marker.bar, patch } : null;
    })
    .filter((c): c is PatchClip => !!c);

  return fromMarkers.length ? byBar([...(song.patchClips ?? []), ...fromMarkers]) : null;
}

/** Let go of a song's device copies, once they are safely in the library. */
export function forgetAdopted(songId: string): void {
  const clips = readClips();
  if (clips[songId]) {
    delete clips[songId];
    writeClips(clips);
  }
  const old = readAll();
  if (old[songId]) {
    delete old[songId];
    writeAll(old);
  }
}

/** A song's clips as saved, in bar order. */
export function clipsOf(song: Pick<Song, 'patchClips'>): PatchClip[] {
  return byBar(song.patchClips ?? []);
}

/** Add a clip, or replace one by id, keeping the list in bar order. */
export function withClip(clips: PatchClip[], clip: PatchClip): PatchClip[] {
  return byBar(
    clips.some((c) => c.id === clip.id)
      ? clips.map((c) => (c.id === clip.id ? clip : c))
      : [...clips, clip],
  );
}

export function withoutClip(clips: PatchClip[], clipId: string): PatchClip[] {
  return clips.filter((c) => c.id !== clipId);
}

/** A blank clip at `bar`, ready for the dictionary to fill in. */
export function newClip(bar: number, patch: Patch): PatchClip {
  return { id: newClipId(), bar: Math.max(1, Math.round(bar)), patch };
}

/**
 * Where each clip runs to: its own length, the next one, or the end of the song.
 *
 * What the rig is on doesn't stop at a bar line — it holds until something
 * changes it — so a clip with no length of its own is drawn as the stretch it
 * actually governs. One with a length ends where it says, and the gap after it
 * is the rig back the way it was.
 */
export function clipSpans(
  clips: PatchClip[],
  lastBar: number,
): { clip: PatchClip; endBar: number; ownEnd: boolean }[] {
  const sorted = byBar(clips);
  return sorted.map((clip, i) => {
    const nextBar = sorted[i + 1]?.bar ?? lastBar + 1;
    const own = clip.lengthBars ? clip.bar + clip.lengthBars : null;
    // A length that runs into the next change doesn't get to end the clip: the
    // next one has taken the rig by then.
    const ownEnd = own !== null && own < nextBar;
    return {
      clip,
      // Never shorter than a bar, or a clip on the last bar would have no width
      // at all and become impossible to hit.
      endBar: Math.max(clip.bar + 1, ownEnd ? own : nextBar),
      ownEnd,
    };
  });
}

/**
 * Everything that goes down the wire, in the order it goes, with each clip's
 * ending resolved to an actual patch.
 *
 * "Whatever was on before" has to be worked out by walking the song, since what
 * was in force at a clip's start may itself be an earlier clip's ending. Doing
 * it here keeps the send loop to reading a list, and makes the awkward part —
 * two clips that both put something back — something a test can pin down.
 */
export function patchPoints(clips: PatchClip[], lastBar: number): { bar: number; patch: Patch }[] {
  const spans = clipSpans(clips, lastBar);
  const points: { bar: number; patch: Patch }[] = [];
  let inForce: Patch | null = null;

  for (const { clip, endBar, ownEnd } of spans) {
    const before: Patch | null = inForce;
    points.push({ bar: clip.bar, patch: clip.patch });

    if (!ownEnd) {
      inForce = clip.patch;
      continue;
    }
    // Explicit first, then what was on before. A clip that ends with nothing to
    // go back to simply stops being drawn; there is nothing to send.
    const back: Patch | null = clip.endPatch ?? before;
    if (back) points.push({ bar: endBar, patch: back });
    inForce = back ?? clip.patch;
  }

  return points;
}

export function midiEnabled(): boolean {
  return localStorage.getItem(LS_ENABLED) === '1';
}

export function setMidiEnabled(on: boolean): void {
  try {
    localStorage.setItem(LS_ENABLED, on ? '1' : '0');
  } catch {
    /* not worth failing over */
  }
}

/**
 * The rig you actually own.
 *
 * Every patch change starts as a guess at what you're holding, and the guess
 * was always the first entry in the dictionary. Naming your own rig once means
 * a new clip opens on Helix snapshots or Quad Cortex scenes rather than on
 * somebody else's box — and the channel it's set to, since a rig moved off
 * channel 1 is moved off it for every song, not per patch.
 */
export function defaultDeviceId(): string {
  return localStorage.getItem(LS_DEVICE) ?? '';
}

export function setDefaultDeviceId(id: string): void {
  try {
    localStorage.setItem(LS_DEVICE, id);
  } catch {
    /* not worth failing over */
  }
}

/** 0 means "whatever the rig's own default is". */
export function defaultChannel(): number {
  const raw = Number(localStorage.getItem(LS_CHANNEL));
  return Number.isFinite(raw) && raw >= 1 && raw <= 16 ? Math.round(raw) : 0;
}

export function setDefaultChannel(channel: number): void {
  try {
    localStorage.setItem(LS_CHANNEL, String(channel));
  } catch {
    /* not worth failing over */
  }
}

export function chosenOutputId(): string {
  return localStorage.getItem(LS_OUTPUT) ?? '';
}

export function setChosenOutputId(id: string): void {
  try {
    localStorage.setItem(LS_OUTPUT, id);
  } catch {
    /* not worth failing over */
  }
}

export interface MidiPort {
  id: string;
  name: string;
}

let access: MIDIAccess | null = null;

/**
 * Ask for MIDI, once.
 *
 * The prompt only appears the first time, and a refusal is a normal answer
 * rather than an error — someone who says no should get an app that works
 * without it, not a broken one.
 */
export async function openMidi(): Promise<boolean> {
  if (!midiSupported()) return false;
  if (access) return true;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    return true;
  } catch {
    return false;
  }
}

export function outputs(): MidiPort[] {
  if (!access) return [];
  return [...access.outputs.values()].map((o) => ({ id: o.id, name: o.name ?? o.id }));
}

function outputFor(id: string): MIDIOutput | null {
  if (!access) return null;
  if (id) {
    const wanted = access.outputs.get(id);
    if (wanted) return wanted;
  }
  // Whatever is plugged in, rather than nothing, when the chosen port is gone.
  return [...access.outputs.values()][0] ?? null;
}

/**
 * Tell me when the gear changes.
 *
 * Ports come and go while the app is open — a rig switched on after the page
 * loaded is the ordinary case, not the exception — and a list read once is a
 * list that says "nothing connected yet" about a box sitting right there.
 */
export function onPortsChanged(fn: () => void): () => void {
  if (!access) return () => {};
  const handler = () => fn();
  access.addEventListener('statechange', handler);
  return () => access?.removeEventListener('statechange', handler);
}

export interface SendReport {
  ok: boolean;
  /** The port it actually went to, which is not always the one you meant. */
  port: string | null;
  /** Why it didn't, in words worth reading on stage. */
  reason?: string;
}

/**
 * Send a patch and say what happened.
 *
 * `sendPatch` answers true or false, which is no use when the question is "the
 * rig is right there and nothing is changing". This names the port it went to,
 * so a message going out to the wrong one of three is visible rather than
 * indistinguishable from success.
 */
export function sendPatchReporting(patch: Patch, outputId = chosenOutputId()): SendReport {
  if (!midiSupported()) {
    return { ok: false, port: null, reason: 'This browser has no MIDI. Chrome or Edge does.' };
  }
  if (!access) {
    return { ok: false, port: null, reason: 'MIDI access has not been granted yet.' };
  }
  const ports = [...access.outputs.values()];
  if (!ports.length) {
    return {
      ok: false,
      port: null,
      reason: 'No MIDI outputs at all — nothing is connected, or the rig is not in a mode that offers one.',
    };
  }

  const port = outputFor(outputId);
  if (!port) return { ok: false, port: null, reason: 'The chosen output has gone.' };

  for (const message of patchMessages(patch)) port.send(message);
  return { ok: true, port: port.name ?? port.id };
}

/**
 * The bytes for a patch change.
 *
 * Bank select comes first and in two halves — coarse then fine — because a rig
 * that wants a bank ignores a program change that arrives before it. Pure, so
 * the message can be checked without a synth plugged in.
 */
export function patchMessages(patch: Patch): number[][] {
  const channel = Math.min(16, Math.max(1, Math.round(patch.channel))) - 1;
  const messages: number[][] = [];
  const byte = (n: number) => Math.min(127, Math.max(0, Math.round(n)));

  if (patch.bank !== undefined) {
    const bank = Math.min(16383, Math.max(0, Math.round(patch.bank)));
    messages.push([0xb0 | channel, 0x00, (bank >> 7) & 0x7f]);
    messages.push([0xb0 | channel, 0x20, bank & 0x7f]);
  }
  if (patch.program !== undefined) {
    messages.push([0xc0 | channel, byte(patch.program)]);
  }
  /*
   * Controls last. A snapshot or scene selects within whatever preset is
   * loaded, so it has to arrive after the program change that loads it —
   * sent first, it would be wiped by the preset landing on top.
   */
  for (const control of patch.controls ?? []) {
    messages.push([0xb0 | channel, byte(control.cc), byte(control.value)]);
  }
  return messages;
}

export function sendPatch(patch: Patch, outputId = chosenOutputId()): boolean {
  const port = outputFor(outputId);
  if (!port) return false;
  for (const message of patchMessages(patch)) port.send(message);
  return true;
}

export function describePatch(patch: Patch): string {
  if (patch.source) return `${patch.source} · ch ${patch.channel}`;
  const parts: string[] = [];
  if (patch.bank !== undefined) parts.push(`bank ${patch.bank}`);
  if (patch.program !== undefined) parts.push(`program ${patch.program}`);
  for (const c of patch.controls ?? []) parts.push(`CC${c.cc}=${c.value}`);
  return `${parts.join(', ') || 'nothing'} on ch ${patch.channel}`;
}

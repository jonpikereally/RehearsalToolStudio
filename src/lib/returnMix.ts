import type { AlsClip, AlsProject, AlsSong } from './alsParser';
import type { Bus } from '../types';
import { renderTrack, type ClipPlacement } from './arrangement.ts';
import { buildChain, deviceLabel } from './fx.ts';
import { songBars } from './infoTrack.ts';
import { peakOf } from './bounce.ts';
import { tempoOf } from './prepare.ts';

/**
 * A song as one of the set's return buses hears it.
 *
 * In a set built for the stage the returns are the outputs: every track is
 * sent to its bus — drums to one, bass to another, the headphone mix to a
 * third — and the buses go on to the interface, or into each other. What
 * reaches a bus is therefore a mix in its own right, with its balance in
 * the sends rather than the faders, and the band want to hear it: the edit
 * bus is the whole mix, the cues bus what the drummer hears.
 *
 * So a bus is summed as Live sums it. Each stem sent to it goes in at its
 * send level, after the sender's fader for a post-fader send and regardless
 * of it for a pre-fader one; each bus sent to it goes in at its own output.
 * The sum runs through the bus's devices — Live's stock ones imitated, a
 * plugin passed through and named — then its fader and pan. Nothing here
 * writes: what comes back is audio and an account of what went into it.
 */

export interface StemFeed {
  stem: AlsSong['stems'][number];
  /** What every clip of the stem is scaled by on its way in. */
  level: number;
}

export interface BusFeed {
  from: number;
  level: number;
  /** Taken before the sending bus's fader. */
  pre: boolean;
}

/** What is sent into one bus inside one song. */
export function feedsOf(song: AlsSong, project: AlsProject, bus: number): { stems: StemFeed[]; buses: BusFeed[] } {
  const pre = !!project.buses?.[bus]?.pre;
  const stems: StemFeed[] = [];
  for (const stem of song.stems) {
    // A track switched off sends nothing, whatever its sends say.
    if (stem.regions && stem.regions.length === 0) continue;
    let level = 0;
    for (const send of stem.sends) {
      if (send.bus !== bus) continue;
      level += (pre ? 1 : (send.fader ?? stem.gain)) * send.level;
    }
    if (level > 0) stems.push({ stem, level });
  }
  const buses: BusFeed[] = [];
  (project.buses ?? []).forEach((b, from) => {
    if (from === bus) return;
    for (const send of b.sends) if (send.bus === bus && send.level > 0) buses.push({ from, level: send.level, pre });
  });
  return { stems, buses };
}

const db = (gain: number): string => (gain <= 0 ? '−∞ dB' : `${(20 * Math.log10(gain)).toFixed(1).replace('-', '−').replace(/\.0$/, '')} dB`);

/** The devices on a bus that play in Live and cannot be imitated here. */
export function unimitatedOn(bus: Bus): string[] {
  return bus.devices.filter((d) => d.on && !d.supported).map(deviceLabel);
}

/**
 * What a bus would carry in a song, in words — for the page to say before
 * anything is rendered. Every bus feeding it is followed in turn, so the
 * account is the whole tree, cycles cut.
 */
export function describeFeeds(song: AlsSong, project: AlsProject, bus: number, seen = new Set<number>()): string[] {
  const buses = project.buses ?? [];
  const here = buses[bus];
  if (!here || seen.has(bus)) return [];
  seen.add(bus);
  const { stems, buses: from } = feedsOf(song, project, bus);
  const lines = stems.map((f) => `${f.stem.name.trim()} at ${db(f.level)}`);
  for (const feed of from) {
    const inner = describeFeeds(song, project, feed.from, seen);
    if (inner.length) lines.push(`via ${buses[feed.from].name} at ${db(feed.level)}: ${inner.join(', ')}`);
  }
  return lines;
}

export interface RenderReturnOptions {
  song: AlsSong;
  project: AlsProject;
  bus: number;
  sampleRate: number;
  /**
   * A clip's file, decoded — or, given a window, that stretch of it, with
   * where the stretch began. Null when the file cannot be found.
   */
  loadClip: (clip: AlsClip, window?: { startSec: number; durationSec: number }) => Promise<{ buffer: AudioBuffer; fromSec: number } | null>;
  /** Transpose and stretch a decoded file, for a clip Live plays shifted; see prepare.ts. */
  shift?: (req: { buffer: AudioBuffer; semitones: number; speed: number; source: string }) => Promise<AudioBuffer | null>;
  resolvePath?: (relative: string) => string | null;
  onProgress?: (stage: 'reading' | 'rendering' | 'processing', ratio: number) => void;
  signal?: AbortSignal;
}

export interface ReturnRender {
  /** Null when nothing in the song reaches the bus. */
  buffer: AudioBuffer | null;
  /** Stems that went in, with their levels, bus by bus. */
  fed: string[];
  /** Clips whose files could not be read. */
  missing: string[];
  /** Devices that play on the way in Live and were passed straight through. */
  unimitated: string[];
  /** How far the whole was pulled down to fit, in dB; 0 when it wasn't. */
  pulledDb: number;
}

function beatsPerBar(project: AlsProject): number {
  return project.timeSigNum * (4 / project.timeSigDen);
}

function barToSeconds(bar: number, bpm: number, project: AlsProject): number {
  return ((bar - 1) * beatsPerBar(project) * 60) / bpm;
}

const needsShift = (clip: AlsClip) => (clip.semitones ?? 0) !== 0 || Math.abs((clip.speed ?? 1) - 1) > 1e-6;

/** Add `buffer` scaled by `gain` into `into`, channel for channel, mono spread to both. */
function mixInto(into: AudioBuffer, buffer: AudioBuffer, gain: number): void {
  const n = Math.min(into.length, buffer.length);
  for (let c = 0; c < into.numberOfChannels; c++) {
    const out = into.getChannelData(c);
    const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    for (let i = 0; i < n; i++) out[i] += src[i] * gain;
  }
}

/**
 * Run a bus's sum through its devices, and — unless a pre-fader send is
 * taking it — its fader and pan, as Live does after the devices.
 */
async function processBus(input: AudioBuffer, bus: Bus, withFader: boolean): Promise<AudioBuffer> {
  const devices = bus.devices.filter((d) => d.on && d.supported);
  const fader = withFader ? bus.gain : 1;
  const pan = withFader ? bus.pan : 0;
  if (!devices.length && Math.abs(fader - 1) < 1e-6 && Math.abs(pan) < 1e-6) return input;
  const ctx = new OfflineAudioContext(2, input.length, input.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = input;
  const chain = buildChain(ctx, devices);
  const gain = ctx.createGain();
  gain.gain.value = fader;
  source.connect(chain.input);
  chain.output.connect(gain);
  if (Math.abs(pan) > 1e-6 && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    gain.connect(panner);
    panner.connect(ctx.destination);
  } else {
    gain.connect(ctx.destination);
  }
  source.start(0);
  return ctx.startRendering();
}

/** The song as one bus carries it: see the top of the file. */
export async function renderReturnMix(opts: RenderReturnOptions): Promise<ReturnRender> {
  const { song, project, sampleRate, signal } = opts;
  const buses = project.buses ?? [];
  const bpm = tempoOf(song, project);
  const durationSec = barToSeconds(1 + songBars(song), bpm, project);
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const report = (stage: 'reading' | 'rendering' | 'processing', ratio: number) => opts.onProgress?.(stage, ratio);
  const fed: string[] = [];
  const missing: string[] = [];
  const unimitated: string[] = [];
  const silent = () => new OfflineAudioContext(2, frames, sampleRate).createBuffer(2, frames, sampleRate);

  /** What one bus puts out, after its devices and — post-fader — its fader; null when nothing reaches it. */
  const output = async (bus: number, withFader: boolean, seen: Set<number>): Promise<AudioBuffer | null> => {
    const here = buses[bus];
    if (!here || seen.has(bus)) return null;
    const below = new Set(seen).add(bus);
    const { stems, buses: from } = feedsOf(song, project, bus);

    const placements: ClipPlacement[] = [];
    for (const feed of stems) {
      const live = feed.stem.clips.filter((c) => !c.disabled);
      if (!live.length) continue;
      fed.push(`${feed.stem.name.trim()} at ${db(feed.level)}${seen.size ? ` into ${here.name}` : ''}`);
      for (const clip of live) {
        if (signal?.aborted) throw new DOMException('Printing cancelled', 'AbortError');
        report('reading', 0);
        // A frozen track's file is the whole set's; only this song's stretch is read.
        const window = clip.frozen
          ? {
              startSec: clip.sourceStartSec,
              durationSec: barToSeconds(clip.endBar, bpm, project) - barToSeconds(clip.startBar, bpm, project) + clip.fadeOutSec + 0.25,
            }
          : undefined;
        const loaded = await opts.loadClip(clip, window);
        if (!loaded) {
          missing.push(clip.path);
          continue;
        }
        let buffer = loaded.buffer;
        const speed = clip.speed ?? 1;
        if (opts.shift && needsShift(clip)) {
          buffer = (await opts.shift({ buffer, semitones: clip.semitones ?? 0, speed, source: opts.resolvePath?.(clip.path) ?? clip.path })) ?? buffer;
        }
        placements.push({
          buffer,
          gain: feed.level * (clip.gain ?? 1),
          startSec: barToSeconds(clip.startBar, bpm, project),
          endSec: barToSeconds(clip.endBar, bpm, project),
          // Placed against where the cut began; a stretched file's seconds are shorter by the same factor.
          sourceStartSec: (clip.sourceStartSec - loaded.fromSec) / speed,
          fadeInSec: clip.fadeInSec,
          fadeOutSec: clip.fadeOutSec,
        });
      }
    }

    let sum: AudioBuffer | null = null;
    if (placements.length) {
      report('rendering', 0);
      sum = await renderTrack(placements, durationSec, sampleRate, 2);
    }
    for (const feed of from) {
      const inner = await output(feed.from, !feed.pre, below);
      if (!inner) continue;
      if (!sum) sum = silent();
      mixInto(sum, inner, feed.level);
    }
    if (!sum) return null;
    unimitated.push(...unimitatedOn(here).map((name) => `${name} on ${here.name}`));
    report('processing', 0);
    return processBus(sum, here, withFader);
  };

  const buffer = await output(opts.bus, true, new Set());
  let pulledDb = 0;
  if (buffer) {
    // A sum past full scale has nowhere to go in the file: the whole is pulled down, quieter but faithful.
    const peak = peakOf(buffer);
    if (peak > 1) {
      const gain = 0.99 / peak;
      pulledDb = Math.round(20 * Math.log10(gain) * 10) / 10;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) data[i] *= gain;
      }
    }
  }
  return { buffer, fed, missing, unimitated: [...new Set(unimitated)], pulledDb };
}

/** A label for a print of a bus, from the bus's name: "H-HP 11/12" → "HP 11-12". */
export function busLabel(bus: Bus): string {
  return bus.name
    .replace(/^[A-Z]\s*-\s*/, '')
    .replace(/\s*\/\s*/g, '-')
    .replace(/[\\:*?"<>|[\]{}()]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'return';
}

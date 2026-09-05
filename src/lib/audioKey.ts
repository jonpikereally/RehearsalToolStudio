import type { AlsProject, AlsSong } from './alsParser';
import { partsFor, type SongPlan } from './prepare.ts';

/**
 * A song's audio, as a key: everything that decides what its parts sound
 * like, boiled down to a string the manifest can carry.
 *
 * A set is prepared, then edited a little, then prepared again — and the
 * second run used to rewrite every song ticked, twenty minutes of encoding
 * for one moved clip. The key is how a run knows which songs it can leave
 * alone: the parts a song is written as, every clip that feeds them, the
 * faders and devices over them, the files themselves by their revisions,
 * and the settings of the encoder. Anything that would change a byte of
 * the MP3s changes the key. Anything that wouldn't — a section renamed,
 * a lyric fixed — doesn't, and goes out by the cheaper path.
 *
 * Written as five segments, `v.files.arrangement.mix.settings`, so a
 * changed key also says roughly why. The version leads: a change to how
 * parts are rendered means every song is stale, whatever the set says.
 */

/** Bump when rendering itself changes, so old sets are redone. */
export const AUDIO_KEY_VERSION = 1;

export interface AudioKeyInputs {
  /** The revision of a file the song plays, or null when it isn't there. */
  fileRev: (path: string) => string | null;
  bitrate: number;
  sampleRate: number;
  plan?: SongPlan;
}

/** 64 bits of FNV-1a as sixteen hex digits: enough to notice a change with. */
function fnv(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= c;
    b = Math.imul(b, 0x01000193 + 2) >>> 0;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

const num = (n: number | undefined | null, digits = 4): string =>
  n === undefined || n === null || Number.isNaN(n) ? '' : n.toFixed(digits);

/**
 * The key's segments, unhashed, for the tests and for the curious. Each is
 * a plain description; only their hashes go into the manifest.
 */
export function audioKeySegments(song: AlsSong, project: AlsProject, inputs: AudioKeyInputs): Record<string, string> {
  const parts = partsFor(song, inputs.plan);

  const files: string[] = [];
  const arrangement: string[] = [];
  const mix: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    arrangement.push(`part ${part.name}${part.combined ? ' combined' : ''}${part.reference ? ' ref' : ''}`);
    mix.push(`part ${part.name}`);
    for (const stem of part.stems) {
      mix.push(
        `  ${stem.name} g${num(stem.gain)} p${num(stem.pan)} ${stem.direct ? 'direct' : 'sends-only'} ` +
          `sends[${stem.sends.map((s) => `${s.bus}:${num(s.level)}`).join(',')}] ` +
          `devices[${stem.devices
            .filter((d) => d.on)
            .map((d) => `${d.kind}(${Object.entries(d.params).map(([k, v]) => `${k}=${typeof v === 'number' ? num(v) : v}`).join(',')})`)
            .join(';')}]`,
      );
      arrangement.push(
        `  ${stem.name} regions[${stem.regions ? stem.regions.map((r) => `${num(r.startBar)}-${num(r.endBar)}`).join(',') : 'all'}]`,
      );
      for (const clip of stem.clips) {
        if (clip.disabled) continue;
        arrangement.push(
          `    ${clip.path} @${num(clip.startBar)}-${num(clip.endBar)} src${num(clip.sourceStartSec)} ` +
            `fade${num(clip.fadeInSec)}/${num(clip.fadeOutSec)} st${num(clip.semitones, 2)} x${num(clip.speed)} ` +
            `g${num(clip.gain)}${clip.frozen ? ' frozen' : ''}${clip.note !== undefined ? ` n${clip.note} v${clip.velocity ?? ''}` : ''}`,
        );
        const key = clip.path.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          files.push(`${clip.path} ${inputs.fileRev(clip.path) ?? 'missing'}`);
        }
      }
    }
  }
  files.sort();

  const tempo = [
    `bars ${song.startBar}-${song.endBar}`,
    `bpm ${num(song.bpm ?? project.tempo)}`,
    `sig ${project.timeSigNum}/${project.timeSigDen}`,
    `map ${song.tempoChanges.map((t) => `${num(t.bar)}:${num(t.bpm)}`).join(',')}`,
  ].join(' ');

  return {
    files: files.join('\n'),
    arrangement: `${tempo}\n${arrangement.join('\n')}`,
    mix: mix.join('\n'),
    settings: `bitrate ${inputs.bitrate} rate ${inputs.sampleRate}`,
  };
}

export function audioKeyFor(song: AlsSong, project: AlsProject, inputs: AudioKeyInputs): string {
  const s = audioKeySegments(song, project, inputs);
  return `${AUDIO_KEY_VERSION}.${fnv(s.files)}.${fnv(s.arrangement)}.${fnv(s.mix)}.${fnv(s.settings)}`;
}

/** What a song's standing is against the last prepare, and why. */
export type AudioStanding =
  | { state: 'new' }
  | { state: 'unchanged' }
  | { state: 'changed'; why: string };

/**
 * Compare a song's key now with the one its manifest entry carries. A
 * manifest from before keys existed says nothing, and a song it describes
 * is then taken as changed: better a needless rewrite than a stale one.
 */
export function audioStanding(now: string, before: string | undefined, prepared: boolean): AudioStanding {
  if (!prepared) return { state: 'new' };
  if (!before) return { state: 'changed', why: 'prepared before this could be told' };
  if (before === now) return { state: 'unchanged' };
  const a = before.split('.');
  const b = now.split('.');
  if (a[0] !== b[0]) return { state: 'changed', why: 'the studio renders parts differently now' };
  const why: string[] = [];
  if (a[1] !== b[1]) why.push('a file was re-exported or has gone');
  if (a[2] !== b[2]) why.push('the arrangement or tempo changed');
  if (a[3] !== b[3]) why.push('a fader, device or the plan changed');
  if (a[4] !== b[4]) why.push('the encoder settings changed');
  return { state: 'changed', why: why.join('; ') || 'something changed' };
}

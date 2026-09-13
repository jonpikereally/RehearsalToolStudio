import type { AlsProject } from './alsParser';
import { resolveStemPath } from './alsImport';
import { readPcmWindow, type RangeReader } from './audioSlice.ts';
import { bounceFileName, nextVersion } from './bounce.ts';
import { holdAwake } from './keepAwake';
import * as local from './localSource';
import { DEFAULT_BITRATE, encodeMp3 } from './mp3';
import { getShiftedBuffer } from './pitchService';
import { PRINTS_FOLDER } from './prints';
import { renderReturnMix } from './returnMix.ts';
import { clearDecodedCache, releaseReady } from './songLoader';
import { readBytes } from './source';

/**
 * Print a return bus's mix of each chosen song into the band's folder.
 *
 * The rendering is returnMix.ts; this is the run around it — the files read
 * from the set's folder, the shifts from the pitch service, the MP3 written
 * under Prints/ where a print made in the player goes, named as one is, in
 * the version folder of the song's prepared set so the scan attaches it
 * there. Songs that reach the bus with nothing are named, not written.
 */

export interface ReturnMixProgress {
  song: string;
  index: number;
  count: number;
  stage: 'reading' | 'rendering' | 'processing' | 'encoding' | 'writing';
  ratio: number;
}

export interface ReturnMixRunOptions {
  project: AlsProject;
  setPath: string;
  band: local.FolderHandle;
  bus: number;
  titles: string[];
  /** What the print is called — its version name in the file, "HP 11-12 mix v2". */
  label: string;
  /** The version folder under Prints/ for a song, or '' to sit loose; see versions.ts. */
  versionFor: (title: string) => string;
  /** Prints the library already holds for a song, so the next is numbered after them. */
  existingNames: (title: string) => string[];
  cacheBudgetGB?: number;
  onProgress?: (p: ReturnMixProgress) => void;
  signal?: AbortSignal;
}

export interface ReturnMixOutcome {
  written: { song: string; path: string; fed: string[]; pulledDb: number }[];
  skipped: { song: string; reason: string }[];
  /** Devices passed through unimitated, and files not found, across the run. */
  notes: string[];
}

export async function runReturnMix(o: ReturnMixRunOptions): Promise<ReturnMixOutcome> {
  const { project, setPath, band, bus, signal } = o;
  const releaseAwake = holdAwake('Printing a return mix');
  releaseReady();
  clearDecodedCache();
  const ctx = new AudioContext();
  const written: ReturnMixOutcome['written'] = [];
  const skipped: ReturnMixOutcome['skipped'] = [];
  const notes = new Set<string>();
  try {
    const decoded = new Map<string, { buffer: AudioBuffer; fromSec: number }>();
    const resolvePath = (relative: string) => resolveStemPath(setPath, relative);
    const loadClip = async (
      clip: { path: string; absPath?: string },
      window?: { startSec: number; durationSec: number },
    ): Promise<{ buffer: AudioBuffer; fromSec: number } | null> => {
      const candidates = [resolvePath(clip.path), clip.absPath ? `abs:${clip.absPath}` : null].filter((p): p is string => !!p);
      const suffix = window ? `#${window.startSec.toFixed(3)}+${window.durationSec.toFixed(2)}` : '';
      for (const [i, candidate] of candidates.entries()) {
        const key = candidate.toLowerCase() + suffix;
        const already = decoded.get(key);
        if (already) return already;
        try {
          let bytes: ArrayBuffer | null = null;
          let fromSec = 0;
          if (window) {
            const read: RangeReader = async (start, end) => {
              const got = await readBytes(candidate, undefined, undefined, { start, end });
              return { bytes: got.bytes, size: got.size };
            };
            const cut = await readPcmWindow(read, window.startSec, window.durationSec);
            if (cut) {
              bytes = cut.bytes;
              fromSec = cut.fromSec;
            }
          }
          if (!bytes) bytes = (await readBytes(candidate)).bytes;
          const loaded = { buffer: await ctx.decodeAudioData(bytes.slice(0)), fromSec };
          decoded.set(key, loaded);
          return loaded;
        } catch {
          if (i === candidates.length - 1) return null;
        }
      }
      return null;
    };

    const wanted = new Set(o.titles);
    const songs = project.songs.filter((s, i, all) => wanted.has(s.title) && all.findIndex((x) => x.title === s.title) === i);
    for (const [index, song] of songs.entries()) {
      if (signal?.aborted) throw new DOMException('Printing cancelled', 'AbortError');
      const report = (stage: ReturnMixProgress['stage'], ratio: number) => o.onProgress?.({ song: song.title, index, count: songs.length, stage, ratio });
      decoded.clear();
      const render = await renderReturnMix({
        song,
        project,
        bus,
        sampleRate: ctx.sampleRate,
        loadClip,
        resolvePath,
        shift: ({ buffer, semitones, speed, source }) =>
          getShiftedBuffer({
            ctx,
            path: source,
            rev: `prepare:${buffer.length}@${buffer.sampleRate}`,
            semitones,
            tempo: speed,
            source: buffer,
            budgetBytes: (o.cacheBudgetGB ?? 2) * 1e9,
            signal,
          }),
        onProgress: report,
        signal,
      });
      for (const name of render.unimitated) notes.add(`${name} plays in Live and could not be imitated here`);
      for (const path of render.missing) notes.add(`${path.split('/').pop()} could not be read`);
      if (!render.buffer) {
        skipped.push({ song: song.title, reason: `nothing in it reaches ${project.buses?.[bus]?.name ?? 'the bus'}` });
        continue;
      }
      report('encoding', 0);
      const blob = await encodeMp3(render.buffer, { bitrate: DEFAULT_BITRATE, signal, onProgress: (r) => report('encoding', r) });
      report('writing', 0);
      const version = nextVersion(o.existingNames(song.title), o.label);
      const file = bounceFileName(song.title, o.label, version).replace(/\.wav$/i, '.mp3');
      const folder = o.versionFor(song.title);
      const path = `${PRINTS_FOLDER}/${folder ? `${folder}/` : ''}${file}`;
      await local.writeFile(band, '', path, blob);
      written.push({ song: song.title, path, fed: render.fed, pulledDb: render.pulledDb });
    }
  } finally {
    await ctx.close().catch(() => undefined);
    releaseAwake();
  }
  return { written, skipped, notes: [...notes] };
}

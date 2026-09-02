import type { AlsClip, AlsProject, AlsSong } from './alsParser';
import { needsRender, renderTrack, type ClipPlacement } from './arrangement.ts';
import { encodeMp3, measurePadding, DEFAULT_BITRATE } from './mp3.ts';
import { PREPARED_FOLDER, PRINTS_FOLDER } from './prints.ts';
import { normalisePath } from './paths.ts';
import { MANIFEST_NAME, type PreparedManifest, type PreparedSongInfo } from './preparedSet.ts';
import { clipsFromMarks, laneList, songIdFor, stemLabel } from './alsImport.ts';
import { chordProFor } from './chordPro.ts';
import { barToSec } from './bars.ts';
import { peakOf } from './bounce.ts';

/**
 * Turning an Ableton set into a folder of songs anyone can play.
 *
 * Each track of each song is flattened to a single part — its clips laid end to
 * end, gaps left silent, fades applied — and written out small. What comes out
 * is an ordinary library: bracketed file names, tempo and key in the folder
 * name, nothing that needs Ableton to read it. A phone then opens the set
 * without ever knowing Live was involved.
 *
 * Run on a laptop pointed at a local folder, so the source WAVs are read off
 * disk rather than pulled down.
 */

export interface PrepareProgress {
  /** 1-based, for "song 3 of 14". */
  songIndex: number;
  songCount: number;
  songTitle: string;
  partName: string;
  stage: 'reading' | 'rendering' | 'encoding' | 'writing' | 'done';
  /** 0..1 within the current part, where it can be known. */
  ratio: number;
}

export interface PrepareOptions {
  project: AlsProject;
  /** Where the set file sits, for resolving relative sample paths. */
  alsPath: string;
  /** The library root, under which the prepared set is written. */
  root: string;
  /** Name for the output folder — usually the set's own name plus a date. */
  setName: string;
  /**
   * Titles to prepare; the whole set when absent.
   *
   * The full project still comes in either way, so the manifest can keep the
   * set's own running order and a part-set run can say "song 2 of 3".
   */
  only?: string[];
  /**
   * What to make of each song's tracks, by title. A song without a plan gets
   * every track as its own part, which is the whole-set default.
   */
  plan?: Record<string, SongPlan>;
  /**
   * The manifest already in the destination, when there is one.
   *
   * Preparing part of a set writes into the same folder as the rest of it, and
   * the manifest carries what a folder name cannot — tempo maps, sections,
   * chords. Written blind it would describe only the songs of this run and
   * quietly flatten every song prepared before them.
   */
  readManifest?: () => Promise<PreparedManifest | null>;
  bitrate?: number;
  /** Resolve a path as the set writes it to a path in the library. */
  resolvePath: (relative: string) => string | null;
  readFile: (path: string) => Promise<ArrayBuffer>;
  writeFile: (path: string, data: Blob) => Promise<string>;
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
  /**
   * Transpose and stretch a decoded file, for a clip Live plays shifted or
   * warped to another tempo. `source` names the file, and must be part of
   * whatever the caller caches a render under: six stems of one song are
   * the same length, and a key without the file served the first render
   * — the drums — for all six. Without one, such clips print as their files.
   */
  shift?: (buffer: AudioBuffer, semitones: number, speed: number, source: string) => Promise<AudioBuffer>;
  onProgress?: (p: PrepareProgress) => void;
  signal?: AbortSignal;
}

/**
 * Which of a song's tracks become parts, and which are folded together.
 *
 * A rehearsal rarely wants every stem of the record. A band of four might
 * want their own four parts, the click, and everything else summed into
 * one "band" part to play along to — three files instead of eleven, and a
 * folder a phone can hold.
 */
export interface SongPlan {
  /** Track names to write as parts of their own. */
  print: string[];
  /** Groups of track names to sum into one part each, under the given name. */
  combine: { name: string; stems: string[] }[];
}

/** One file to write: the tracks that go into it, and what to call it. */
export interface PlannedPart {
  name: string;
  stems: AlsSong['stems'];
  reference: boolean;
  /** True for a sum of several tracks, which is pulled down if it clips. */
  combined: boolean;
}

/** The parts a song will be written as, given its plan — or all of it without one. */
export function partsFor(song: AlsSong, plan?: SongPlan): PlannedPart[] {
  if (!plan) {
    return song.stems.map((stem) => ({ name: stem.name, stems: [stem], reference: stem.reference, combined: false }));
  }
  const byName = new Map(song.stems.map((s) => [s.name.trim().toLowerCase(), s]));
  const find = (name: string) => byName.get(name.trim().toLowerCase());
  const out: PlannedPart[] = [];
  for (const name of plan.print) {
    const stem = find(name);
    if (stem) out.push({ name: stem.name, stems: [stem], reference: stem.reference, combined: false });
  }
  for (const group of plan.combine) {
    const stems = group.stems.map(find).filter((s): s is AlsSong['stems'][number] => !!s);
    if (!stems.length || !group.name.trim()) continue;
    out.push({ name: group.name.trim(), stems, reference: false, combined: true });
  }
  return out;
}

export interface PrepareResult {
  folder: string;
  songsWritten: number;
  partsWritten: number;
  /** Parts that could not be prepared, with why. */
  skipped: { song: string; part: string; reason: string }[];
  /** Lead-in the encoder adds, written into each song so bars stay true. */
  paddingSec: number;
}

/** Characters a file name can't carry, whatever the filesystem. */
function safeName(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The song folder, carrying what the scan needs to know.
 *
 * Tempo, key and time signature go in curly brackets because that is how File
 * mode reads them — so a prepared set is understood by the same rules a
 * hand-made folder is, with no special case anywhere.
 */
export function songFolderName(song: AlsSong, project: AlsProject): string {
  const facts = [
    String(Math.round(tempoOf(song, project) * 10) / 10),
    song.key ?? '',
    `${project.timeSigNum}-${project.timeSigDen}`,
  ].filter(Boolean);
  return `${safeName(song.title)} {${facts.join(', ')}}`;
}

/**
 * `Fix You [bass].mp3` — square brackets are what make it a part.
 *
 * Through the same label cleaner the importer uses, so Ableton's track
 * numbering doesn't end up in the file name: "Bass 1" is the first bass track,
 * not a part called "bass 1".
 *
 * A reference part says so in its label even when the track didn't — a "Lead
 * Vox 1" filed under REF is the record's lead vocal, and a prepared folder
 * where that is indistinguishable from the band's own lead vocal is a folder
 * nobody can read. The label is the only carrier: what comes out is an
 * ordinary library, understood by the same name rules as a hand-made one.
 */
export function partFileName(songTitle: string, partName: string, reference = false): string {
  const label = safeName(stemLabel(partName)).toLowerCase();
  const marked = reference && !/\bref(erence)?\b/.test(label) ? `ref ${label}` : label;
  return `${safeName(songTitle)} [${marked}].mp3`;
}

/** The tempo Live plays the song at: the automation's where there is any. */
function tempoOf(song: AlsSong, project: AlsProject): number {
  return song.startBpm ?? song.bpm ?? project.tempo;
}

function beatsPerBar(project: AlsProject): number {
  return project.timeSigNum * (4 / project.timeSigDen);
}

/** Bars to seconds at the song's own tempo, for placing clips. */
function barToSeconds(bar: number, bpm: number, project: AlsProject): number {
  return ((bar - 1) * beatsPerBar(project) * 60) / bpm;
}

/**
 * The manifest a part-set run should leave behind.
 *
 * Songs prepared on an earlier run keep their entry, this run's replace their
 * own, and the whole thing is ordered by the set — so the manifest reads like
 * the set does however many runs it took to fill. Anything no longer in the
 * set keeps its place at the end rather than being dropped: the files are
 * still there, and a manifest that forgot them would leave them tempo-less.
 */
export function mergeSongs(
  existing: PreparedSongInfo[],
  written: PreparedSongInfo[],
  setOrder: string[],
): PreparedSongInfo[] {
  const mine = new Map(written.map((w) => [w.folder, w]));
  const kept = existing.filter((song) => !mine.has(song.folder));
  const order = new Map(setOrder.map((folder, i) => [folder, i]));
  return [...kept, ...written].sort(
    (a, b) => (order.get(a.folder) ?? Infinity) - (order.get(b.folder) ?? Infinity),
  );
}

export async function prepareSet(opts: PrepareOptions): Promise<PrepareResult> {
  const {
    project, root, setName, resolvePath, readFile, writeFile, decode,
    onProgress, signal, bitrate = DEFAULT_BITRATE,
  } = opts;

  const folder = `${normalisePath(root)}/${PRINTS_FOLDER}/${PREPARED_FOLDER}/${safeName(setName)}`;
  const wanted = opts.only?.length ? new Set(opts.only) : null;
  const chosen = wanted ? project.songs.filter((s) => wanted.has(s.title)) : project.songs;
  const skipped: PrepareResult['skipped'] = [];
  const written: PreparedSongInfo[] = [];
  let songsWritten = 0;
  let partsWritten = 0;

  /*
   * Decoded source files, kept for the whole run. A set of fourteen songs
   * shares very few files between songs, but a single song's tracks often point
   * at the same file, and decoding a 50 MB WAV twice is pure waste.
   */
  const decoded = new Map<string, AudioBuffer>();
  const loadFile = async (relative: string, absPath?: string): Promise<AudioBuffer | null> => {
    const path = resolvePath(relative);
    const candidates = [path, absPath ? `abs:${absPath}` : null].filter((p): p is string => !!p);
    for (const [i, candidate] of candidates.entries()) {
      const already = decoded.get(candidate.toLowerCase());
      if (already) return already;
      try {
        const bytes = await readFile(candidate);
        const buffer = await decode(bytes);
        decoded.set(candidate.toLowerCase(), buffer);
        return buffer;
      } catch (err) {
        // Not in the folder under that name: a sample the set keeps
        // elsewhere is tried by its absolute path next.
        if (i === candidates.length - 1) throw err;
      }
    }
    return null;
  };

  const paddingSec = await measurePadding();

  for (const [index, song] of chosen.entries()) {
    if (signal?.aborted) throw new DOMException('Preparing cancelled', 'AbortError');

    const bpm = tempoOf(song, project);
    const durationSec = barToSeconds(song.endBar - song.startBar + 1, bpm, project);
    const songFolder = `${folder}/${songFolderName(song, project)}`;
    let wroteAny = false;

    for (const part of partsFor(song, opts.plan?.[song.title])) {
      if (signal?.aborted) throw new DOMException('Preparing cancelled', 'AbortError');

      const report = (stage: PrepareProgress['stage'], ratio: number) =>
        onProgress?.({
          songIndex: index + 1,
          songCount: chosen.length,
          songTitle: song.title,
          partName: part.name,
          stage,
          ratio,
        });

      try {
        report('reading', 0);
        // Every clip of every track in the part, placed; a combined part is
        // simply all of its tracks' clips rendered into one buffer.
        const placements: ClipPlacement[] = [];
        for (const stem of part.stems) {
          const live = stem.clips.filter((c) => !c.disabled);
          if (!live.length) {
            skipped.push({ song: song.title, part: stem.name, reason: 'nothing playing in this song' });
            continue;
          }
          for (const clip of live) {
            let buffer = await loadFile(clip.path, clip.absPath);
            if (!buffer) {
              skipped.push({ song: song.title, part: stem.name, reason: `missing ${clip.path}` });
              continue;
            }
            // As Live plays it: the clip's own transposition and warp speed.
            const speed = clip.speed ?? 1;
            if (opts.shift && ((clip.semitones ?? 0) !== 0 || Math.abs(speed - 1) > 1e-6)) {
              buffer = await opts.shift(buffer, clip.semitones ?? 0, speed, resolvePath(clip.path) ?? clip.path);
            }
            placements.push(placementOf(clip, buffer, bpm, project, speed, (stem.gain ?? 1) * (clip.gain ?? 1)));
          }
        }
        if (!placements.length) continue;

        // One clip playing its file from the top for the whole song already is
        // the part; rendering would copy it for nothing.
        report('rendering', 0);
        // A part below or above unity has to be rendered to come out at its level.
        const flat = part.combined || needsRender(placements, durationSec) || placements.some((p) => (p.gain ?? 1) !== 1)
          ? await renderTrack(placements, durationSec, placements[0].buffer.sampleRate,
              Math.min(2, Math.max(...placements.map((p) => p.buffer.numberOfChannels))))
          : placements[0].buffer;

        /*
         * Several tracks at unity can sum past full scale, and the encoder
         * has nowhere to put it. A combined part that clips is pulled down
         * as a whole — quieter, but faithful — and left alone otherwise.
         */
        if (part.combined) {
          const peak = peakOf(flat);
          if (peak > 1) {
            const gain = 0.99 / peak;
            for (let c = 0; c < flat.numberOfChannels; c++) {
              const data = flat.getChannelData(c);
              for (let i = 0; i < data.length; i++) data[i] *= gain;
            }
          }
        }

        report('encoding', 0);
        const blob = await encodeMp3(flat, {
          bitrate,
          signal,
          onProgress: (r) => report('encoding', r),
        });

        report('writing', 1);
        await writeFile(`${songFolder}/${partFileName(song.title, part.name, part.reference)}`, blob);
        partsWritten++;
        wroteAny = true;
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        skipped.push({
          song: song.title,
          part: part.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (wroteAny) {
      songsWritten++;
      const words = lyricsFileFor(song, project);
      if (words) await writeFile(`${songFolder}/${safeName(song.title)}.lrc`, words);

      /*
       * The same song as a chart a person can read: chords over the words,
       * sections named, key and tempo at the top. Every songbook app reads
       * ChordPro, so a prepared set is worth something outside this app too.
       */
      const chart = chordProFor(song, project);
      if (chart) {
        await writeFile(
          `${songFolder}/${safeName(song.title)}.cho`,
          new Blob([chart], { type: 'text/plain' }),
        );
      }

      /*
       * Everything the folder name has no room for. Without this a prepared set
       * plays at one tempo with no chart — the tempo map, the sections and the
       * chords would all be thrown away in the writing, and the encoder's
       * lead-in would go unmentioned and put every song fractionally late.
       */
      written.push({
        folder: songFolderName(song, project),
        title: song.title,
        firstBarOffsetSec: paddingSec,
        originalKey: song.key ?? undefined,
        tempoMap: song.tempoChanges.length ? song.tempoChanges : undefined,
        markers: song.sections.length
          ? song.sections.map((s) => ({ bar: s.bar, name: s.text }))
          : undefined,
        chords: song.chords.length ? song.chords : undefined,
        lanes: laneList(song),
        patchClips: song.rigMarks?.length
          ? clipsFromMarks(song.rigMarks, songIdFor(opts.alsPath, song.title))
          : undefined,
      });
    }
  }

  if (written.length) {
    const songs = mergeSongs(
      ((await opts.readManifest?.()) ?? { songs: [] }).songs,
      written,
      project.songs.map((s) => songFolderName(s, project)),
    );

    const manifest: PreparedManifest = {
      preparedBy: 'rehearsaltool',
      preparedAt: new Date().toISOString(),
      fromSet: opts.alsPath,
      paddingSec,
      songs,
    };
    await writeFile(
      `${folder}/${MANIFEST_NAME}`,
      new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    );
  }

  onProgress?.({
    songIndex: chosen.length, songCount: chosen.length,
    songTitle: '', partName: '', stage: 'done', ratio: 1,
  });

  return { folder, songsWritten, partsWritten, skipped, paddingSec };
}

/** Where a clip sits and which slice of its file it plays, in seconds. */
function placementOf(
  clip: AlsClip,
  buffer: AudioBuffer,
  bpm: number,
  project: AlsProject,
  speed = 1,
  gain = 1,
): ClipPlacement {
  return {
    buffer,
    gain,
    startSec: barToSeconds(clip.startBar, bpm, project),
    endSec: barToSeconds(clip.endBar, bpm, project),
    // A stretched file's seconds are shorter by the same factor.
    sourceStartSec: clip.sourceStartSec / speed,
    fadeInSec: clip.fadeInSec,
    fadeOutSec: clip.fadeOutSec,
  };
}

/**
 * The song's words as an `.lrc`, or null when it has none.
 *
 * LRC because it is the format the world already writes lyrics in, so they can
 * be edited anywhere rather than only here.
 */
export function lyricsFileFor(song: AlsSong, project: AlsProject): Blob | null {
  if (!song.lyrics.length) return null;

  /*
   * Bars are the set's unit and LRC wants a clock, so this goes through the
   * same bar maths the player uses — tempo map included. A song that speeds up
   * halfway would otherwise have every later line drifting further out.
   */
  const timing = {
    bpm: tempoOf(song, project),
    timeSigNum: project.timeSigNum,
    timeSigDen: project.timeSigDen,
    firstBarOffsetSec: 0,
    tempoMap: song.tempoChanges.length ? song.tempoChanges : undefined,
  };

  const lines = song.lyrics.map((line) => {
    const seconds = barToSec(line.bar, timing);
    const mins = Math.floor(seconds / 60);
    const secs = seconds - mins * 60;
    const stamp = `${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
    return `[${stamp}]${line.text}`;
  });
  return new Blob([`${lines.join('\n')}\n`], { type: 'text/plain' });
}

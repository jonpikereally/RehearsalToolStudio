import type { Song, Variant } from '../types';
import { availability, readBytes } from './source';
import { fileKey, getFile, putFile } from './idb';
import { getShiftedBuffer } from './pitchService';
import type { SongEngine, TrackConfig } from './audioEngine';
import { loadMix, loadedVariants, settingFor } from './stemMix';
import { isReferenceName, isUnpitched } from './scan';
import { renderTrack, type ClipPlacement } from './arrangement.ts';
import { barToSec } from './bars';
import { readPcmWindow } from './audioSlice.ts';

/**
 * Fetch → decode → (optionally) transpose every variant of a song, then hand
 * the whole set to the engine at once.
 */

export type LoadPhase = 'downloading' | 'decoding' | 'transposing' | 'ready';

export interface LoadProgress {
  phase: LoadPhase;
  variantName: string;
  /** 1-based position in the variant list. */
  index: number;
  total: number;
  /** 0..1 within the current variant, when known. */
  ratio: number;
  /** True when the bytes came from the local cache rather than the network. */
  cached: boolean;
}

/** Decoded originals for the song currently open, so key changes don't re-download. */
const decodedCache = new Map<string, { rev: string; buffer: AudioBuffer }>();

export function clearDecodedCache(): void {
  decodedCache.clear();
}

/* ----------------------------- songs held ready ---------------------------- */

/**
 * A song made ready to play: every part fetched, decoded, placed and rendered,
 * in the shape the engine takes them.
 *
 * Held on to so a run can step between songs without doing any of that twice.
 * What the mixer says is deliberately not part of it — that is read afresh
 * every time a song is installed, so a fader moved in song three is still
 * where you left it when song three comes round again.
 */
export interface ReadySong {
  /** Everything that decides what the buffers are. A change means rebuild. */
  key: string;
  tracks: Map<string, ReadyTrack>;
  /** The part that stands in for the metronome, when the set brought its own. */
  clickId: string | null;
  /** Which whole mix sounds when nothing carries over from the song before. */
  defaultActiveId: string | null;
  /** Every variant id in display order, whether or not it could be loaded. */
  order: string[];
  /** Parts that could not be loaded, so re-opening says so too. */
  skipped: { variant: Variant; reason: string }[];
  bytes: number;
  /** Least recently installed goes first when memory runs short. */
  touched: number;
}

export interface ReadyTrack {
  buffer: AudioBuffer;
  role: TrackConfig['role'];
  regions: TrackConfig['regions'];
  fileStartSec: number;
  devices: Variant['devices'];
  /** Where the set has this fader and pan, for a device that never touched them. */
  setLevel: number | undefined;
  setPan: number | undefined;
}

const heldSongs = new Map<string, ReadySong>();
let keptSongIds: string[] = [];
let heldBudget = 0;
let installClock = 0;

/**
 * The songs a run wants kept ready, and how much memory they may have between
 * them. Anything not named is let go at once; with no run at all nothing is
 * held, which is how a single song has always behaved.
 *
 * Decoded audio is enormous — a five-minute song of eight WAV stems is most of
 * a gigabyte — so holding a whole set is not free, and the budget is not a
 * formality. When it is reached the songs least recently played are dropped
 * and built again if they come round; slower than holding them, but not a
 * window that has run out of memory.
 */
export function keepReady(songIds: string[], budgetBytes: number): void {
  keptSongIds = [...songIds];
  heldBudget = budgetBytes;
  const wanted = new Set(songIds);
  for (const id of [...heldSongs.keys()]) if (!wanted.has(id)) releaseSong(id);
  makeRoom(null);
  heldChanged();
}

/**
 * Told whenever what is held changes.
 *
 * The player says how much of a run is ready, and preparing lets the whole lot
 * go to make room — so without this the page would go on claiming three songs
 * were a keypress away while none of them were.
 */
const heldListeners = new Set<() => void>();

export function onHeldChange(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => {
    heldListeners.delete(listener);
  };
}

function heldChanged(): void {
  for (const listener of heldListeners) listener();
}

/** Let every held song go: the run is over, or was never wanted. */
export function releaseReady(): void {
  keepReady([], 0);
}

/** Which songs are ready to play this instant. */
export function heldSongIds(): string[] {
  return [...heldSongs.keys()];
}

export function heldBytes(): number {
  let total = 0;
  for (const song of heldSongs.values()) total += song.bytes;
  return total;
}

function releaseSong(songId: string): void {
  const ready = heldSongs.get(songId);
  if (!ready) return;
  heldSongs.delete(songId);
  // The originals it was rendered from are scratch, and nothing else's.
  for (const id of ready.order) decodedCache.delete(id);
}

function makeRoom(keepId: string | null): void {
  let total = heldBytes();
  if (total <= heldBudget) return;
  const stalest = [...heldSongs.entries()]
    // Never the song that is playing, and never the one just built.
    .filter(([id]) => id !== keepId && id !== installedSongId)
    .sort((a, b) => a[1].touched - b[1].touched);
  for (const [id, ready] of stalest) {
    if (total <= heldBudget) return;
    total -= ready.bytes;
    releaseSong(id);
  }
}

/** The song in the engine now, so making room never throws it away. */
let installedSongId: string | null = null;

/**
 * Songs being made ready right now.
 *
 * The run builds the songs ahead while one plays, so opening the next song can
 * walk into one already half built; both callers wait on the one piece of work
 * rather than doing it twice.
 *
 * A build carries the signal of whoever started it, so it is only worth
 * joining while that signal still stands. One already given up on is a
 * rejection waiting to happen — which is not the same as "this song will not
 * load", and must not be handed to somebody who still wants the song.
 */
const building = new Map<string, { key: string; work: Promise<ReadySong>; signal?: AbortSignal }>();

function bufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

/**
 * What a song's buffers depend on. The parts and their revisions, the key and
 * speed they are rendered at, whether the set's devices are imitated, the
 * context's own sample rate — and the tempo map, since where every clip is
 * placed is worked out in bars.
 */
function readyKey(song: Song, opts: LoadOptions, sampleRate: number): string {
  return JSON.stringify([
    variantsToLoad(song).map((v) => `${v.id}@${v.rev}`),
    opts.semitones,
    opts.tempoScale ?? 1,
    !!opts.effects,
    sampleRate,
    song.bpm,
    song.timeSigNum,
    song.timeSigDen,
    song.firstBarOffsetSec,
    song.tempoMap ?? null,
  ]);
}

export function visibleVariants(song: Song): Variant[] {
  const shown = song.variants.filter((v) => !v.hidden);
  return shown.length ? shown : song.variants;
}

/**
 * Everything the song has. Every part loads, always: the mixer decides what
 * sounds, and a part that is not there to play is said so on the page.
 */
export function variantsToLoad(song: Song): Variant[] {
  const all = loadedVariants(song);
  return all.length ? all : visibleVariants(song);
}

async function bytesFor(
  variant: Variant,
  onProgress: (ratio: number, cached: boolean) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const key = fileKey(variant.path, variant.rev);
  const hit = await getFile(key);
  if (hit) {
    onProgress(1, true);
    return hit.bytes;
  }

  const { bytes, mime, from } = await readBytes(
    variant.path,
    (loaded, total) => onProgress(total ? loaded / total : 0, false),
    signal,
  );
  /*
   * Only what came over the network. The cache exists so a file fetched once
   * doesn't have to be fetched again — a file already on this machine is
   * nothing to save, and copying it in would write a second gigabyte of the
   * same audio into browser storage and eventually evict something that was
   * genuinely worth keeping.
   *
   * A storage failure is not fatal either way: a miss is only a re-read.
   */
  if (from === 'remote') {
    void putFile({ key, path: variant.path, bytes, mime, addedAt: Date.now() }).catch(() => {});
  }
  return bytes;
}

/**
 * How many parts to work on at once.
 *
 * Rendering was strictly one after another, which put a key change at roughly
 * 1.4 seconds per part — eleven seconds for a song of eight. Each concurrent
 * render also holds its own working buffers, though, so this stays deliberately
 * modest rather than fanning out across every core.
 */
function concurrencyLimit(): number {
  const cores = navigator.hardwareConcurrency ?? 4;
  return cores >= 8 ? 3 : 2;
}

/** Run `fn` over `items`, never more than `limit` at a time. */
async function inParallel<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(runners);
}

/** A sampler part's notes as clips: one-shots, each given room to ring out. */
export function samplerClips(variant: Variant): Variant['clips'] {
  const byNote = new Map((variant.samples ?? []).map((s) => [s.note, s]));
  const clips = [];
  for (const n of variant.notes ?? []) {
    const sample = byNote.get(n.note);
    if (!sample) continue;
    clips.push({
      path: sample.path,
      startBar: n.bar,
      endBar: n.bar + 16,
      sourceStartSec: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      semitones: 0,
      speed: 1,
      gain: (sample.gain ?? 1) * (n.velocity ?? 1) ** 2,
    });
  }
  return clips;
}

/** The set's own click track, brought in as a part: it stands in for the metronome. */
export function isSetClick(song: Song, variant: Variant): boolean {
  return (!!song.setPath || variant.kind === 'sampler') && variant.name.trim().toLowerCase() === 'click';
}

/** The set's cues, likewise one part of every song of the set. */
export function isSetCues(song: Song, variant: Variant): boolean {
  return (!!song.setPath || variant.kind === 'sampler') && variant.name.trim().toLowerCase() === 'cues';
}

/** The set's own parts, click and cues, as against the song's. */
export function isSetPart(song: Song, variant: Variant): boolean {
  return isSetClick(song, variant) || isSetCues(song, variant);
}

/** One file of a song, and which part wants it. */
export interface FileStanding {
  part: string;
  path: string;
}

/** Every file the song's parts want, sorted by whether it can be had. */
export interface FilesReport {
  missing: FileStanding[];
  forbidden: FileStanding[];
  /**
   * Musical parts with not one file to play — every clip of them missing or
   * unreadable. The set's click and cues are never counted among these: a
   * song that has only those is a song with nothing to hear.
   */
  silentParts: string[];
  /** How many musical parts the song has at all, playable or not. */
  musicalParts: number;
}

/**
 * Whether opening this song would give you nothing but a click.
 *
 * Worth its own question because the answer is different in kind from "some
 * files are missing": seven of nine parts missing is a thin song, and all of
 * them missing is not a song at all. Someone about to open it deserves to
 * know which of those it is before they wait for it to load.
 */
export function nothingToHear(report: FilesReport): boolean {
  return report.musicalParts > 0 && report.silentParts.length === report.musicalParts;
}

/**
 * What of the song is not there to play: files not in the folder, and
 * files in a folder the studio has not been allowed to read. Every part's
 * file and every clip of an arranged part, each asked about once. With
 * `songOnly`, the set's click and cues are left out of the asking: they
 * belong to the set, and a song is not missing audio for their sake.
 */
export async function filesReport(song: Song, { songOnly = false } = {}): Promise<FilesReport> {
  /*
   * Keyed without case so one file is asked about once, but asked about by
   * the path the set wrote. The server matches a path against the folders it
   * was given letter for letter, so a lowercased one was refused as outside
   * a folder that had in fact been allowed.
   */
  const wanted = new Map<string, { path: string; part: string }>();
  /** Each musical part's files, so a part can be judged whole. */
  const musical = new Map<string, string[]>();

  for (const v of variantsToLoad(song)) {
    const setPart = isSetPart(song, v);
    if (songOnly && setPart) continue;
    const paths = v.kind === 'sampler' ? (v.samples ?? []).map((s) => s.path) : v.clips?.length ? v.clips.map((c) => c.path) : [v.path];
    if (!setPart) musical.set(v.name, paths);
    for (const path of paths) {
      if (!wanted.has(path.toLowerCase())) wanted.set(path.toLowerCase(), { path, part: v.name });
    }
  }

  const report: FilesReport = {
    missing: [],
    forbidden: [],
    silentParts: [],
    musicalParts: musical.size,
  };
  const unplayable = new Set<string>();
  for (const { path, part } of wanted.values()) {
    const standing = await availability(path);
    if (standing === 'missing') report.missing.push({ part, path });
    if (standing === 'forbidden') report.forbidden.push({ part, path });
    if (standing !== 'here') unplayable.add(path.toLowerCase());
  }

  // An arranged part is silent only when every one of its clips is gone; one
  // surviving clip still plays, in its own place, with the rest silent.
  for (const [name, paths] of musical) {
    if (paths.every((path) => unplayable.has(path.toLowerCase()))) report.silentParts.push(name);
  }
  return report;
}

export interface LoadOptions {
  semitones: number;
  /** Playback speed vs the recording: 1 untouched, 0.9 a tenth slower. */
  tempoScale?: number;
  budgetBytes: number;
  /** Imitate the set's devices and buses in Web Audio. Off plays the files raw. */
  effects?: boolean;
  /** A part that could not be loaded is left out and reported here, not fatal. */
  onSkip?: (variant: Variant, reason: string) => void;
  onProgress?: (p: LoadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Make every visible variant of a song ready to play, without touching what
 * the engine is playing now.
 *
 * This is the whole cost of opening a song — fetching, decoding, arranging,
 * transposing — and it is separate from installing the result so a run can pay
 * it for the song after next while this one plays. A song the run is holding
 * that is already ready is returned as it stands.
 */
export async function prepareSong(
  engine: SongEngine,
  song: Song,
  opts: LoadOptions,
): Promise<ReadySong> {
  const ctx = await engine.ensureContext();
  const key = readyKey(song, opts, ctx.sampleRate);
  const standing = heldSongs.get(song.id);
  if (standing && standing.key === key) {
    // Say again what could not be loaded: the page asks the song, not the load.
    for (const { variant, reason } of standing.skipped) opts.onSkip?.(variant, reason);
    opts.onProgress?.({ phase: 'ready', variantName: '', index: standing.order.length, total: standing.order.length, ratio: 1, cached: true });
    return standing;
  }

  const busy = building.get(song.id);
  if (busy && busy.key === key && !busy.signal?.aborted) return busy.work;

  const work = buildSong(engine, song, opts, ctx, key);
  building.set(song.id, { key, work, signal: opts.signal });
  try {
    return await work;
  } finally {
    if (building.get(song.id)?.work === work) building.delete(song.id);
  }
}

async function buildSong(
  engine: SongEngine,
  song: Song,
  opts: LoadOptions,
  ctx: AudioContext,
  key: string,
): Promise<ReadySong> {
  const { semitones, budgetBytes, onProgress, signal } = opts;
  const tempo = opts.tempoScale && opts.tempoScale > 0 ? opts.tempoScale : 1;
  const variants = variantsToLoad(song);

  const skipped: { variant: Variant; reason: string }[] = [];
  const buffers = new Map<string, AudioBuffer>();

  let done = 0;

  /** A part left out, said now and remembered for the next time it is opened. */
  const note = (variant: Variant, reason: string) => {
    skipped.push({ variant, reason });
    opts.onSkip?.(variant, reason);
  };

  const loadOne = async (variant: Variant): Promise<void> => {
    if (signal?.aborted) throw new DOMException('Load cancelled', 'AbortError');

    const report = (phase: LoadPhase, ratio: number, cached: boolean) =>
      onProgress?.({
        phase,
        variantName: variant.name,
        index: Math.min(done + 1, variants.length),
        total: variants.length,
        ratio,
        cached,
      });

    /*
     * The part's clips, when it is an arrangement rather than one file: the
     * same renderer the preparer uses lays them out flat, so a phrase dropped
     * in from another take plays where the set put it. The result is one
     * buffer from bar 1, memoised under the arrangement's own signature.
     */
    /*
     * A sampler part is played as an arrangement: every note become a clip
     * of its sample, the same way a click straight out of a set is. Velocity
     * is squared, as the band's player squares it, so the two sound alike.
     */
    // A frozen track is one clip carried as an arrangement, so it goes this
    // way too: the clip says which stretch of a set-long file is the song's.
    const sampler = variant.kind === 'sampler' ? samplerClips(variant) : null;
    const arranged = sampler ?? (variant.clips && variant.clips.length ? variant.clips : null);
    const rev = arranged
      ? `${variant.rev}|${arranged.map((c) => `${c.path}@${c.startBar}-${c.endBar}+${c.sourceStartSec}`).join(';')}`
      : variant.rev;

    // 1 + 2. bytes and decode (memoised across key changes)
    let original: AudioBuffer;
    const cachedDecode = decodedCache.get(variant.id);
    if (cachedDecode && cachedDecode.rev === rev && cachedDecode.buffer.sampleRate === ctx.sampleRate) {
      original = cachedDecode.buffer;
    } else if (arranged) {
      report('downloading', 0, false);
      const files = new Map<string, AudioBuffer>();
      const placements: ClipPlacement[] = [];
      const unread = new Map<string, string>();
      // Where a sliced file's samples begin, for placing the clip against it.
      const fromSec = new Map<string, number>();
      for (const [i, clip] of arranged.entries()) {
        /*
         * A frozen track's file is Live's render of the whole set, and only
         * the song's stretch of it is read — from the clip's own offset, for
         * as long as the clip plays at whatever speed it is played. A file
         * that cannot be cut is read whole, as any other.
         */
        const span = (barToSec(clip.endBar, song) - barToSec(clip.startBar, song)) * Math.max(1, tempo) * 1.05 + 1;
        const fileKey = clip.frozen ? `${clip.path.toLowerCase()}#${clip.sourceStartSec.toFixed(3)}` : clip.path.toLowerCase();
        let buffer = files.get(fileKey);
        if (!buffer) {
          if (unread.has(fileKey)) continue;
          try {
            let bytes: ArrayBuffer;
            if (clip.frozen) {
              const cut = await readPcmWindow(
                async (start, end) => {
                  const got = await readBytes(clip.path, undefined, signal, { start, end });
                  return { bytes: got.bytes, size: got.size };
                },
                clip.sourceStartSec,
                span,
              );
              bytes = cut ? cut.bytes : (await readBytes(clip.path, undefined, signal)).bytes;
              fromSec.set(fileKey, cut ? cut.fromSec : 0);
            } else {
              bytes = (await readBytes(clip.path, undefined, signal)).bytes;
            }
            report('decoding', i / arranged.length, true);
            buffer = await engine.decode(bytes);
          } catch (err) {
            if ((err as { name?: string })?.name === 'AbortError') throw err;
            // One clip whose file is not to be had, or will not decode: the
            // rest still play, and the page says which was left out.
            unread.set(fileKey, err instanceof Error ? err.message : String(err));
            continue;
          }
          files.set(fileKey, buffer);
        }
        /*
         * Each clip is shifted by its own transposition in Live plus the
         * player's, and stretched by its warp plus the player's speed, before
         * it is placed — so the render below is already at pitch and speed,
         * and the song-wide step afterwards is skipped for arranged parts.
         */
        const clipShift = (isUnpitched(variant.name) ? 0 : semitones) + clip.semitones;
        const clipTempo = tempo * clip.speed;
        if (clipShift !== 0 || clipTempo !== 1) {
          report('transposing', i / arranged.length, true);
          buffer = await getShiftedBuffer({
            ctx,
            path: clip.path,
            rev: variant.rev,
            semitones: clipShift,
            tempo: clipTempo,
            source: buffer,
            budgetBytes,
            signal,
          });
        }
        placements.push({
          buffer,
          startSec: barToSec(clip.startBar, song),
          endSec: barToSec(clip.endBar, song),
          sourceStartSec: (clip.sourceStartSec - (fromSec.get(fileKey) ?? 0)) / clipTempo,
          fadeInSec: clip.fadeInSec,
          fadeOutSec: clip.fadeOutSec,
          gain: clip.gain,
        });
      }
      if (!placements.length) throw new Error('none of its files could be read');
      if (unread.size) {
        note(
          variant,
          `${unread.size} of its files could not be read — ${[...unread]
            .slice(0, 3)
            .map(([p, why]) => `${p.split('/').pop()}: ${why}`)
            .join('; ')}${unread.size > 3 ? '…' : ''}`,
        );
      }
      const durationSec = Math.max(...placements.map((p) => p.endSec));
      const channels = Math.min(2, Math.max(...placements.map((p) => p.buffer.numberOfChannels)));
      original = await renderTrack(placements, durationSec, ctx.sampleRate, channels);
      decodedCache.set(variant.id, { rev, buffer: original });
    } else {
      report('downloading', 0, false);
      const bytes = await bytesFor(variant, (ratio, cached) => report('downloading', ratio, cached), signal);
      report('decoding', 0, true);
      original = await engine.decode(bytes);
      decodedCache.set(variant.id, { rev, buffer: original });
    }

    /*
     * 3. transpose and/or stretch.
     *
     * A click or a spoken cue is never transposed — but it must still be
     * stretched, or it would drift out of time with everything else.
     */
    let buffer = original;
    // The clip's own transposition and warp speed in Live ride along with the
    // player's; an arranged part had both applied clip by clip above.
    const shift = arranged ? 0 : (isUnpitched(variant.name) ? 0 : semitones) + (variant.pitch ?? 0);
    const speed = arranged ? 1 : tempo * (variant.speed ?? 1);
    if (shift !== 0 || speed !== 1) {
      report('transposing', 0, true);
      buffer = await getShiftedBuffer({
        ctx,
        path: variant.path,
        rev,
        semitones: shift,
        tempo: speed,
        source: original,
        budgetBytes,
        onProgress: (ratio) => report('transposing', ratio, true),
        signal,
      });
    }

    buffers.set(variant.id, buffer);
    done++;
  };

  /*
   * A part that cannot be loaded — its file missing, or in a folder the
   * studio may not read — is left out and said so, and the song still opens
   * with the rest. It used to take the whole song down with it.
   */
  const loadOrSkip = async (variant: Variant): Promise<void> => {
    try {
      await loadOne(variant);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      note(variant, err instanceof Error ? err.message : String(err));
      done++;
    }
  };
  await inParallel(variants, concurrencyLimit(), loadOrSkip);

  if (signal?.aborted) throw new DOMException('Load cancelled', 'AbortError');

  const tracks = new Map<string, ReadyTrack>();
  let bytes = 0;
  for (const variant of variants) {
    const buffer = buffers.get(variant.id);
    if (!buffer) continue;
    /*
     * The reference master is its own thing: SWITCH plays it instead of the
     * parts. Every other whole mix is just a channel.
     */
    const role =
      variant.role === 'stem' ? 'stem' : isReferenceName(variant.name) ? 'reference' : 'mix';
    tracks.set(variant.id, {
      buffer,
      role,
      /*
       * Bars, not seconds, come out of the set — so they follow the tempo map
       * and any stretch applied here, and a part still drops out on the right
       * beat when the song is played slower.
       */
      regions: variant.regions?.map((r) => ({
        startSec: barToSec(r.startBar, song),
        endSec: barToSec(r.endBar, song),
      })),
      // Where the file's start lands in the song. The bar follows the tempo
      // map; the seconds into the file stretch with the playback speed.
      fileStartSec: variant.placement
        ? barToSec(variant.placement.bar, song) - variant.placement.sourceSec / (tempo * (variant.speed ?? 1))
        : 0,
      devices: variant.devices,
      // Where the set has the fader and pan — the track's times its groups',
      // which is what Live plays. Only used until this device moves them.
      setLevel: variant.gain,
      setPan: variant.pan,
    });
    bytes += bufferBytes(buffer);
  }

  const ready: ReadySong = {
    key,
    tracks,
    // A set's click track takes the metronome's place, so there is one click.
    clickId: variants.find((v) => isSetClick(song, v))?.id ?? null,
    defaultActiveId: variants.find((v) => v.role !== 'stem')?.id ?? null,
    order: variants.map((v) => v.id),
    skipped,
    bytes,
    touched: ++installClock,
  };

  /*
   * Transposing leaves two full copies of every part in memory — the original
   * and the shifted one — which for a song of WAV stems is well over a
   * gigabyte and enough to bog the whole browser down. The originals are only
   * needed to render another key, and re-decoding them from the cached bytes
   * is quick, so let them go.
   */
  if (semitones !== 0 || tempo !== 1) decodedCache.clear();

  // Only a run holds songs; on its own a song is built, played and let go.
  if (keptSongIds.includes(song.id)) {
    heldSongs.set(song.id, ready);
    makeRoom(song.id);
    heldChanged();
  }

  onProgress?.({ phase: 'ready', variantName: '', index: variants.length, total: variants.length, ratio: 1, cached: true });
  return ready;
}

/**
 * Put a ready song into the engine, replacing whatever was playing.
 *
 * Cheap by design — building the audio graph and nothing else — which is what
 * makes stepping between the songs of a run instant.
 */
export async function installSong(
  engine: SongEngine,
  song: Song,
  ready: ReadySong,
  opts: { effects?: boolean } = {},
): Promise<void> {
  ready.touched = ++installClock;
  installedSongId = song.id;

  // This device's saved fader positions, read now rather than when the buffers
  // were made, so a mix set on the last pass through the set is still there.
  const savedMix = loadMix(song.id);
  const configs = new Map<string, TrackConfig>();
  for (const [id, track] of ready.tracks) {
    const saved = settingFor(savedMix, id);
    const touched = id in savedMix;
    /*
     * No special casing for the reference: beside stems it is silent until
     * SWITCH brings it in, which the engine enforces, so its fader is free to
     * mean what it says — the level it plays at when it is the one playing.
     */
    configs.set(id, {
      buffer: track.buffer,
      role: track.role,
      level: touched ? saved.level : (track.setLevel ?? saved.level),
      muted: saved.muted,
      pan: touched ? saved.pan : (track.setPan ?? saved.pan),
      regions: track.regions,
      fileStartSec: track.fileStartSec,
      devices: track.devices,
    });
  }

  const preferred = engine.activeVariantId;
  const activeId =
    preferred && configs.get(preferred)?.role === 'mix' ? preferred : ready.defaultActiveId;
  await engine.setTracks(configs, activeId, { effects: !!opts.effects });
  engine.useClickTrack(ready.clickId);
}

/**
 * Load a song and install it. Returns the variant ids in display order.
 */
export async function loadSong(
  engine: SongEngine,
  song: Song,
  opts: LoadOptions,
): Promise<string[]> {
  const ready = await prepareSong(engine, song, opts);
  if (opts.signal?.aborted) throw new DOMException('Load cancelled', 'AbortError');
  await installSong(engine, song, ready, { effects: opts.effects });
  return ready.order;
}

/** Total bytes that would need downloading for a song (0 when fully cached). */
export async function pendingDownloadBytes(song: Song): Promise<number> {
  let total = 0;
  // Only what this mode will actually fetch, so the estimate matches the load.
  for (const variant of variantsToLoad(song)) {
    const hit = await getFile(fileKey(variant.path, variant.rev));
    if (!hit) total += variant.sizeBytes;
  }
  return total;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

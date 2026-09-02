import type { Song, Variant } from '../types';
import { isLocal, readBytes } from './source';
import { fileKey, getFile, putFile } from './idb';
import { getShiftedBuffer } from './pitchService';
import type { SongEngine, TrackConfig } from './audioEngine';
import { loadMix, loadedVariants, settingFor } from './stemMix';
import { skippedFor } from './loadPrefs';
import { isReferenceName, isUnpitched } from './scan';
import { renderTrack, type ClipPlacement } from './arrangement.ts';
import { barToSec } from './bars';

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

export function visibleVariants(song: Song): Variant[] {
  const shown = song.variants.filter((v) => !v.hidden);
  return shown.length ? shown : song.variants;
}

/**
 * Everything the song has, less what this device has chosen not to fetch.
 * The mixer decides what actually sounds out of that.
 */
export function variantsToLoad(song: Song): Variant[] {
  const skipped = new Set(skippedFor(song.id));
  const chosen = loadedVariants(song).filter((v) => !skipped.has(v.id));
  if (chosen.length) return chosen;
  // Never load nothing: an empty choice falls back to whatever the song has.
  const all = loadedVariants(song);
  return all.length ? all : visibleVariants(song);
}

export interface DownloadItem {
  variant: Variant;
  /** Nothing to fetch: either cached already, or sitting on this machine. */
  cached: boolean;
  /** Where it already is, when it is anywhere. */
  where: 'disk' | 'cache' | 'remote';
}

/**
 * What opening this song would cost, part by part.
 *
 * Everything the song offers is listed, including parts this device currently
 * skips, so the picker can show the whole set rather than only what's already
 * chosen.
 */
export async function downloadPlan(song: Song): Promise<DownloadItem[]> {
  const items: DownloadItem[] = [];
  for (const variant of loadedVariants(song)) {
    /*
     * Disk first. Asking the cache alone reported a file sitting in the user's
     * own folder as "not on this device" and put a price in megabytes against
     * opening it.
     */
    if (await isLocal(variant.path)) {
      items.push({ variant, cached: true, where: 'disk' });
      continue;
    }
    const hit = await getFile(fileKey(variant.path, variant.rev));
    items.push({ variant, cached: !!hit, where: hit ? 'cache' : 'remote' });
  }
  return items;
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

export interface LoadOptions {
  semitones: number;
  /** Playback speed vs the recording: 1 untouched, 0.9 a tenth slower. */
  tempoScale?: number;
  budgetBytes: number;
  onProgress?: (p: LoadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Load every visible variant and install them in the engine.
 * Returns the ids in display order.
 */
export async function loadSong(
  engine: SongEngine,
  song: Song,
  opts: LoadOptions,
): Promise<string[]> {
  const { semitones, budgetBytes, onProgress, signal } = opts;
  const tempo = opts.tempoScale && opts.tempoScale > 0 ? opts.tempoScale : 1;
  const variants = variantsToLoad(song);
  const ctx = await engine.ensureContext();
  const buffers = new Map<string, AudioBuffer>();

  let done = 0;

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
    const arranged = variant.clips && variant.clips.length > 1 ? variant.clips : null;
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
      for (const [i, clip] of arranged.entries()) {
        let buffer = files.get(clip.path.toLowerCase());
        if (!buffer) {
          const { bytes } = await readBytes(clip.path, undefined, signal);
          report('decoding', i / arranged.length, true);
          buffer = await engine.decode(bytes);
          files.set(clip.path.toLowerCase(), buffer);
        }
        placements.push({
          buffer,
          startSec: barToSec(clip.startBar, song),
          endSec: barToSec(clip.endBar, song),
          sourceStartSec: clip.sourceStartSec,
          fadeInSec: clip.fadeInSec,
          fadeOutSec: clip.fadeOutSec,
        });
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
    const shift = isUnpitched(variant.name) ? 0 : semitones;
    if (shift !== 0 || tempo !== 1) {
      report('transposing', 0, true);
      buffer = await getShiftedBuffer({
        ctx,
        path: variant.path,
        rev,
        semitones: shift,
        tempo,
        source: original,
        budgetBytes,
        onProgress: (ratio) => report('transposing', ratio, true),
        signal,
      });
    }

    buffers.set(variant.id, buffer);
    done++;
  };

  await inParallel(variants, concurrencyLimit(), loadOne);

  if (signal?.aborted) throw new DOMException('Load cancelled', 'AbortError');

  // Attach each file's role and this device's saved fader position.
  const savedMix = loadMix(song.id);

  const configs = new Map<string, TrackConfig>();
  for (const variant of variants) {
    const buffer = buffers.get(variant.id);
    if (!buffer) continue;
    /*
     * The reference master is its own thing: SWITCH plays it instead of the
     * parts. Every other whole mix is just a channel.
     */
    const role =
      variant.role === 'stem' ? 'stem' : isReferenceName(variant.name) ? 'reference' : 'mix';
    const saved = settingFor(savedMix, variant.id);
    /*
     * No special casing for the reference any more: beside stems it is silent
     * until SWITCH brings it in, which the engine enforces, so its fader is
     * free to mean what it says — the level it plays at when it is the one
     * playing.
     */
    configs.set(variant.id, {
      buffer,
      role,
      level: saved.level,
      muted: saved.muted,
      pan: saved.pan,
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
        ? barToSec(variant.placement.bar, song) - variant.placement.sourceSec / tempo
        : 0,
    });
  }

  const mixes = variants.filter((v) => v.role !== 'stem');
  const preferred = engine.activeVariantId;
  const activeId =
    preferred && configs.get(preferred)?.role === 'mix' ? preferred : mixes[0]?.id ?? null;
  await engine.setTracks(configs, activeId);

  /*
   * Transposing leaves two full copies of every part in memory — the original
   * and the shifted one — which for a song of WAV stems is well over a
   * gigabyte and enough to bog the whole browser down. The originals are only
   * needed to render another key, and re-decoding them from the cached bytes
   * is quick, so let them go.
   */
  if (semitones !== 0 || tempo !== 1) decodedCache.clear();

  onProgress?.({ phase: 'ready', variantName: '', index: variants.length, total: variants.length, ratio: 1, cached: true });
  return variants.map((v) => v.id);
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

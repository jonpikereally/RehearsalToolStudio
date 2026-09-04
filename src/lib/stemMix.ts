import type { Song, Variant } from '../types';

/**
 * Per-stem fader and mute settings.
 *
 * Deliberately stored on the device rather than in the shared library file: the
 * bass player wants the bass down and the drummer wants the drums down, and
 * syncing that through Dropbox would have them fighting over each other's mix.
 * Solo is not persisted at all — it is a momentary "let me hear that" control.
 */

const LS_KEY = 'ls.stemMix';

export interface StemSetting {
  /** Fader position, 0..1.5 (unity is 1). */
  level: number;
  muted: boolean;
  /** -1 hard left, 0 centre, +1 hard right. */
  pan: number;
}

export type SongStemMix = Record<string, StemSetting>;
type AllMixes = Record<string, SongStemMix>;

export const DEFAULT_STEM: StemSetting = { level: 1, muted: false, pan: 0 };

/**
 * Held in memory and written back lazily.
 *
 * A fader emits an event per pixel of travel. Parsing and re-serialising every
 * saved mix on each one — through synchronous localStorage, which blocks the
 * main thread — was enough to make dragging a slider stutter. Read once, keep
 * it, and persist a moment after the movement stops.
 */
let cache: AllMixes | null = null;
let writeTimer: number | null = null;

function readAll(): AllMixes {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    cache = raw ? (JSON.parse(raw) as AllMixes) : {};
  } catch {
    cache = {};
  }
  return cache;
}

const WRITE_DELAY_MS = 400;

function scheduleWrite(): void {
  if (writeTimer !== null) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(flushMix, WRITE_DELAY_MS);
}

/** Force the pending write out — used before the page goes away. */
export function flushMix(): void {
  if (writeTimer !== null) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!cache) return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache));
  } catch {
    /* storage full or blocked — the mix simply won't persist */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushMix);
}

export function loadMix(songId: string): SongStemMix {
  return readAll()[songId] ?? {};
}

export function settingFor(mix: SongStemMix, variantId: string): StemSetting {
  // Spread over the defaults so mixes saved before `pan` existed still work.
  return { ...DEFAULT_STEM, ...mix[variantId] };
}

export function saveSetting(songId: string, variantId: string, setting: StemSetting): void {
  const all = readAll();
  const song = all[songId] ?? {};
  song[variantId] = setting;
  all[songId] = song;
  scheduleWrite();
}

/**
 * Everything the song has, mixes and parts alike.
 *
 * There used to be a choice here — load the reference alone, or the stems —
 * from when the two were exclusive. The reference is a channel in the mixer
 * now, with a fader to blend it and a SWITCH to hear it outright, so there is
 * nothing left to choose between: it all loads, and the mixer decides what
 * sounds.
 */
export function loadedVariants(song: Song): Variant[] {
  return [...mixesOf(song), ...stemsOf(song)];
}

/**
 * The mixes offered as exclusive version buttons.
 *
 * Only when the song has no stems. With stems loaded a mix is a channel with
 * its own fader, so a button switching it on and off would be a second control
 * fighting the first.
 */
export function versionButtons(song: Song): Variant[] {
  return stemsOf(song).length ? [] : mixesOf(song);
}

/** Every channel the mixer shows: the parts and the reference. */
export function mixerChannels(song: Song): Variant[] {
  const stems = stemsOf(song);
  return stems.length ? [...stems, ...mixesOf(song)] : [];
}

/** Forget a song's saved mix, returning every stem to unity and unmuted. */
export function resetMix(songId: string): void {
  const all = readAll();
  delete all[songId];
  flushMix();
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Sort by the order the user arranged, keeping anything unnumbered in the
 * position the scan gave it. Array#sort is stable, so ties don't shuffle.
 */
function byOrder(a: Variant, b: Variant): number {
  return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
}

/** Desk-style pan readout: C in the middle, L/R with a percentage either side. */
export function formatPan(pan: number): string {
  const amount = Math.round(Math.abs(pan) * 100);
  if (amount < 2) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${amount}`;
}

export function stemsOf(song: Song): Variant[] {
  return song.variants.filter((v) => !v.hidden && v.role === 'stem').sort(byOrder);
}

export function mixesOf(song: Song): Variant[] {
  return song.variants.filter((v) => !v.hidden && v.role !== 'stem').sort(byOrder);
}

export function hasStems(song: Song): boolean {
  return stemsOf(song).length > 0;
}

/* ----------------------------- reference stems ---------------------------- */

const REF_WORD = /\bref(erence)?\b/i;

/**
 * A reference stem: the record's own drums, or vocal, beside the band's.
 *
 * Sets keep the finished record next to the parts — a REF folder holding a
 * "REF VOX" to check a line against — and those play alongside the band like
 * any other part. The reference *master* is not one of these: it is a whole
 * mix, exclusive, and SWITCH is what plays it.
 *
 * The flag on the part decides, with the name as a fallback for parts that
 * predate it. Not the name alone: a part renamed in the mixer would stop
 * being the record's the moment somebody tidied the word away.
 */
export function isReferenceStem(variant: Variant): boolean {
  if (variant.role !== 'stem') return false;
  return variant.reference === true || REF_WORD.test(variant.name);
}

/**
 * What to call a reference stem on screen: its own name, without the word.
 *
 * "REF DRUMS" is drums. Saying so leaves the fader labelled the same as every
 * other, which is what makes a mixer readable at a glance — and the fact that
 * it is the record's is said underneath rather than smuggled into the name,
 * where it competes with the instrument for the same few characters.
 */
export function partName(variant: Variant): string {
  if (!isReferenceStem(variant)) return variant.name;
  const bare = variant.name.replace(REF_WORD, ' ').replace(/\s+/g, ' ').trim();
  return bare || variant.name;
}

import type { ChartLane } from '../types';

/**
 * The Nashville number system, and chord names, each from the other.
 *
 * A set may write its chords either way. Numbers say what a chord *does* — 1,
 * 4, 5m — and so survive a change of key; names say what to play without any
 * thinking. A band wants both: the numbers to see the shape of a song, the
 * names to put fingers down.
 *
 * By convention here the tonic is 1 whether the key is major or minor, so A
 * minor counts A=1m, C=b3, E=5. Numbering a minor key against its relative
 * major instead is a defensible other convention, and the wrong one to spring
 * on someone reading a chart mid-song.
 *
 * Only the root is converted. Everything hanging off it — maj7, sus4, add9,
 * an inversion's bass note — is carried across untouched, because a suffix
 * means the same in both languages.
 */

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Semitones above the tonic for each degree of the major scale. */
const DEGREE = [0, 2, 4, 5, 7, 9, 11];

/** How the app writes each degree, counting the tonic as 1. */
const LABEL = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];

const NOTE = /^([A-G])([b#]?)/;

/** A note name to its pitch class, or null if it isn't one. */
export function pitchOf(note: string): number | null {
  const m = NOTE.exec(note.trim());
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'];
  return (base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

/**
 * Keys written with flats. A chart in Eb saying D# would be read twice — once
 * to work out what it meant — so the key decides the spelling.
 */
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);

export interface Key {
  tonic: number;
  /** True when the chart should be spelled with flats. */
  flats: boolean;
}

export function parseKey(key: string | null | undefined): Key | null {
  if (!key) return null;
  const clean = key.trim();
  const tonic = pitchOf(clean);
  if (tonic === null) return null;
  const name = clean.replace(/\s+/g, '');
  const minor = /m(in)?$/i.test(name) && !/maj/i.test(name);
  const root = NOTE.exec(name)![0];
  return { tonic, flats: name.includes('b') || FLAT_KEYS.has(minor ? `${root}m` : root) };
}

/** `C#m7/G#` → the number that chord is in the given key, e.g. `1m7/5`. */
export function toNashville(chord: string, key: Key): string | null {
  const text = chord.trim();
  if (!text) return null;
  const [head, bass] = splitSlash(text);
  const root = pitchOf(head);
  if (root === null) return null;

  const suffix = head.replace(NOTE, '');
  const degree = LABEL[(root - key.tonic + 12) % 12];
  const bassPart = bass ? bassNumber(bass, key) : '';
  return `${degree}${suffix}${bassPart}`;
}

/** `1m7/5` → the chord it names in the given key, e.g. `C#m7/G#`. */
export function fromNashville(number: string, key: Key): string | null {
  const text = number.trim();
  if (!text) return null;
  const [head, bass] = splitSlash(text);
  const semis = degreeSemitones(head);
  if (semis === null) return null;

  const names = key.flats ? FLAT : SHARP;
  const suffix = head.replace(/^[b#♭♯]?[1-7]/, '');
  const bassPart = bass ? bassName(bass, key) : '';
  return `${names[(key.tonic + semis + 12) % 12]}${suffix}${bassPart}`;
}

/** Whether a lane's text reads as numbers rather than names. */
export function looksNashville(items: { text: string }[]): boolean {
  const chords = items.filter((i) => i.text.trim());
  if (!chords.length) return false;
  const numbered = chords.filter((i) => degreeSemitones(splitSlash(i.text.trim())[0]) !== null);
  return numbered.length > chords.length / 2;
}

/* --------------------------------- helpers -------------------------------- */

function splitSlash(text: string): [string, string | null] {
  const at = text.indexOf('/');
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + 1)];
}

function degreeSemitones(text: string): number | null {
  const m = /^([b#♭♯]?)([1-7])/.exec(text.trim());
  if (!m) return null;
  const shift = m[1] === '#' || m[1] === '♯' ? 1 : m[1] === 'b' || m[1] === '♭' ? -1 : 0;
  return DEGREE[Number(m[2]) - 1] + shift;
}

function bassNumber(bass: string, key: Key): string {
  const pitch = pitchOf(bass);
  return pitch === null ? `/${bass}` : `/${LABEL[(pitch - key.tonic + 12) % 12]}`;
}

function bassName(bass: string, key: Key): string {
  const semis = degreeSemitones(bass);
  if (semis === null) return `/${bass}`;
  const names = key.flats ? FLAT : SHARP;
  return `/${names[(key.tonic + semis + 12) % 12]}`;
}

/** The lane names a set uses for each language. */
const NASH_NAME = 'Nash Chords';
const CHORD_NAME = 'Chords';

export function isNashvilleLane(name: string): boolean {
  return /\bnash(ville)?\b/i.test(name);
}

/**
 * Give a song the chord lane it hasn't got.
 *
 * A set that writes numbers gets names in its own key beside them, and one
 * that writes names gets the numbers — so whichever way the chart was made,
 * both readings are there. Needs the key: without one there is nothing to
 * count from, and a guess would be worse than the gap.
 */
export function deriveChordLanes(lanes: ChartLane[], key: string | null | undefined): ChartLane[] {
  const parsed = parseKey(key);
  if (!parsed) return lanes;

  const chordLanes = lanes.filter((l) => l.kind === 'chords' && l.items.length);
  if (!chordLanes.length) return lanes;

  const hasNash = chordLanes.some((l) => isNashvilleLane(l.name) || looksNashville(l.items));
  const hasNames = chordLanes.some((l) => !isNashvilleLane(l.name) && !looksNashville(l.items));
  if (hasNash && hasNames) return lanes; // the set wrote both itself

  const source = chordLanes[0];
  const toNumbers = hasNames;
  const derived: ChartLane = {
    id: toNumbers ? 'nash-chords' : 'chords-in-key',
    name: toNumbers ? NASH_NAME : CHORD_NAME,
    kind: 'chords',
    items: source.items.map((item) => ({
      bar: item.bar,
      text:
        (toNumbers ? toNashville(item.text, parsed) : fromNashville(item.text, parsed)) ?? item.text,
    })),
  };
  // Ids must stay unique; a set already using ours keeps it.
  if (lanes.some((l) => l.id === derived.id)) return lanes;
  return [...lanes, derived];
}

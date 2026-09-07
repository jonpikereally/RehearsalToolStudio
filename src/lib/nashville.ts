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

export interface KeyChange {
  bar: number;
  key: string;
}

/** The key in force at a bar: the last change at or before it, else the song's own. */
export function keyAt(bar: number, base: string | null | undefined, changes: KeyChange[] = []): string | null {
  let key = base ?? null;
  for (const change of [...changes].sort((a, b) => a.bar - b.bar)) {
    if (change.bar <= bar + 1e-6) key = change.key;
    else break;
  }
  return key;
}

/**
 * A key moved by so many semitones — what `KEY CHANGE +2` means.
 *
 * Spelled the way that key is normally written rather than by whichever list
 * it came out of: two up from C is D, one up is Db and not C#, because a
 * chart in Db is a chart people have seen. A minor key stays minor.
 */
export function transposeKey(key: string, semitones: number): string | null {
  const tonic = pitchOf(key);
  if (tonic === null || !Number.isFinite(semitones)) return null;
  const name = key.trim().replace(/\s+/g, '');
  const minor = /m(in)?$/i.test(name) && !/maj/i.test(name);
  const moved = (((tonic + Math.round(semitones)) % 12) + 12) % 12;
  const flat = FLAT[moved];
  const sharp = SHARP[moved];
  const spelled = FLAT_KEYS.has(minor ? `${flat}m` : flat) || FLAT_KEYS.has(flat) ? flat : sharp;
  return `${spelled}${minor ? 'm' : ''}`;
}

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

/**
 * `1m7/5` → the chord it names in the given key, e.g. `C#m7/G#`.
 *
 * Numbers or numerals: `ii7` is the same chord as `2m7`. A lowercase
 * numeral is a minor chord by the convention that writes them, unless its
 * suffix already says what it is, so `vii°` stays a diminished seventh
 * degree and `ii` becomes `F#m` in E.
 */
export function fromNashville(number: string, key: Key): string | null {
  const text = number.trim();
  if (!text) return null;
  const [head, bass] = splitSlash(text);
  const degree = parseDegree(head);
  if (!degree) return null;

  const names = spellingFor(degree.accidental, key);
  const quality = degree.minorByCase && !/^(m(?!aj)|min|dim|°|ø|o)/.test(degree.suffix) ? 'm' : '';
  const bassPart = bass ? bassName(bass, key) : '';
  return `${names[(key.tonic + degree.semis + 12) % 12]}${quality}${degree.suffix}${bassPart}`;
}

/** Whether a lane's text reads as numbers rather than names. */
export function looksNashville(items: { text: string }[]): boolean {
  const chords = items.filter((i) => i.text.trim());
  if (!chords.length) return false;
  const numbered = chords.filter((i) => degreeSemitones(splitSlash(i.text.trim())[0]) !== null);
  return numbered.length > chords.length / 2;
}

/*
 * The three ways a chart writes a chord. Names say what to play; numbers
 * and numerals say what the chord does, and survive a change of key. The
 * numerals carry the quality in their case — ii for a minor second, V for
 * a major fifth — where the numbers spell it out, 2m and 5.
 */
export type ChordNotation = 'names' | 'numbers' | 'roman';

export const NOTATION_LABEL: Record<ChordNotation, string> = {
  names: 'Classical chord names',
  numbers: 'Nashville numbers',
  roman: 'Roman numerals',
};

/** The lane and track names a set uses for each notation. */
export const NOTATION_LANE: Record<ChordNotation, string> = {
  names: 'Chords',
  numbers: 'Nash Chords',
  roman: 'Roman Chords',
};

const ROMAN_UPPER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** How a chord's suffix says it is minor or diminished, which a numeral says by its case instead. */
const MINOR_SUFFIX = /^(m(?!aj)|min(?!or)?|dim|°|ø|o(?![a-z]))/;

/**
 * `Dm7` in C → `ii7`; `Bb` in C → `bVII`; `Bdim` → `vii°`. The numeral's
 * case carries the quality, so a leading m is taken off; dim and ° stay,
 * as the convention writes them.
 */
export function toRoman(chord: string, key: Key): string | null {
  const text = chord.trim();
  if (!text) return null;
  const [head, bass] = splitSlash(text);
  const root = pitchOf(head);
  if (root === null) return null;
  const suffix = head.replace(NOTE, '');
  const label = LABEL[(root - key.tonic + 12) % 12];
  const accidental = label.startsWith('b') ? 'b' : '';
  const numeral = ROMAN_UPPER[Number(label.replace(/^b/, '')) - 1];
  const minor = MINOR_SUFFIX.test(suffix);
  const rest = minor ? suffix.replace(/^(m(?!aj)|min(?!or)?)/, '') : suffix;
  const bassPart = bass ? bassNumber(bass, key) : '';
  return `${accidental}${minor ? numeral.toLowerCase() : numeral}${rest}${bassPart}`;
}

/** Which notation a lane's text is in, from what most of its chords look like. */
export function notationOf(items: { text: string }[]): ChordNotation {
  const chords = items.map((i) => splitSlash(i.text.trim().replace(/^\[|\]$/g, ''))[0]).filter(Boolean);
  if (!chords.length) return 'names';
  const roman = chords.filter((c) => /^[b#♭♯]?(vii|vi|iv|v|iii|ii|i)(?![a-hj-uw-z])/i.test(c)).length;
  const digits = chords.filter((c) => /^[b#♭♯]?[1-7]/.test(c)).length;
  if (roman > chords.length / 2) return 'roman';
  if (digits > chords.length / 2) return 'numbers';
  return 'names';
}

/** A lane's notation: by its name where the name says, else by its text. */
export function laneNotation(lane: { name: string; items: { text: string }[] }): ChordNotation {
  if (/\broman\b/i.test(lane.name)) return 'roman';
  if (isNashvilleLane(lane.name)) {
    const seen = notationOf(lane.items);
    return seen === 'roman' ? 'roman' : 'numbers';
  }
  return notationOf(lane.items);
}

/** One chord from any notation into another, in the given key. Names are the bridge. */
export function convertChord(chord: string, to: ChordNotation, key: Key): string | null {
  const text = chord.trim();
  if (!text) return null;
  const from = notationOf([{ text }]);
  if (from === to) return text;
  const name = from === 'names' ? text : fromNashville(text, key);
  if (name === null) return null;
  if (to === 'names') return name;
  return to === 'numbers' ? toNashville(name, key) : toRoman(name, key);
}

/* --------------------------------- helpers -------------------------------- */

function splitSlash(text: string): [string, string | null] {
  const at = text.indexOf('/');
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + 1)];
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

/**
 * A scale degree at the head of a chord, written as a number (`b3`, `5`) or
 * a Roman numeral (`bIII`, `V`, `ii`): its distance from the tonic, what
 * follows it, and whether its case said minor.
 */
function parseDegree(text: string): { semis: number; suffix: string; minorByCase: boolean; accidental: number } | null {
  const head = text.trim();
  const accidental = (a: string) => (a === '#' || a === '♯' ? 1 : a === 'b' || a === '♭' ? -1 : 0);
  const digits = /^([b#♭♯]?)([1-7])/.exec(head);
  if (digits) {
    return {
      semis: DEGREE[Number(digits[2]) - 1] + accidental(digits[1]),
      suffix: head.slice(digits[0].length),
      minorByCase: false,
      accidental: accidental(digits[1]),
    };
  }
  // The numeral must end where a letter would not follow it: "vi" is not the start of "vim".
  const roman = /^([b#♭♯]?)(vii|vi|iv|v|iii|ii|i)(?![a-hj-uw-z])/i.exec(head);
  if (!roman) return null;
  const numeral = roman[2];
  return {
    semis: DEGREE[ROMAN[numeral.toLowerCase()] - 1] + accidental(roman[1]),
    suffix: head.slice(roman[0].length),
    minorByCase: numeral === numeral.toLowerCase(),
    accidental: accidental(roman[1]),
  };
}

/**
 * How to spell a degree's note: a flattened degree with flats, a sharpened
 * one with sharps — bVII in C is Bb, not A# — and a plain one as the key.
 */
function spellingFor(accidental: number, key: Key): string[] {
  return accidental < 0 ? FLAT : accidental > 0 ? SHARP : key.flats ? FLAT : SHARP;
}

function degreeSemitones(text: string): number | null {
  return parseDegree(text)?.semis ?? null;
}

function bassNumber(bass: string, key: Key): string {
  const pitch = pitchOf(bass);
  return pitch === null ? `/${bass}` : `/${LABEL[(pitch - key.tonic + 12) % 12]}`;
}

function bassName(bass: string, key: Key): string {
  const degree = parseDegree(bass);
  if (!degree) return `/${bass}`;
  const names = spellingFor(degree.accidental, key);
  return `/${names[(key.tonic + degree.semis + 12) % 12]}`;
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
export function deriveChordLanes(
  lanes: ChartLane[],
  key: string | null | undefined,
  /** Modulations inside the song; each chord is counted in the key at its bar. */
  changes: KeyChange[] = [],
): ChartLane[] {
  const parsed = parseKey(keyAt(1, key, changes));
  if (!parsed) return lanes;
  const keyFor = (bar: number): Key => parseKey(keyAt(bar, key, changes)) ?? parsed;

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
        (toNumbers ? toNashville(item.text, keyFor(item.bar)) : fromNashville(item.text, keyFor(item.bar))) ?? item.text,
    })),
  };
  // Ids must stay unique; a set already using ours keeps it.
  if (lanes.some((l) => l.id === derived.id)) return lanes;
  return [...lanes, derived];
}

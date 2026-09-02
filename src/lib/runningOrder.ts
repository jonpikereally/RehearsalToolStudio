import type { Song } from '../types';

/**
 * A setlist as a running order: how long each song is, and when it starts.
 *
 * A set is a plan with a length, and knowing you're twelve minutes in at song
 * four is the thing you actually want from a setlist on stage. Durations come
 * from songs that have been played at least once, so a fresh library shows what
 * it knows and says so rather than inventing numbers.
 */

export interface RunningEntry {
  song: Song;
  /** Seconds, or null when nothing has played this song yet. */
  durationSec: number | null;
  /** Seconds from the top of the set, or null once anything ahead is unknown. */
  startsAtSec: number | null;
}

export interface RunningOrder {
  entries: RunningEntry[];
  /** Total of the songs whose length is known. */
  knownSec: number;
  /** How many songs have no length yet. */
  unknown: number;
}

export function runningOrder(songs: Song[]): RunningOrder {
  const entries: RunningEntry[] = [];
  let elapsed = 0;
  // Once one song's length is missing, every start time after it is a guess —
  // better to show nothing than a number that is quietly wrong.
  let certain = true;
  let knownSec = 0;
  let unknown = 0;

  for (const song of songs) {
    const durationSec = song.durationSec && song.durationSec > 0 ? song.durationSec : null;
    entries.push({ song, durationSec, startsAtSec: certain ? elapsed : null });

    if (durationSec === null) {
      unknown++;
      certain = false;
      continue;
    }
    knownSec += durationSec;
    elapsed += durationSec;
  }

  return { entries, knownSec, unknown };
}

/** `5:04`, or `1:02:11` for a set long enough to need the hour. */
export function formatClock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

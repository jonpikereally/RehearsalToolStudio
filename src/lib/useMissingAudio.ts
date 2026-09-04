import { useEffect, useState } from 'react';
import { filesReport, nothingToHear } from './songLoader';
import { useStore } from './store';
import type { Song } from '../types';

/**
 * One answer per song per state of the folders, shared by every row that
 * asks. The songs page asks for twenty songs at once and again each time it
 * is shown; the files have not moved in between.
 */
const known = new Map<string, Promise<SongAudio>>();

export interface SongAudio {
  /** Files not there to play: absent, or in a folder the studio may not read. */
  missing: number;
  /**
   * Every musical part is unplayable — opening this would give you a click
   * and nothing else. Different in kind from "some files are missing", and
   * the one worth saying before anybody waits for it to load.
   */
  silent: boolean;
}

/**
 * What a song would actually give you if you opened it.
 *
 * The set's click and cues are not counted either way: they are the set's,
 * not the song's, and a song is neither missing audio nor worth playing on
 * their account. Null until known.
 */
export function useMissingAudio(song: Song): SongAudio | null {
  const { resourcesFolderName, localStatus } = useStore();
  const key = [
    song.id,
    resourcesFolderName ?? '',
    localStatus,
    ...song.variants.map((v) => v.clips?.map((c) => c.path).join('|') ?? v.path),
  ].join('\n');
  const [answer, setAnswer] = useState<SongAudio | null>(null);
  useEffect(() => {
    // No parts at all is its own state, and the rows say so without asking.
    if (!song.variants.length) {
      setAnswer({ missing: 0, silent: false });
      return;
    }
    let live = true;
    let pending = known.get(key);
    if (!pending) {
      pending = filesReport(song, { songOnly: true }).then((r) => ({
        missing: r.missing.length + r.forbidden.length,
        silent: nothingToHear(r),
      }));
      known.set(key, pending);
      pending.catch(() => known.delete(key));
    }
    setAnswer(null);
    pending.then(
      (found) => {
        if (live) setAnswer(found);
      },
      () => {
        // The folder would not answer. Claiming a song is silent on that
        // basis would be worse than saying nothing.
        if (live) setAnswer({ missing: 0, silent: false });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  return answer;
}

import { useEffect, useState } from 'react';
import { filesReport } from './songLoader';
import { useStore } from './store';
import type { Song } from '../types';

/**
 * One answer per song per state of the folders, shared by every row that
 * asks. The songs page asks for twenty songs at once and again each time it
 * is shown; the files have not moved in between.
 */
const known = new Map<string, Promise<number>>();

/**
 * How many of a song's own files are not there to play — not in the folder,
 * or in one the studio may not read. The set's click and cues are not
 * counted: they are the set's, not the song's. Null until known.
 */
export function useMissingAudio(song: Song): number | null {
  const { resourcesFolderName, localStatus } = useStore();
  const key = [
    song.id,
    resourcesFolderName ?? '',
    localStatus,
    ...song.variants.map((v) => v.clips?.map((c) => c.path).join('|') ?? v.path),
  ].join('\n');
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!song.variants.length) {
      setCount(0);
      return;
    }
    let live = true;
    let pending = known.get(key);
    if (!pending) {
      pending = filesReport(song, { songOnly: true }).then((r) => r.missing.length + r.forbidden.length);
      known.set(key, pending);
      pending.catch(() => known.delete(key));
    }
    setCount(null);
    pending.then(
      (n) => {
        if (live) setCount(n);
      },
      () => {
        if (live) setCount(0);
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  return count;
}

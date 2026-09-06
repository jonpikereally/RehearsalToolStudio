import { useEffect, useState } from 'react';
import { parseAls } from './alsParser';
import { preparedNameFor } from './locatePrepared.ts';
import { audioKeysFor, standingFor, titlesOf } from './prepareRun.ts';
import { readBytes } from './source';
import { useStore } from './store';

/**
 * Whether the open set has been prepared into the band's folder, and how
 * far behind that folder now is.
 *
 * The page that offers to prepare a set should not offer to prepare one
 * that already has a folder: the honest offer there is an update, with a
 * word on what it would touch. Worked out the way the auto-update works
 * it out — the set read, a stat per file, the folder recognised by its
 * songs — so the two never disagree about which folder is the set's.
 */
export interface PreparedStanding {
  /** The folder under Sets/ this set fills. */
  folder: string;
  lastPrepared: string | null;
  changed: number;
  fresh: number;
  unchanged: number;
  total: number;
}

export type PreparedLookup =
  | { state: 'idle' }
  | { state: 'looking' }
  | { state: 'none' }
  | { state: 'found'; found: PreparedStanding };

/** `version` changes whenever the answer might have: a save, a prepare finished. */
export function usePreparedStanding(setPath: string | null, version: string): PreparedLookup {
  const { publishFolderName, publishFolder } = useStore();
  const [lookup, setLookup] = useState<PreparedLookup>({ state: 'idle' });

  useEffect(() => {
    setLookup({ state: 'idle' });
    if (!setPath || !publishFolderName) return;
    let live = true;
    setLookup({ state: 'looking' });
    void (async () => {
      try {
        // The band's folder as already granted; never a dialog from an effect.
        const band = await publishFolder();
        if (!band) {
          if (live) setLookup({ state: 'none' });
          return;
        }
        const project = await parseAls((await readBytes(setPath)).bytes);
        const keys = await audioKeysFor(project, setPath);
        const folder = await preparedNameFor(band, setPath, keys.byName);
        const standing = await standingFor(project, setPath, band, folder, keys);
        if (!live) return;
        if (!standing.manifest) {
          setLookup({ state: 'none' });
          return;
        }
        const titles = titlesOf(project);
        const count = (state: string) => titles.filter((t) => standing.standing.get(t)?.state === state).length;
        setLookup({
          state: 'found',
          found: {
            folder,
            lastPrepared: standing.lastPrepared,
            changed: count('changed'),
            fresh: count('new'),
            unchanged: count('unchanged'),
            total: titles.length,
          },
        });
      } catch {
        if (live) setLookup({ state: 'none' });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPath, publishFolderName, version]);

  return lookup;
}

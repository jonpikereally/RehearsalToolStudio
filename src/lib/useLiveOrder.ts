import { useEffect, useState } from 'react';
import type { AlsProject } from './alsParser';
import { liveRunningOrder, runningOrderTitles, type RunningOrder } from './ableset.ts';
import { useStore } from './store';
import { setlistIdFor } from './alsImport.ts';

/**
 * The running order to write, asked for at the moment of preparing.
 *
 * The library's setlist for the set is what the last scan found; AbleSet's
 * order may have moved since, and a prepare is exactly when that matters.
 * So the dialogs ask AbleSet's log afresh, and fall back to the library's
 * setlist — which itself follows AbleSet's saved file — when the log has
 * nothing newer for this set.
 */
export function useLiveOrder(project: AlsProject | null, alsPath: string | null): RunningOrder | null {
  const { library } = useStore();
  const [live, setLive] = useState<RunningOrder | null>(null);
  /** Whether AbleSet has been asked yet, so "none found" is never said before it has. */
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    setLive(null);
    setAsked(false);
    if (!project || !alsPath) return;
    let on = true;
    // The library's setlist was built at the last scan, from the saved file
    // and the log as they were then; only a log line newer than that scan
    // can say anything the library doesn't.
    const setlist = library.setlists.find((sl) => sl.id === setlistIdFor(alsPath));
    void liveRunningOrder(project, alsPath, setlist?.updatedAt ?? null).then((found) => {
      if (!on) return;
      if (found) setLive(found);
      setAsked(true);
    });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, alsPath]);
  if (live) return live;
  if (!alsPath) return null;
  const setlist = library.setlists.find((sl) => sl.id === setlistIdFor(alsPath));
  const titles = runningOrderTitles(library, alsPath);
  if (!titles) return null;
  // The scan notes the order on the set's setlist only when AbleSet decided it.
  if (setlist?.notes) return { titles, note: setlist.notes };
  /*
   * Nothing of AbleSet's, running, logged or saved: the arrangement's order
   * is what gets written. Said, rather than left to be found out from the
   * band's app, and with what would let AbleSet's order be used instead.
   */
  return {
    titles,
    missing: asked,
    note: asked
      ? "No AbleSet order was found for this set, so the songs go in the arrangement's order. To use AbleSet's, " +
        'have AbleSet open on this set (from this same folder) while preparing, or save the setlist in AbleSet and Rescan.'
      : '',
  };
}

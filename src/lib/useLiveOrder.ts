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
  useEffect(() => {
    setLive(null);
    if (!project || !alsPath) return;
    let on = true;
    // The library's setlist was built at the last scan, from the saved file
    // and the log as they were then; only a log line newer than that scan
    // can say anything the library doesn't.
    const setlist = library.setlists.find((sl) => sl.id === setlistIdFor(alsPath));
    void liveRunningOrder(project, alsPath, setlist?.updatedAt ?? null).then((found) => {
      if (on && found) setLive(found);
    });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, alsPath]);
  if (live) return live;
  const titles = alsPath ? runningOrderTitles(library, alsPath) : null;
  return titles ? { titles, note: '' } : null;
}

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { usePreparedStanding } from '../lib/usePreparedStanding';
import { prepareRunning } from '../lib/prepareState';
import PrepareSetDialog from './PrepareSetDialog';

/**
 * Whether the band's folder still matches the set, said where it can be seen.
 *
 * Two separate questions, and two separate jobs. The stems come from the
 * arrangement: move a clip, change a fader, and the songs they belong to want
 * writing again. The submixes come from the stems and follow whoever is in
 * the band: add a member, or change what one of them keeps, and every song
 * wants a file it hasn't got — with every stem in it already right.
 *
 * Each says how many songs are behind and offers to do that job alone. A
 * count that has just gone up flashes, because the answer changes while
 * nobody is looking at it: the studio sits beside Live for hours.
 */
export default function SyncBar() {
  const { currentSet, outputSet, setSaved } = useStore();
  const [running, setRunning] = useState(0);
  const [dialog, setDialog] = useState<{ titles: string[]; only?: 'submixes' } | null>(null);
  const standing = usePreparedStanding(currentSet, `${setSaved?.at ?? ''}|${running}`);

  // A prepare finishing anywhere is a reason to ask again.
  useEffect(() => {
    let was = prepareRunning();
    const timer = window.setInterval(() => {
      const now = prepareRunning();
      if (was && !now) setRunning((n) => n + 1);
      was = now;
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const found = standing.state === 'found' ? standing.found : null;
  const stems = found?.stemsBehind.length ?? 0;
  const submixes = found?.submixesBehind.length ?? 0;

  if (!currentSet || !outputSet || !found) return null;

  return (
    <>
      <div className="syncbar">
        <Chip
          label="Stems"
          count={stems}
          title={stems ? `${found.stemsBehind.slice(0, 6).join(', ')}${stems > 6 ? '…' : ''}` : 'Every song matches the arrangement.'}
          onClick={() => setDialog({ titles: found.stemsBehind })}
        />
        <Chip
          label="Submixes"
          count={submixes}
          title={
            submixes
              ? `${found.whySubmixes ?? 'behind the band'} — ${found.submixesBehind.slice(0, 6).join(', ')}${submixes > 6 ? '…' : ''}`
              : 'Every song has the submixes the band asks for.'
          }
          onClick={() => setDialog({ titles: found.submixesBehind, only: 'submixes' })}
        />
        <span className="syncbar-where">
          against <strong>{outputSet.name}</strong>
        </span>
      </div>
      {dialog && (
        <PrepareSetDialog
          preselect={dialog.titles}
          only={dialog.only}
          onClose={() => {
            setDialog(null);
            setRunning((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

/**
 * One side's standing. It flashes when the number goes up — never when it
 * goes down, since work being done is not news — and says nothing at all
 * loudly when there is nothing to do.
 */
function Chip({ label, count, title, onClick }: { label: string; count: number; title: string; onClick: () => void }) {
  const [flash, setFlash] = useState(false);
  const before = useRef(count);
  useEffect(() => {
    if (count > before.current) {
      setFlash(true);
      const timer = window.setTimeout(() => setFlash(false), 2400);
      before.current = count;
      return () => window.clearTimeout(timer);
    }
    before.current = count;
  }, [count]);

  return (
    <button
      className={`sync-chip${count ? ' behind' : ''}${flash ? ' flash' : ''}`}
      onClick={count ? onClick : undefined}
      disabled={!count}
      title={title}
    >
      <span className="sync-dot" aria-hidden="true" />
      {label}
      <span className="sync-count">{count ? `${count} behind` : 'up to date'}</span>
    </button>
  );
}

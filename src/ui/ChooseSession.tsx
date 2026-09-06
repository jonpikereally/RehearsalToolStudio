import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import * as local from '../lib/localSource';

/**
 * Which Ableton session feeds the chosen set folder.
 *
 * Usually not a question: the folder's manifest remembers the session it was
 * prepared from, and it is opened straight away. It becomes one when the
 * folder is new, or the session has moved or been renamed — then the .als is
 * asked for once, and remembered for next time.
 */
export default function ChooseSession() {
  const { outputSet, chooseOutput, openSession } = useStore();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef<string | null>(null);

  useEffect(() => {
    const remembered = outputSet?.session;
    if (!remembered || tried.current === remembered) return;
    tried.current = remembered;
    setOpening(remembered);
    setError(null);
    void openSession(remembered)
      .catch((err) => setError(`${remembered.split('/').pop()} could not be opened: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setOpening(null));
  }, [outputSet, openSession]);

  const pick = async () => {
    setError(null);
    try {
      const picked = await local.pickFilePath({ description: `the Ableton session that feeds “${outputSet?.name ?? 'this set'}”`, extensions: ['als'] });
      const path = `${picked.dir}/${picked.name}`;
      setOpening(path);
      await openSession(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setOpening(null);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>
          {outputSet?.name ?? 'The set'}
          <span className="sub" style={{ display: 'block' }}>
            which Ableton session feeds it
          </span>
        </h1>
        <button className="btn" onClick={() => chooseOutput(null)} disabled={!!opening}>
          Other set folders
        </button>
      </div>

      {opening && <div className="notice">Opening {opening.split('/').pop()} and reading it…</div>}
      {error && <div className="notice error">{error}</div>}

      {!opening && (
        <div className="empty">
          <h2>{outputSet?.session ? 'The session has moved' : 'No session named yet'}</h2>
          <p>
            {outputSet?.session
              ? `This folder was prepared from ${outputSet.session.split('/').pop()}, which is not where it was. Point at it again, and it is remembered.`
              : 'Choose the .als this folder is prepared from. Its own folder is where the stems are read, and it is remembered for next time.'}
            {' '}You can also drop the .als on this window.
          </p>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => void pick()}>
              Choose the .als…
            </button>
          </div>
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { setToolsAlone } from '../lib/toolsAlone';
import * as local from '../lib/localSource';
import { createOutputSet, outputSets, type OutputSet } from '../lib/locatePrepared';
import { SETS_FOLDER } from '../lib/prints';
import { safeSetName } from '../lib/setName';

/**
 * The first question on opening: which set folder?
 *
 * The studio is about one folder in the band's Dropbox — the prepared set
 * the band plays from — and an Ableton session feeds it. So a launch begins
 * with the folders under Sets/, each saying what it holds and which session
 * fills it, and a way to make a new one. The session comes after, usually
 * without asking, since the folder remembers it.
 */
export default function ChooseOutput() {
  const { publishFolderName, publishFolder, pickPublishFolder, chooseOutput, openSession } = useStore();
  const [sets, setSets] = useState<OutputSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSession, setNewSession] = useState<{ dir: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const band = await publishFolder();
      if (!band) {
        setSets([]);
        return;
      }
      setSets(await outputSets(band));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSets([]);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishFolderName]);

  const pickSession = async () => {
    setError(null);
    try {
      const picked = await local.pickFilePath({ description: 'the Ableton session that feeds this set', extensions: ['als'] });
      setNewSession(picked);
      if (!newName.trim()) setNewName(picked.name.replace(/\.als$/i, ''));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    }
  };

  const create = async () => {
    if (!newSession) return;
    setBusy(true);
    setError(null);
    try {
      const band = (await publishFolder()) ?? (await pickPublishFolder());
      const alsPath = `${newSession.dir}/${newSession.name}`;
      const made = await createOutputSet(band, newName, alsPath);
      chooseOutput({ ...made, session: alsPath });
      await openSession(alsPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const when = (iso?: string) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  };

  return (
    <>
      <div className="topbar">
        <h1>
          Choose a set folder
          <span className="sub" style={{ display: 'block' }}>
            {publishFolderName ? `under ${SETS_FOLDER}/ in “${publishFolderName}”` : 'the band’s folder is not chosen yet'}
          </span>
        </h1>
        <button className="icon-btn" onClick={() => void load()} disabled={sets === null} title="Look again">
          ⟳
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="panel btn-row" style={{ alignItems: 'center' }}>
        <button className={making ? 'btn' : 'btn primary'} onClick={() => setMaking((m) => !m)} disabled={busy}>
          {making ? 'Cancel' : 'New set folder…'}
        </button>
        <button
          className="btn"
          onClick={() => {
            setToolsAlone(true);
            navigate('/tools');
          }}
        >
          Skip — open the set tools without a set
        </button>
        <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          A folder the band opens on their phones, filled from one Ableton session.
        </span>
      </div>

      {making && (
        <div className="panel">
          <div className="field stacked">
            <label htmlFor="new-set-session">
              The Ableton session
              <span className="hint">The .als this folder is prepared from. Its own folder is where the stems are read.</span>
            </label>
            <div className="btn-row">
              <span className="code">{newSession ? newSession.name : 'not chosen yet'}</span>
              <button id="new-set-session" className="btn" onClick={() => void pickSession()} disabled={busy}>
                {newSession ? 'Change…' : 'Choose the .als…'}
              </button>
            </div>
          </div>
          <div className="field stacked">
            <label htmlFor="new-set-name">
              Call the folder
              <span className="hint">What the band sees the set called. Under {SETS_FOLDER}/ in their folder.</span>
            </label>
            <div className="btn-row">
              <input
                id="new-set-name"
                className="text-input"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={busy}
                placeholder="Friday at the Dock"
                style={{ minWidth: 280 }}
              />
              <button className="btn primary" onClick={() => void create()} disabled={busy || !newSession || !safeSetName(newName)}>
                {busy ? 'Making it…' : 'Make the folder and open it'}
              </button>
            </div>
          </div>
        </div>
      )}

      {sets === null && <div className="notice">Looking in the band’s folder…</div>}
      {sets && !sets.length && !making && (
        <div className="empty">
          <h2>No set folders yet</h2>
          <p>Make one, name it, and point it at the Ableton session it is prepared from.</p>
        </div>
      )}

      {sets?.map((set) => (
        <button key={set.folder} className="row" onClick={() => chooseOutput(set)}>
          <div className="row-main">
            <div className="row-title">{set.name}</div>
            <div className="row-sub">
              {set.songs ? `${set.songs} song${set.songs === 1 ? '' : 's'}` : 'nothing prepared yet'}
              {when(set.preparedAt) ? ` · prepared ${when(set.preparedAt)}` : ''}
              {set.session ? ` · from ${set.session.split('/').pop()}` : ' · no session named yet'}
            </div>
          </div>
          <div className="row-right">›</div>
        </button>
      ))}

      <div style={{ height: 24 }} />
    </>
  );
}

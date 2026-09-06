import { useState } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { APP_NAME } from '../lib/appMode';

/**
 * The studio's first run: point it at the band's folder.
 *
 * Everything the studio makes goes into that folder — a Dropbox app folder
 * the band's phones read — and every launch begins by choosing a set folder
 * inside it. The Ableton sessions come after, one per set folder, wherever
 * they live: their own folders are read when they are opened.
 */
export default function Onboarding() {
  const { pickPublishFolder } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker has to be opened by the click itself, so this can't be moved behind an await.
  const chooseFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      await pickPublishFolder();
    } catch (err) {
      // Closing the picker isn't a failure, so don't shout about it.
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>{APP_NAME}</h1>
      </div>

      <div className="empty">
        <h2>Where is the band's folder?</h2>
        <p>The Rehearsal Tool folder in Dropbox: the one the band's phones read, and the one every prepared set goes into.</p>
      </div>

      <div className="source-choices">
        <div className="source-card">
          <h3>The band's folder</h3>
          <p>
            Chosen once and remembered. Each set folder inside it is prepared from an Ableton session, which you point
            at when you open the folder.
          </p>
          {error && <div className="notice error">{error}</div>}
          <button className="btn primary" onClick={() => void chooseFolder()} disabled={busy}>
            {busy ? 'Choosing…' : "Choose the band's folder"}
          </button>
        </div>
      </div>

      <div className="controls">
        <button className="chip" onClick={() => navigate('/settings')}>
          Settings
        </button>
      </div>
    </>
  );
}

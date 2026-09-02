import { useState } from 'react';
import { useStore } from '../lib/store';
import { navigate } from '../lib/router';
import { APP_NAME } from '../lib/appMode';

/**
 * The studio's first run: point it at the folder the sets are in.
 *
 * One way in, so there is no choice to make. It used to offer Dropbox as well,
 * back when one build served both the band and the workshop — the band signs
 * in to Rehearsal Tool now, and the studio reads a folder on the machine it is
 * running on, which is the machine the Ableton sets are on.
 */
export default function Onboarding() {
  const { pickLocalFolder, rescan } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The picker has to be opened by the click itself, so this can't be moved
   * behind an await. Scanning straight afterwards means the songs are simply
   * there, rather than leaving a chosen folder and an empty library.
   */
  const chooseFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      await pickLocalFolder();
      await rescan();
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
        <h2>Where are your sets?</h2>
        <p>
          Point this at the folder your Ableton sets and their stems live in.
        </p>
      </div>

      <div className="source-choices">
        <div className="source-card">
          <h3>A folder on this computer</h3>
          <p>
            Read straight off this machine — nothing to download, big WAV stems open instantly,
            and writing back is just writing a file.
          </p>
          {error && <div className="notice error">{error}</div>}
          <button className="btn primary" onClick={() => void chooseFolder()} disabled={busy}>
            {busy ? 'Scanning…' : 'Choose a folder'}
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

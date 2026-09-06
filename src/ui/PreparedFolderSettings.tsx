import { useState } from 'react';
import { useStore } from '../lib/store';
import * as local from '../lib/localSource';
import { SETS_FOLDER } from '../lib/prints';
import SettingsSection from './SettingsSection';

/**
 * The set folder the studio is about, and the session that feeds it.
 *
 * Both were chosen at launch; this is where they are shown together, where
 * the folder can be revealed in the Finder, and where the session can be
 * pointed at again — after a rename, or a move to another machine — without
 * going back through the launch screens.
 */
export default function PreparedFolderSettings() {
  const { outputSet, chooseOutput, chooseSet, openSession, publishFolder, pickPublishFolder, sessionPath } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  const changeSession = () =>
    run(async () => {
      const picked = await local.pickFilePath({ description: `the Ableton session that feeds “${outputSet?.name ?? 'this set'}”`, extensions: ['als'] });
      await openSession(`${picked.dir}/${picked.name}`);
    });

  const reveal = () =>
    run(async () => {
      if (!outputSet) return;
      const band = (await publishFolder()) ?? (await pickPublishFolder());
      await local.reveal(band, '', outputSet.folder);
    });

  if (!outputSet) return null;

  return (
    <SettingsSection id="prepare" title="The set" summary={`${SETS_FOLDER}/${outputSet.name}${sessionPath ? ` ← ${sessionPath.split('/').pop()}` : ''}`}>
      <div className="field">
        <label>
          Set folder
          <span className="hint">The folder under {SETS_FOLDER}/ in the band's folder that this studio is about. Chosen at launch.</span>
        </label>
        <div className="btn-row">
          <span className="code">{`${SETS_FOLDER}/${outputSet.name}`}</span>
          <button className="btn" onClick={() => void reveal()} disabled={busy}>
            Show in Finder
          </button>
          <button
            className="btn"
            onClick={() => {
              chooseSet(null);
              chooseOutput(null);
            }}
            disabled={busy}
          >
            Choose another…
          </button>
        </div>
      </div>
      <div className="field">
        <label>
          Ableton session
          <span className="hint">
            The .als the folder is prepared from; its own folder is where the stems are read. Remembered in the set's
            manifest, so the folder knows it on the next launch.
          </span>
        </label>
        <div className="btn-row">
          <span className="code">{sessionPath ?? 'not chosen yet'}</span>
          <button className="btn" onClick={() => void changeSession()} disabled={busy}>
            {sessionPath ? 'Change…' : 'Choose the .als…'}
          </button>
        </div>
        {error && <div className="notice error">{error}</div>}
      </div>
    </SettingsSection>
  );
}

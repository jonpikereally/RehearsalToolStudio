import { useState } from 'react';
import { useStore } from '../lib/store';
import * as local from '../lib/localSource';
import { SETS_FOLDER } from '../lib/prints';
import { alwaysOpen, askForFiles, setAlwaysOpen } from '../lib/recent';
import { showChooser } from '../lib/appWindow';
import { navigate } from '../lib/router';
import SettingsSection from './SettingsSection';

/**
 * What is open: the session that comes in, and the set folder it fills.
 *
 * Both are chosen in the Open window, so this doesn't ask again — it shows
 * the pair, puts each of them in the Finder, and opens the chooser for a
 * change of either. It used to be two panels asking the same two questions a
 * second time, with a folder to point at, a switch to read from it and a menu
 * of the .als files beside it, none of which is a choice any more: the
 * session decides its folder, and opening one is what turns reading on.
 */
export default function OpenSettings() {
  const {
    outputSet, chooseOutput, chooseSet, sessionPath, localFolderName, localStatus,
    rescan, scanning, scanProgress, publishFolder, pickPublishFolder,
    resourceFolders, pickResourcesFolder, forgetResourceFolder,
  } = useStore();
  const [always, setAlways] = useState(alwaysOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Closing a picker isn't a failure, so don't shout about it.
      if (!/abort/i.test(message)) setError(message);
    } finally {
      setBusy(false);
    }
  };

  /** The chooser: its own window in the Mac app, this page in a browser. */
  const open = () => {
    askForFiles();
    if (showChooser()) return;
    chooseSet(null);
    chooseOutput(null);
    navigate('/');
  };

  const showSession = () =>
    run(async () => {
      const folder = await local.storedFolder('songs');
      if (folder) await local.reveal(folder.handle, '', sessionPath?.split('/').pop() ?? '.');
    });

  const showFolder = () =>
    run(async () => {
      if (!outputSet) return;
      const band = (await publishFolder()) ?? (await pickPublishFolder());
      await local.reveal(band, '', outputSet.folder);
    });

  const reading = localStatus === 'ready';
  const summary = outputSet ? (
    <>
      <span className={reading ? 'badge ok' : 'badge warn'}>{reading ? 'open' : 'not reading'}</span>
      {sessionPath ? `${sessionPath.split('/').pop()} → ${outputSet.name}` : outputSet.name}
    </>
  ) : (
    <>
      <span className="badge warn">nothing open</span>choose a session and a folder
    </>
  );

  return (
    <SettingsSection id="open" title="What’s open" summary={summary} defaultOpen>
      <div className="field">
        <label>
          <span className="launch-step">Input</span> Ableton session
          <span className="hint">
            {localFolderName
              ? `Read straight off “${localFolderName}”, the session's own folder, where its stems are — and copies the tools make are written back beside it.`
              : 'No session open yet.'}
          </span>
        </label>
        <div className="btn-row">
          <span className="code">{sessionPath ?? 'none'}</span>
          <button className="btn" onClick={() => void showSession()} disabled={busy || !sessionPath}>
            Show in Finder
          </button>
        </div>
      </div>

      <div className="field">
        <label>
          <span className="launch-step">Output</span> Set folder
          <span className="hint">The folder under {SETS_FOLDER}/ in the band's folder that everything prepared goes into.</span>
        </label>
        <div className="btn-row">
          <span className="code">{outputSet ? `${SETS_FOLDER}/${outputSet.name}` : 'none'}</span>
          <button className="btn" onClick={() => void showFolder()} disabled={busy || !outputSet}>
            Show in Finder
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="btn-row">
        <button className="btn primary" onClick={open} disabled={busy}>
          Open another… <span className="key-hint">⌘O</span>
        </button>
        <button className="btn" onClick={() => void rescan()} disabled={!reading || scanning}>
          {scanning ? scanProgress || 'Scanning…' : 'Read the session again'}
        </button>
      </div>
      <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
        Reading it again opens the set from disk and drops a song whose files have gone.
      </div>

      <div className="field stacked">
        <label>
          Opening the studio
          <span className="hint">With both on, a launch goes straight to the tabs. File ▸ Open (⌘O) always asks.</span>
        </label>
        <label className="switch-row">
          <input type="checkbox" checked={always.session} onChange={(e) => setAlways(setAlwaysOpen({ session: e.target.checked }))} />
          <span>Always open the most recent Ableton session</span>
        </label>
        <label className="switch-row">
          <input type="checkbox" checked={always.output} onChange={(e) => setAlways(setAlwaysOpen({ output: e.target.checked }))} />
          <span>Always open the most recent set folder</span>
        </label>
      </div>

      {/*
        Samples can be in more than one place — a click library, last year's
        session, a folder of one-shots — so this is a list rather than one
        folder, and allowing another leaves the rest allowed.
      */}
      <div className="field stacked">
        <label>
          Samples elsewhere
          <span className="hint">
            Folders a set's click or cue samples live in outside the project. Read only, never written.
          </span>
        </label>
        {resourceFolders.map((folder) => (
          <div key={folder.dir} className="btn-row">
            <span className="code" title={folder.dir}>
              {folder.name}
            </span>
            <button
              className="btn"
              onClick={() => void run(() => forgetResourceFolder(folder.dir))}
              disabled={busy}
              title={`Stop reading samples from ${folder.dir}`}
            >
              Forget
            </button>
          </div>
        ))}
        <div className="btn-row">
          {!resourceFolders.length && <span className="code">none allowed</span>}
          <button className="btn" onClick={() => void run(() => pickResourcesFolder())} disabled={busy}>
            {resourceFolders.length ? 'Allow another folder…' : 'Allow a folder…'}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}

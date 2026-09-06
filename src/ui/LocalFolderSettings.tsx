import { useState } from 'react';
import { useStore } from '../lib/store';
import SettingsSection from './SettingsSection';

/**
 * The folder on this machine, which is the whole of where songs come from.
 *
 * Chosen once and remembered by the studio's server, so it is there on every
 * launch with nothing to allow again. Everything is read from here and
 * written back here.
 */
export default function LocalFolderSettings() {
  const {
    settings, saveSettings, rescan, scanning, scanProgress,
    localStatus, localFolderName, pickLocalFolder, forgetLocalFolder,
    resourcesFolderName, pickResourcesFolder, alsFiles, currentSet, chooseSessionFile,
  } = useStore();

  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      // Closing the picker isn't a failure, so don't shout about it.
      if (!/abort/i.test(err?.message ?? '')) setError(err?.message ?? String(err));
    }
  };

  const ready = localStatus === 'ready';
  const on = settings.useLocal && ready;

  const summary = !localFolderName ? (
    <>
      <span className="badge warn">off</span>no folder chosen
    </>
  ) : (
    <>
      <span className={on ? 'badge ok' : 'badge'}>{on ? 'reading' : 'not reading'}</span>
      {localFolderName}
    </>
  );

  return (
    <SettingsSection id="local" title="The session's folder" summary={summary} defaultOpen>
      <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
        {ready
          ? `Reading “${localFolderName}” straight off disk — the folder of the session that feeds the set, where its stems are — and writing copies back beside it.`
          : 'The folder of the Ableton session, once one is opened.'}
      </div>

      {error && <div className="notice error">{error}</div>}

      {localFolderName && (
        <div className="field">
          <label htmlFor="local-use">
            Read songs from this folder
            <span className="hint">Everything is read from here and written back here — nowhere else.</span>
          </label>
          <input
            id="local-use"
            type="checkbox"
            checked={settings.useLocal}
            onChange={(e) => saveSettings({ useLocal: e.target.checked })}
            style={{ width: 24, height: 24 }}
          />
        </div>
      )}

      {/*
        Which set in the folder the studio is about. The chooser asks on
        launch; this is the same choice from here, for a folder that holds
        several sets, without going back through it.
      */}
      {on && alsFiles.length > 0 && (
        <div className="field">
          <label htmlFor="open-set">
            Session open in the studio
            <span className="hint">
              {alsFiles.length === 1
                ? 'The one .als in this folder.'
                : `Which of the ${alsFiles.length} .als files in this folder is read as the set — an older save, say.`}
            </span>
          </label>
          <select
            id="open-set"
            className="jump-select"
            value={currentSet ?? ''}
            onChange={(e) => e.target.value && void run(() => chooseSessionFile(e.target.value))}
            style={{ maxWidth: 360 }}
          >
            {!currentSet && <option value="">Choose a session…</option>}
            {alsFiles.map((path) => (
              <option key={path} value={path}>
                {path.replace(/^\//, '')}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="btn-row">
        <button className={localFolderName ? 'btn' : 'btn primary'} onClick={() => void run(pickLocalFolder)}>
          {localFolderName ? 'Change folder' : 'Choose a folder'}
        </button>
        <button className="btn primary" onClick={() => void rescan()} disabled={!on || scanning}>
          {scanning ? scanProgress || 'Scanning…' : 'Rescan'}
        </button>
        {localFolderName && (
          <button className="btn danger" onClick={() => void run(forgetLocalFolder)}>
            Forget
          </button>
        )}
      </div>
      <div style={{ color: '#6b7789', fontSize: 12.5 }}>
        A rescan opens every set in the folder and drops a song whose files have gone.
      </div>

      <div className="field">
        <label>
          Samples elsewhere
          <span className="hint">
            A folder a set's click or cue samples live in outside the project. Read only, never written.
          </span>
        </label>
        <div className="btn-row">
          <span className="code">{resourcesFolderName ?? 'none allowed'}</span>
          <button className="btn" onClick={() => void run(() => pickResourcesFolder())}>
            {resourcesFolderName ? 'Change' : 'Allow a folder'}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}

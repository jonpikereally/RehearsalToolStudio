import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { cacheStats, clearCache, clearLocalDuplicates, type CacheStats } from '../lib/idb';
import { isLocal } from '../lib/source';
import { formatBytes } from '../lib/songLoader';
import LocalFolderSettings from './LocalFolderSettings';
import CueSettings from './CueSettings';
import MidiSettings from './MidiSettings';
import SettingsSection from './SettingsSection';
import OutputDevice from './OutputDevice';

/**
 * `onClose` is passed when Settings is opened over the player rather than as a
 * tab. It stays a panel on top in that case so the song keeps playing — routing
 * away would unmount the player and tear the audio graph down with it.
 */
export default function SettingsView({ onClose }: { onClose?: () => void } = {}) {
  const { settings, saveSettings, localStatus } = useStore();

  const [stats, setStats] = useState<CacheStats | null>(null);
  /*
   * The output device's rate, which is what the engine runs at. Read from a
   * context of its own and closed again: the player's is made on the first
   * tap, and may not exist yet.
   */
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  useEffect(() => {
    try {
      const Ctor: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      const ctx = new Ctor();
      setSampleRate(ctx.sampleRate);
      void ctx.close();
    } catch {
      setSampleRate(null);
    }
  }, []);
  const [tidied, setTidied] = useState<string | null>(null);

  /** Whether the duplicate-tidying below has anything to talk about. */
  const readingLocally = localStatus === 'ready';

  /** Reading the cache can fail on a locked-down browser; that isn't an error. */
  const refreshStats = () => void cacheStats().then(setStats).catch(() => {});
  useEffect(refreshStats, []);

  return (
    <>
      <div className="topbar">
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Back to the song">
            ‹
          </button>
        )}
        <h1>Settings</h1>
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        )}
      </div>

      <LocalFolderSettings />

      <CueSettings />

      <MidiSettings />

      {/* ------------------------------ transport ------------------------------ */}
      <SettingsSection
        id="playback"
        title="Playback"
        summary={`Jumps ${settings.jumpSizes.join(', ')}`}
      >
        <div className="field">
          <label htmlFor="jumps">
            Jump sizes
            <span className="hint">Bar amounts offered in the transport.</span>
          </label>
          <input
            id="jumps"
            type="text"
            value={settings.jumpSizes.join(', ')}
            onChange={(e) => {
              const sizes = e.target.value
                .split(',')
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => Number.isFinite(n) && n > 0);
              saveSettings({ jumpSizes: sizes.length ? sizes : [1, 4, 8, 16] });
            }}
          />
        </div>
      </SettingsSection>

      {/* ------------------------------ this device ----------------------------- */}
      {/*
        How the machine behaves while the app is open, rather than anything
        about the music. Its own panel because it is a different question: the
        answer on a phone propped on a music stand is not the answer on a laptop.
      */}
      <SettingsSection
        id="device"
        title="Device settings"
        summary={`${settings.outputDevice ? `out: ${settings.outputDevice.label}` : 'system output'} · ${settings.keepAwake ? 'screen stays awake' : 'screen may sleep'}`}
      >
        <div className="field">
          <label htmlFor="awake">
            Keep screen awake
            <span className="hint">Stops the phone sleeping mid-song.</span>
          </label>
          <input
            id="awake"
            type="checkbox"
            checked={settings.keepAwake}
            onChange={(e) => saveSettings({ keepAwake: e.target.checked })}
            style={{ width: 24, height: 24 }}
          />
        </div>

        <OutputDevice />

        <div className="field">
          <label>
            Audio engine
            <span className="hint">
              The rate of the Mac's output device, which the audio engine runs at. Every file is
              resampled to it as it is decoded — a 44.1 kHz stem plays fine at 48.
            </span>
          </label>
          <span className="code">{sampleRate ? `${sampleRate.toLocaleString()} Hz` : 'unknown'}</span>
        </div>
      </SettingsSection>

      {/* -------------------------------- storage ------------------------------- */}
      <SettingsSection
        id="storage"
        title="Offline storage"
        summary={
          stats
            ? `${formatBytes(stats.fileBytes + stats.renderBytes)} held · ${settings.cacheBudgetGB} GB render limit`
            : `${settings.cacheBudgetGB} GB render limit`
        }
      >
        {stats && (
          <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
            {stats.fileCount} audio file{stats.fileCount === 1 ? '' : 's'} ({formatBytes(stats.fileBytes)})
            <br />
            {stats.renderCount} transposed render{stats.renderCount === 1 ? '' : 's'} ({formatBytes(stats.renderBytes)})
          </div>
        )}
        <div className="field">
          <label htmlFor="budget">
            Render cache limit
            <span className="hint">Oldest transposed renders are dropped past this.</span>
          </label>
          <input
            id="budget"
            type="number"
            min={0.1}
            step={0.5}
            value={settings.cacheBudgetGB}
            onChange={(e) => saveSettings({ cacheBudgetGB: Math.max(0.1, Number(e.target.value) || 1) })}
          />
          <span style={{ color: 'var(--text-dim)' }}>GB</span>
        </div>
        <div className="field">
          <label htmlFor="run-memory">
            Songs held ready
            <span className="hint">
              Memory for the songs of a run, which are kept decoded so stepping between them is
              instant. Past this the ones least recently played are let go.
            </span>
          </label>
          <input
            id="run-memory"
            type="number"
            min={1}
            step={1}
            value={settings.runMemoryGB}
            onChange={(e) => saveSettings({ runMemoryGB: Math.max(1, Number(e.target.value) || 4) })}
          />
          <span style={{ color: 'var(--text-dim)' }}>GB</span>
        </div>

        {tidied && <div className="notice">{tidied}</div>}

        {readingLocally && settings.useLocal && (
          <div style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>
            Files read from your folder aren't cached — they're already here. Anything cached
            before that rule existed is a duplicate and safe to drop.
          </div>
        )}

        <div className="btn-row">
          {readingLocally && settings.useLocal && (
            <button
              className="btn"
              onClick={async () => {
                const { removed, bytes } = await clearLocalDuplicates(isLocal);
                setTidied(
                  removed
                    ? `Dropped ${removed} cached cop${removed === 1 ? 'y' : 'ies'} of files already in your folder — ${formatBytes(bytes)} back.`
                    : 'Nothing to drop: no cached file is in your folder.',
                );
                refreshStats();
              }}
            >
              Drop duplicates of my folder
            </button>
          )}
          <button
            className="btn"
            onClick={async () => {
              await clearCache('renders');
              refreshStats();
            }}
          >
            Clear renders
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (!window.confirm('Delete all cached audio? Songs will re-download when next opened.')) return;
              await clearCache('all');
              refreshStats();
            }}
          >
            Clear all audio
          </button>
        </div>
      </SettingsSection>

      <div style={{ padding: 16, color: '#6b7789', fontSize: 12 }}>
        Pitch shifting by SoundTouchJS (LGPL-2.1).
        <br />
        {/* So "is the fix live yet?" is something the app can answer — which, and when. */}
        Build <span className="code">{__BUILD__}</span>, published{' '}
        {new Date(__BUILT_AT__).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { statFile } from '../lib/source';
import * as local from '../lib/localSource';
import SettingsSection from './SettingsSection';

/**
 * Timed lyric clips for a set, via Lyrics Studio.
 *
 * Lyrics Studio is its own tool — it transcribes a set's vocal track on this
 * machine and writes the words back as named MIDI clips, tempo map and all.
 * Studio doesn't repeat any of that; it hands the set over. The hand-off is a
 * URL naming the file by name, size and date, which is how Lyrics Studio finds
 * a browser-held file on the real disk.
 */
export const LYRICS_STUDIO = 'http://127.0.0.1:8765';

export default function LyricClipsPanel() {
  const { lastScan } = useStore();
  const [running, setRunning] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checked = useRef(false);

  const scanPath = lastScan?.alsSetPaths?.[0] ?? null;
  const scanName = scanPath?.split('/').pop()?.replace(/\.als$/i, '') ?? null;

  const check = async () => {
    try {
      const res = await fetch(`${LYRICS_STUDIO}/api/version`, { signal: AbortSignal.timeout(2000) });
      setRunning(res.ok);
    } catch {
      setRunning(false);
    }
  };
  useEffect(() => {
    if (!checked.current) {
      checked.current = true;
      void check();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openWith = (file: { name: string; size: number; modified: number }) => {
    const query = new URLSearchParams({
      als_name: file.name,
      als_size: String(file.size),
      als_mtime: String(file.modified),
    });
    window.open(`${LYRICS_STUDIO}/?${query}`, '_blank');
  };

  const sendScanned = async () => {
    if (!scanPath) return;
    setError(null);
    try {
      openWith(await statFile(scanPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickFile = async () => {
    setError(null);
    try {
      const file = await local.pickFile({ description: 'an Ableton Live set', extensions: ['als'] });
      openWith({ name: file.name, size: file.size, modified: file.modified });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    }
  };

  return (
    <SettingsSection
      id="lyrics"
      title="Lyric clips"
      summary={running ? 'Lyrics Studio is running' : 'timed lyrics into the set'}
    >
      <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
        Opens the set in Lyrics Studio, which listens to a vocal track and writes the words back
        into the .als as timed MIDI clips — the lyric lanes this app then shows. All on this Mac.
      </div>

      {running === false && (
        <div className="notice">
          Lyrics Studio isn't running. Double-click{' '}
          <span className="code">Start Lyrics Studio.command</span> in its folder, then:
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => void check()}>
              Look again
            </button>
          </div>
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      <div className="btn-row">
        {scanPath && (
          <button className="btn primary" disabled={!running} onClick={() => void sendScanned()}>
            Open {scanName} in Lyrics Studio
          </button>
        )}
        <button className="btn" disabled={!running} onClick={() => void pickFile()}>
          Choose a .als…
        </button>
      </div>
      <div style={{ color: '#6b7789', fontSize: 12.5 }}>
        Save and close the set in Live first — Lyrics Studio writes to the .als itself, keeping a
        backup beside it.
      </div>
    </SettingsSection>
  );
}

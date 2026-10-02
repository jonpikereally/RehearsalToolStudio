import { useEffect, useRef, useState } from 'react';
import { ensureLyricsStudio } from '../lib/lyricsStudio';

/**
 * Lyrics Studio, as a page of the studio.
 *
 * The listening is Whisper, in Python, so it still runs as a server of its
 * own — but it is the studio that starts it, and its page is shown here, in
 * the studio's window, rather than as an app and a browser tab of its own.
 * The studio's server passes `/lyrics-studio/` through to it, so the page
 * shares the studio's origin and every request it makes comes back that way.
 *
 * Held once opened, hidden while another tab is up, so a queue of songs
 * being transcribed survives a look at the setlist. A set handed over from
 * the Set tools (`als_name` and friends) opens the page afresh on that set.
 */
export default function LyricsStudioView({ shown, handoff }: { shown: boolean; handoff: string }) {
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState('Finding Lyrics Studio…');
  const [error, setError] = useState<string | null>(null);
  const [src, setSrc] = useState('./lyrics-studio/');
  const applied = useRef('');
  const starting = useRef(false);

  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    setError(null);
    setNote('Finding Lyrics Studio…');
    try {
      await ensureLyricsStudio((n) => setNote(n));
      setReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      starting.current = false;
    }
  };

  useEffect(() => {
    void start();
  }, []);

  useEffect(() => {
    if (!handoff || handoff === applied.current) return;
    applied.current = handoff;
    setSrc(`./lyrics-studio/?${handoff}`);
  }, [handoff]);

  return (
    <div className="lyrics-shell" style={{ display: shown ? 'flex' : 'none' }}>
      {ready ? (
        <iframe key={src} className="lyrics-frame" src={src} title="Lyrics Studio" />
      ) : error ? (
        <div className="launch-busy">
          <h2>Lyrics Studio didn't start</h2>
          <div className="notice error">{error}</div>
          <button className="btn primary" onClick={() => void start()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="launch-busy">
          <h2>Lyrics Studio</h2>
          <p>{note}</p>
        </div>
      )}
    </div>
  );
}

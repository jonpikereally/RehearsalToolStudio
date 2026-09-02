import { useEffect, useMemo, useState } from 'react';
import type { Song } from '../types';
import { LTC_SAMPLE_RATE, formatTimecode, ltcTimeAt, renderLtc, type LtcFrameRate } from '../lib/ltc';
import { encodeWav } from '../lib/bounce';
import { formatBytes } from '../lib/songLoader';
import { writeFile } from '../lib/source';
import { printFolder } from '../lib/prints';
import { useStore } from '../lib/store';

/**
 * Writing a timecode track for the song.
 *
 * Everything else in the app points inward, at learning the material. This is
 * the one thing that points out at a rig: hand the file to playback and it can
 * chase the song rather than someone counting it in.
 */
const RATES: LtcFrameRate[] = [24, 25, 30];

export default function TimecodeDialog({
  song,
  durationSec,
  onClose,
}: {
  song: Song;
  durationSec: number;
  onClose: () => void;
}) {
  const { settings, rescan } = useStore();
  const [fps, setFps] = useState<LtcFrameRate>(25);
  const [startHour, setStartHour] = useState(1);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const seconds = durationSec > 0 ? durationSec : 0;
  const startFrame = startHour * 3600 * fps;
  const from = useMemo(() => formatTimecode(ltcTimeAt(startFrame, fps)), [startFrame, fps]);
  const to = useMemo(
    () => formatTimecode(ltcTimeAt(startFrame + Math.round(seconds * fps), fps)),
    [startFrame, fps, seconds],
  );
  const bytes = Math.round(seconds * LTC_SAMPLE_RATE * 2) + 44;
  const fileName = `${song.title} [timecode ${fps}fps].wav`;

  const make = async (): Promise<Blob> => {
    const samples = renderLtc(seconds, fps, LTC_SAMPLE_RATE, startFrame);
    const ctx = new OfflineAudioContext(1, samples.length, LTC_SAMPLE_RATE);
    const buffer = ctx.createBuffer(1, samples.length, LTC_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    // WAV, not MP3: timecode is square edges, and any lossy encoder would
    // round exactly the thing a receiver is looking for.
    return encodeWav(buffer);
  };

  const save = async (share: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const blob = await make();
      if (share) {
        const at = await writeFile(`${printFolder(settings.root, 'Timecode')}/${fileName}`, blob);
        setDone(`Saved to ${at}.`);
        void rescan().catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        setDone(`Downloaded ${fileName}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Write a timecode track"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="spread">
          <h3>Timecode</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {seconds <= 0 ? (
          <p className="dialog-note">
            This song hasn't been played on this device yet, so its length isn't known. Play it once
            and come back.
          </p>
        ) : (
          <>
            <p className="dialog-note">
              An LTC track the length of {song.title}, for a rig to chase. Runs{' '}
              <span className="mono">{from}</span> to <span className="mono">{to}</span>.
            </p>

            <div className="controls flush">
              <span className="control-label">Rate</span>
              <div className="segmented" role="radiogroup" aria-label="Frames per second">
                {RATES.map((rate) => (
                  <button
                    key={rate}
                    role="radio"
                    aria-checked={fps === rate}
                    className={fps === rate ? 'seg on' : 'seg'}
                    onClick={() => setFps(rate)}
                  >
                    {rate}
                  </button>
                ))}
              </div>
            </div>

            <div className="controls flush">
              <span className="control-label">Starts at</span>
              <select
                value={startHour}
                onChange={(e) => setStartHour(Number(e.target.value))}
                aria-label="Start hour"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00:00:00
                  </option>
                ))}
              </select>
              <span className="control-note">an hour per song is the usual convention</span>
            </div>

            <p className="dialog-note">
              Written at 48 kHz as <span className="code">{fileName}</span> — about{' '}
              {formatBytes(bytes)}. Timecode is square edges, so it stays uncompressed: a lossy
              encoder would round off exactly what a receiver is listening for.
            </p>
          </>
        )}

        {error && <div className="notice error">{error}</div>}
        {done && <div className="notice">{done}</div>}

        <div className="btn-row">
          <button className="btn primary" disabled={busy || seconds <= 0} onClick={() => void save(false)}>
            {busy ? 'Writing…' : 'Download'}
          </button>
          <button className="btn" disabled={busy || seconds <= 0} onClick={() => void save(true)}>
            Save to library
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

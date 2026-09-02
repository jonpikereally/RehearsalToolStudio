import { useEffect, useState } from 'react';
import type { Song } from '../types';
import { hasTempoChanges } from '../lib/bars';

/**
 * Changing playback speed, which means re-rendering every part.
 *
 * The stretch is one ratio applied to the whole song, so a tempo map keeps its
 * shape — a song stepping 136→140 still steps, both numbers moving together.
 * That's also why a song with a map is asked for a percentage rather than a
 * BPM: there is no single tempo to type.
 */

const round = (n: number) => Math.round(n * 10) / 10;

export default function TempoDialog({
  song,
  onCancel,
  onSubmit,
}: {
  song: Song;
  onCancel: () => void;
  /** The new scale: 1 is the recording's own speed. */
  onSubmit: (scale: number) => void;
}) {
  const mapped = hasTempoChanges(song);
  const current = song.tempoScale ?? 1;

  const [mode, setMode] = useState<'bpm' | 'percent'>(mapped ? 'percent' : 'bpm');
  const [bpm, setBpm] = useState(String(round(song.bpm * current)));
  const [percent, setPercent] = useState(String(round(current * 100)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const scale =
    mode === 'bpm' ? Number(bpm) / song.bpm : Number(percent) / 100;
  const valid = Number.isFinite(scale) && scale >= 0.5 && scale <= 2;
  const unchanged = valid && Math.abs(scale - current) < 0.0005;

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Change playback speed"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Change speed</h3>

        {mapped ? (
          <p className="dialog-note">
            This song's tempo changes as it goes ({round(song.bpm * current)} BPM at the top), so
            there's no single tempo to set. Give a percentage and the whole song stretches by it,
            keeping the changes where they are.
          </p>
        ) : (
          <div className="segmented" role="radiogroup" aria-label="Set speed by">
            <button
              role="radio"
              aria-checked={mode === 'bpm'}
              className={mode === 'bpm' ? 'seg on' : 'seg'}
              onClick={() => setMode('bpm')}
            >
              BPM
            </button>
            <button
              role="radio"
              aria-checked={mode === 'percent'}
              className={mode === 'percent' ? 'seg on' : 'seg'}
              onClick={() => setMode('percent')}
            >
              Percent
            </button>
          </div>
        )}

        <div className="controls flush">
          {mode === 'bpm' && !mapped ? (
            <>
              <span className="control-label">BPM</span>
              <input
                className="bpm-input mono"
                type="number"
                min={20}
                max={300}
                step={0.5}
                value={bpm}
                onChange={(e) => setBpm(e.target.value)}
                autoFocus
              />
              <span className="control-note">was {round(song.bpm)}</span>
            </>
          ) : (
            <>
              <span className="control-label">Speed</span>
              <input
                className="bpm-input mono"
                type="number"
                min={50}
                max={200}
                step={1}
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                autoFocus
              />
              <span className="control-note">% of the original</span>
            </>
          )}
        </div>

        <div className="controls flush">
          {[75, 90, 100, 110].map((p) => (
            <button
              key={p}
              className="chip"
              onClick={() => {
                setMode('percent');
                setPercent(String(p));
              }}
            >
              {p}%
            </button>
          ))}
        </div>

        {!valid && (
          <div className="notice">Pick something between half speed and double.</div>
        )}

        <p className="dialog-note">
          Every part is re-rendered, which takes a few seconds and is heavier the more stems the
          song has. Stretching much past ±10% starts to smear drums.
        </p>

        <div className="btn-row">
          <button
            className="btn primary"
            disabled={!valid || unchanged}
            onClick={() => onSubmit(scale)}
          >
            {unchanged ? 'No change' : 'Apply'}
          </button>
          {current !== 1 && (
            <button className="btn" onClick={() => onSubmit(1)}>
              Back to original
            </button>
          )}
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

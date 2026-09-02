import { useEffect, useMemo, useState } from 'react';
import type { Song } from '../types';
import type { Player } from '../lib/usePlayer';
import { bounceFileName, encodeWav, formatDuration, nextVersion, peakOf, renderMix } from '../lib/bounce';
import { printFolder } from '../lib/prints';
import { versionsOf } from '../lib/versions';
import { formatBytes } from '../lib/songLoader';
import { writeFile } from '../lib/source';
import { useStore } from '../lib/store';

/**
 * Printing the current mix to a file.
 *
 * The dialog's job is to say exactly what is about to be printed before it is:
 * which channels, at what key and speed, under what name, and where it lands.
 * A bounce is a real file in a shared folder, so none of that should be a
 * surprise afterwards.
 */

type Destination = 'library' | 'download';

export default function BounceDialog({
  song,
  player,
  onClose,
}: {
  song: Song;
  player: Player;
  onClose: () => void;
}) {
  const { rescan, settings } = useStore();
  const [label, setLabel] = useState('no vocal');
  const [where, setWhere] = useState<Destination>('library');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // What's audible right now, straight from the engine's own rule.
  const tracks = useMemo(() => player.engine.bounceTracks(), [player.engine, player.anySoloed]);
  const names = useMemo(() => {
    const byId = new Map(song.variants.map((v) => [v.id, v.name]));
    return tracks.map((t) => byId.get(t.id) ?? 'Click');
  }, [tracks, song.variants]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  // Numbered from prints already in the library, so a second "no vocal" is v2.
  const version = useMemo(
    () => nextVersion(song.variants.map((v) => v.name), label),
    [song.variants, label],
  );
  const fileName = bounceFileName(song.title, label, version);

  /*
   * Into the app's own folder, under the version this was made from, rather
   * than into the Ableton project it came from. The version subfolder is what
   * puts the print back with those parts on the next scan.
   */
  const madeFrom = useMemo(() => {
    const versions = versionsOf(song.variants, song.title);
    const playing = new Set(tracks.map((t) => t.id));
    return (
      versions.find((v) => v.parts.some((p) => playing.has(p.id))) ?? versions[0]
    );
  }, [song.variants, song.title, tracks]);
  const folder = printFolder(settings.root, madeFrom?.name ?? '');
  const seconds = tracks.length ? Math.max(...tracks.map((t) => t.buffer.duration)) : 0;
  const rate = tracks[0]?.buffer.sampleRate ?? 44100;
  const estimatedBytes = Math.round(seconds * rate * 4) + 44;
  const scale = song.tempoScale ?? 1;

  const go = async () => {
    setError(null);
    try {
      setBusy('Mixing…');
      const mixed = await renderMix(tracks);

      /*
       * Several stems at unity can easily sum past 0 dBFS, and 16-bit PCM has
       * nowhere to put it — it wraps into a crackle. Pull the whole print down
       * instead, which is quieter but faithful.
       */
      const peak = peakOf(mixed);
      const gain = peak > 1 ? 0.99 / peak : 1;

      setBusy('Encoding…');
      const blob = encodeWav(mixed, gain);

      if (where === 'download') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
        setDone(`Saved ${fileName} to your downloads.`);
      } else {
        setBusy('Saving to the library…');
        const at = await writeFile(`${folder}/${fileName}`, blob);
        setDone(
          `Saved to ${at}. Rescanning so it turns up as a version of ${song.title}.`,
        );
        void rescan().catch(() => {});
      }
      if (gain < 1) {
        setDone((d) => `${d ?? ''} The mix peaked over full scale, so it was pulled down slightly.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Print the current mix"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Print this mix</h3>

        {tracks.length === 0 ? (
          <p className="dialog-note">
            Nothing is audible — every channel is muted or pulled to silence. Bring something up
            first.
          </p>
        ) : (
          <>
            <p className="dialog-note">
              Printing <strong>{names.length}</strong> channel{names.length === 1 ? '' : 's'} exactly
              as they sound now: {names.join(', ')}.
            </p>

            {(song.transpose !== 0 || scale !== 1) && (
              <div className="notice">
                This will be printed{' '}
                {song.transpose !== 0 && (
                  <>
                    <strong>
                      {song.transpose > 0 ? `${song.transpose} up` : `${-song.transpose} down`}
                    </strong>
                    {scale !== 1 ? ' and ' : ''}
                  </>
                )}
                {scale !== 1 && <strong>at {Math.round(scale * 100)}% speed</strong>}, as you have it
                set.
              </div>
            )}

            <div className="controls flush">
              <span className="control-label">Call it</span>
              <input
                className="text-input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="no vocal"
                aria-label="Version name"
              />
            </div>
            <p className="dialog-note">
              Saved as <span className="code">{fileName}</span> — everything sits inside the
              brackets, which is what makes it show up as a version of the song rather than a song
              of its own.
            </p>

            <div className="segmented" role="radiogroup" aria-label="Where to save it">
              <button
                role="radio"
                aria-checked={where === 'library'}
                className={where === 'library' ? 'seg on' : 'seg'}
                onClick={() => setWhere('library')}
              >
                Share with the band
              </button>
              <button
                role="radio"
                aria-checked={where === 'download'}
                className={where === 'download' ? 'seg on' : 'seg'}
                onClick={() => setWhere('download')}
              >
                Just download it
              </button>
            </div>
            <p className="dialog-note">
              {where === 'library' ? (
                <>
                  Goes into <span className="code">{folder}</span>, beside the stems, so anyone
                  sharing the folder gets it too. Roughly {formatBytes(estimatedBytes)} of WAV at{' '}
                  {formatDuration(seconds)}.
                </>
              ) : (
                <>
                  Downloads to this device only — nothing is uploaded and the band won't see it.
                  Roughly {formatBytes(estimatedBytes)}.
                </>
              )}
            </p>
          </>
        )}

        {error && <div className="notice error">{error}</div>}
        {done && <div className="notice">{done}</div>}

        <div className="btn-row">
          <button
            className="btn primary"
            disabled={!!busy || tracks.length === 0 || !!done}
            onClick={() => void go()}
          >
            {busy ?? (where === 'library' ? 'Print and share' : 'Print and download')}
          </button>
          <button className="btn" onClick={onClose} disabled={!!busy}>
            {done ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

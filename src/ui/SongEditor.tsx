import { useRef, useState } from 'react';
import type { Song } from '../types';
import { useStore } from '../lib/store';
import { formatBytes } from '../lib/songLoader';
import { canEditLibrary } from '../lib/appMode';
import { formatTimedLines, parseTimedLines } from '../lib/chartText';
import { manifestFromSongs, MANIFEST_NAME } from '../lib/preparedSet';
import * as local from '../lib/localSource';

/** Per-song settings: tempo map, key, grouping, variant labels, setlist membership. */
export default function SongEditor({ song, onClose }: { song: Song; onClose: () => void }) {
  const { updateSong, library, updateSetlist } = useStore();
  const [tapHint, setTapHint] = useState<string>('');
  const taps = useRef<number[]>([]);

  const set = (patch: Partial<Song>) => updateSong(song.id, patch);
  const [lyricsText, setLyricsText] = useState(() => formatTimedLines(song.lyrics));
  const [chordsText, setChordsText] = useState(() => formatTimedLines(song.chords));
  const [wrote, setWrote] = useState<string | null>(null);

  /**
   * The edits, written where they survive: a set.json beside the audio, the
   * same file a person could write by hand and the scan already reads. The
   * library alone would carry them too — but a library reset or a fresh
   * machine would lose them, and a file beside the songs does not.
   */
  const writeManifest = async () => {
    setWrote(null);
    try {
      const folder = await local.storedFolder('songs');
      if (!folder) throw new Error('No source folder to write into.');
      const at = song.folderPath.lastIndexOf('/');
      const setFolder = at < 0 ? '' : song.folderPath.slice(0, at);
      const path = setFolder ? `${setFolder}/${MANIFEST_NAME}` : MANIFEST_NAME;
      let previous = null;
      try {
        const { bytes } = await local.readBytes(folder.handle, '', path);
        previous = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        // no manifest there yet, which is the usual case
      }
      const manifest = manifestFromSongs([song], setFolder, previous);
      await local.writeFile(
        folder.handle,
        '',
        path,
        new Blob([JSON.stringify(manifest, null, 2) + '\n'], { type: 'application/json' }),
      );
      setWrote(`Wrote ${path} — these edits now live beside the audio.`);
    } catch (err) {
      setWrote(err instanceof Error ? err.message : String(err));
    }
  };

  /** Average the last few taps into a tempo. */
  const tap = () => {
    const now = performance.now();
    const list = taps.current;
    if (list.length && now - list[list.length - 1] > 2500) list.length = 0; // restart after a pause
    list.push(now);
    if (list.length > 8) list.shift();
    if (list.length < 2) {
      setTapHint('Keep tapping…');
      return;
    }
    const intervals = list.slice(1).map((t, i) => t - list[i]);
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = Math.round((60000 / mean) * 10) / 10;
    if (bpm >= 20 && bpm <= 300) {
      set({ bpm, tempoUnset: false });
      setTapHint(`${bpm} BPM from ${list.length} taps`);
    }
  };

  const toggleSetlist = (setlistId: string, member: boolean) => {
    const setlist = library.setlists.find((s) => s.id === setlistId);
    if (!setlist) return;
    updateSetlist(setlistId, {
      songIds: member ? setlist.songIds.filter((id) => id !== song.id) : [...setlist.songIds, song.id],
    });
  };

  const moveVariant = (index: number, delta: number) => {
    const list = [...song.variants];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    set({ variants: list.map((v, i) => ({ ...v, order: i })) });
  };

  return (
    <div className="panel stack" style={{ background: 'var(--bg-raised)' }}>
      <div className="spread">
        <strong>Song settings</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings">
          ×
        </button>
      </div>

      <div className="field">
        <label htmlFor="bpm">
          Tempo
          <span className="hint">Bar navigation and the click are built from this.</span>
        </label>
        <input
          id="bpm"
          type="number"
          min={20}
          max={300}
          step={0.1}
          value={song.bpm}
          onChange={(e) => {
            const bpm = Number(e.target.value);
            if (bpm > 0) set({ bpm, tempoUnset: false });
          }}
        />
        <button className="btn" style={{ minHeight: 44 }} onClick={tap}>
          Tap
        </button>
      </div>
      {tapHint && <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 12 }}>{tapHint}</div>}

      {song.tempoMap && song.tempoMap.length > 0 && (
        <div className="notice stack" style={{ margin: 0 }}>
          <span>
            <strong style={{ color: 'var(--text)' }}>This song changes tempo.</strong> Bar
            navigation, looping and the click all follow the changes.
          </span>
          <div className="controls" style={{ padding: 0 }}>
            <span className="chip" style={{ border: 'none', background: 'none', paddingLeft: 0 }}>
              bar 1 · {song.bpm}
            </span>
            {[...song.tempoMap]
              .sort((a, b) => a.bar - b.bar)
              .map((point) => (
                <span key={`${point.bar}-${point.bpm}`} className="chip">
                  bar {point.bar} · {point.bpm}
                </span>
              ))}
          </div>
          <div className="btn-row">
            <button
              className="btn"
              style={{ minHeight: 36 }}
              onClick={() => set({ tempoMap: undefined })}
              title="Treat the song as one constant tempo"
            >
              Use a single tempo
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="sig">Time signature</label>
        <select
          id="sig"
          value={`${song.timeSigNum}/${song.timeSigDen}`}
          onChange={(e) => {
            const [num, den] = e.target.value.split('/').map(Number);
            set({ timeSigNum: num, timeSigDen: den });
          }}
        >
          {['4/4', '3/4', '2/4', '5/4', '6/4', '7/4', '6/8', '9/8', '12/8'].map((sig) => (
            <option key={sig} value={sig}>
              {sig}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="offset">
          Bar 1 offset
          <span className="hint">Seconds before the first downbeat. Leave at 0 for exports from 1.1.1.</span>
        </label>
        <input
          id="offset"
          type="number"
          step={0.01}
          value={song.firstBarOffsetSec}
          onChange={(e) => set({ firstBarOffsetSec: Number(e.target.value) || 0 })}
        />
      </div>

      <div className="field">
        <label htmlFor="key">
          Original key
          <span className="hint">Optional — lets the key control show note names.</span>
        </label>
        <input
          id="key"
          type="text"
          value={song.originalKey ?? ''}
          placeholder="e.g. F#m"
          onChange={(e) => set({ originalKey: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="artist">Artist</label>
        <input id="artist" type="text" value={song.artist ?? ''} onChange={(e) => set({ artist: e.target.value })} />
      </div>

      <div className="field">
        <label htmlFor="project">
          Project
          <span className="hint">How songs are grouped in the list.</span>
        </label>
        <input id="project" type="text" value={song.project} onChange={(e) => set({ project: e.target.value || 'Unfiled' })} />
      </div>

      <div>
        <label htmlFor="notes" style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Notes
        </label>
        <textarea
          id="notes"
          rows={3}
          value={song.notes ?? ''}
          placeholder="Lyrics cues, arrangement reminders…"
          onChange={(e) => set({ notes: e.target.value })}
          style={{ marginTop: 6 }}
        />
      </div>

      <div>
        <div className="section-title" style={{ padding: '8px 0 4px' }}>
          Versions
        </div>
        {song.variants.map((variant, i) => (
          <div className="field" key={variant.id}>
            <input
              type="text"
              value={variant.name}
              onChange={(e) => {
                const list = song.variants.map((v) =>
                  v.id === variant.id ? { ...v, name: e.target.value } : v,
                );
                set({ variants: list });
              }}
              style={{ maxWidth: 'none', flex: 1 }}
              aria-label={`Label for ${variant.path}`}
            />
            <button
              className={variant.role === 'stem' ? 'chip on' : 'chip'}
              style={{ minHeight: 36, padding: '0 10px', flexShrink: 0 }}
              onClick={() => {
                const list = song.variants.map((v) =>
                  v.id === variant.id ? { ...v, role: v.role === 'stem' ? 'mix' as const : 'stem' as const } : v,
                );
                set({ variants: list });
              }}
              title={
                variant.role === 'stem'
                  ? 'A stem — plays alongside the others with its own fader'
                  : 'A complete mix — replaces the other mixes when selected'
              }
            >
              {variant.role === 'stem' ? 'Stem' : 'Mix'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', width: 52, textAlign: 'right' }}>
              {formatBytes(variant.sizeBytes)}
            </span>
            <button className="icon-btn" onClick={() => moveVariant(i, -1)} aria-label="Move up" disabled={i === 0}>
              ↑
            </button>
            <button
              className="icon-btn"
              onClick={() => moveVariant(i, 1)}
              aria-label="Move down"
              disabled={i === song.variants.length - 1}
            >
              ↓
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                const list = song.variants.map((v) =>
                  v.id === variant.id ? { ...v, hidden: !v.hidden } : v,
                );
                set({ variants: list });
              }}
              aria-label={variant.hidden ? 'Show version' : 'Hide version'}
              title={variant.hidden ? 'Hidden — tap to show' : 'Visible — tap to hide'}
            >
              {variant.hidden ? '◌' : '◉'}
            </button>
          </div>
        ))}
      </div>

      {library.setlists.length > 0 && (
        <div>
          <div className="section-title" style={{ padding: '8px 0 4px' }}>
            Setlists
          </div>
          <div className="controls" style={{ padding: 0 }}>
            {library.setlists.map((setlist) => {
              const member = setlist.songIds.includes(song.id);
              return (
                <button
                  key={setlist.id}
                  className={member ? 'chip on' : 'chip'}
                  onClick={() => toggleSetlist(setlist.id, member)}
                >
                  {member ? '✓ ' : '+ '}
                  {setlist.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {canEditLibrary && (
        <div>
          <div className="section-title" style={{ padding: '8px 0 4px' }}>
            Lyrics and chords
          </div>
          <div className="field">
            <label htmlFor="song-lyrics">
              Lyrics
              <span className="hint">
                One line per lyric line. Start a line with a bar in brackets — [5] Look at the
                stars — to place it; without one it follows the previous line by four bars.
              </span>
            </label>
            <textarea
              id="song-lyrics"
              rows={6}
              value={lyricsText}
              placeholder={'[1] First line\n[5] Second line'}
              onChange={(e) => setLyricsText(e.target.value)}
              onBlur={() => set({ lyrics: parseTimedLines(lyricsText) })}
              style={{ width: '100%', fontFamily: 'inherit' }}
            />
          </div>
          <div className="field">
            <label htmlFor="song-chords">
              Chords
              <span className="hint">A bar for every line: [1] B, [3] F#m7 — names or numbers.</span>
            </label>
            <textarea
              id="song-chords"
              rows={4}
              value={chordsText}
              placeholder={'[1] B\n[3] F#'}
              onChange={(e) => setChordsText(e.target.value)}
              onBlur={() => set({ chords: parseTimedLines(chordsText) })}
              style={{ width: '100%', fontFamily: 'inherit' }}
            />
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => void writeManifest()}>
              Write set.json beside the audio
            </button>
          </div>
          {wrote && <div className="notice">{wrote}</div>}
        </div>
      )}

      <div style={{ fontSize: 11.5, color: '#6b7789' }}>
        Folder: <span className="code">{song.folderPath}</span>
      </div>
    </div>
  );
}

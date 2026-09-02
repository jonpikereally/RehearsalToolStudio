import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { groupSongs } from '../lib/songSets';
import { navigate, songUrl } from '../lib/router';
import { formatSemitones } from '../lib/pitchService';
import { mixesOf, stemsOf } from '../lib/stemMix';
import type { ScanResult } from '../lib/scan';
import type { Song } from '../types';

export default function LibraryView() {
  const {
    library, rescan, scanning, scanProgress, lastScan, dismissScanResult, syncError, currentSet,
  } = useStore();
  const [filter, setFilter] = useState('');

  // Only the set being worked on; the rest of the folder is not on screen.
  const inSet = useMemo(
    () => library.songs.filter((s) => s.setPath === currentSet),
    [library.songs, currentSet],
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const songs = needle
      ? inSet.filter(
          (s) =>
            s.title.toLowerCase().includes(needle) ||
            s.project.toLowerCase().includes(needle) ||
            (s.artist ?? '').toLowerCase().includes(needle),
        )
      : inSet;
    return groupSongs(songs);
  }, [inSet, filter]);

  const needTempo = inSet.filter((s) => s.tempoUnset).length;

  return (
    <>
      <div className="topbar">
        <h1>
          Songs
          <span className="sub" style={{ display: 'block' }}>
            {inSet.length} song{inSet.length === 1 ? '' : 's'}
            {needTempo > 0 && ` · ${needTempo} need a tempo`}
          </span>
        </h1>
        <button className="icon-btn" onClick={() => void rescan()} disabled={scanning} title="Rescan the folder">
          {scanning ? '…' : '⟳'}
        </button>
      </div>

      {scanning && <div className="notice">{scanProgress || 'Scanning…'}</div>}
      {syncError && <div className="notice error">{syncError}</div>}

      {lastScan && !scanning && (
        <div className="notice spread">
          <span>
            {summariseScan(lastScan)}
          </span>
          <button className="icon-btn" onClick={dismissScanResult} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {inSet.length > 0 && (
        <div style={{ padding: '12px 16px 0' }}>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter songs…"
            aria-label="Filter songs"
          />
        </div>
      )}

      {inSet.length === 0 && !scanning && (
        <div className="empty">
          <h2>No songs in this set</h2>
          <p>
            None of its songs have audio here yet, or the set has changed since it was read —
            tap ⟳ to read it again.
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key}>
          <div className="section-title">
            {group.project && <span className="section-project">{group.project}</span>}
            {group.artist}
          </div>
          {group.songs.map((song) => (
            <SongRow key={song.id} song={song} />
          ))}
        </section>
      ))}

      <div style={{ height: 24 }} />
    </>
  );
}

function SongRow({ song, setlistId }: { song: Song; setlistId?: string }) {
  return (
    <button className="row" onClick={() => navigate(songUrl(song.id, setlistId))}>
      <div className="row-main">
        <div className="row-title">{song.title}</div>
        <div className="row-sub">
          {/* The artist is the section heading, so it isn't repeated here. */}
          {song.tempoUnset ? 'tempo not set' : `${round(song.bpm)} BPM`}
          {` · ${song.timeSigNum}/${song.timeSigDen}`}
          {` · ${describeParts(song)}`}
        </div>
      </div>
      <div className="row-right">
        {song.transpose !== 0 && <span className="badge warn">{formatSemitones(song.transpose)}</span>}
        {song.tempoUnset && <span className="badge warn">tempo</span>}
        {song.variants.length === 0 && <span className="badge warn">no audio</span>}
        <span aria-hidden>›</span>
      </div>
    </button>
  );
}

export { SongRow };

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Stems and complete mixes are different things and are counted separately —
 * "6 stems · 2 versions" rather than a single lump of eight.
 */
export function describeParts(song: Song): string {
  const stems = stemsOf(song).length;
  const mixes = mixesOf(song).length;

  const parts: string[] = [];
  if (stems) parts.push(`${stems} stem${stems === 1 ? '' : 's'}`);
  if (mixes) parts.push(`${mixes} version${mixes === 1 ? '' : 's'}`);
  if (parts.length) return parts.join(' · ');

  // Everything hidden: fall back to the raw file count so the row isn't blank.
  const total = song.variants.length;
  if (!total) return 'no audio here';
  return `${total} file${total === 1 ? '' : 's'} hidden`;
}

function summariseScan(scan: ScanResult): string {
  const parts: string[] = [];
  if (scan.addedSongs.length) parts.push(`${scan.addedSongs.length} new song${plural(scan.addedSongs.length)}`);
  if (scan.addedVariants.length) parts.push(`${scan.addedVariants.length} new version${plural(scan.addedVariants.length)}`);
  if (scan.updatedVariants.length) parts.push(`${scan.updatedVariants.length} re-exported`);
  if (scan.removedVariants.length) parts.push(`${scan.removedVariants.length} file${plural(scan.removedVariants.length)} gone`);
  if (scan.removedSongs.length) parts.push(`${scan.removedSongs.length} song${plural(scan.removedSongs.length)} removed`);
  const from = scan.sourceLabel ? ` from ${scan.sourceLabel}` : '';
  if (scan.alsSets) {
    parts.unshift(
      `${scan.alsSongs} song${plural(scan.alsSongs ?? 0)} from ` +
        `${scan.alsSets} Ableton set${plural(scan.alsSets)}` +
        // Named separately from the songs: a set that gives songs but no
        // running order is the one case worth being able to see.
        (scan.alsSetlists
          ? `, ${scan.alsSetlists} as a setlist`
          : ' — none of them as a setlist'),
    );
  }
  const notes = scan.alsNotes?.length ? ` ${scan.alsNotes.join('. ')}.` : '';
  if (parts.length) return `Scan complete${from} — ${parts.join(', ')}.${notes}`;

  // Nothing found: say what the scan actually saw, so the cause is obvious.
  if (scan.filesSeen === 0) {
    return `Scan complete — no files at all were found${from}. Is this the right folder?`;
  }
  if (scan.audioSeen === 0) {
    const examples = scan.skippedSamples.length ? ` For example: ${scan.skippedSamples.join(', ')}.` : '';
    return (
      `Scan complete${from} — saw ${scan.filesSeen} file${plural(scan.filesSeen)}, but none had an audio ` +
      `extension (mp3, m4a, wav, aif, flac…).${examples}`
    );
  }
  return `Scan complete${from} — ${scan.audioSeen} audio file${plural(scan.audioSeen)} found, nothing changed.`;
}

const plural = (n: number) => (n === 1 ? '' : 's');

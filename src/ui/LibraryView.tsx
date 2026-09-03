import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { groupSongs } from '../lib/songSets';
import { navigate, songUrl } from '../lib/router';
import { openRun, orderForRun, useRun } from '../lib/run';
import { formatSemitones } from '../lib/pitchService';
import { mixesOf, stemsOf } from '../lib/stemMix';
import { useMissingAudio } from '../lib/useMissingAudio';
import type { ScanResult } from '../lib/scan';
import type { Song } from '../types';

export default function LibraryView() {
  const {
    library, rescan, scanning, scanProgress, lastScan, dismissScanResult, syncError, currentSet,
  } = useStore();
  const [filter, setFilter] = useState('');

  /*
   * Picking several songs to open together.
   *
   * Off by default, and deliberately a mode you turn on: a list where one tap
   * sometimes opens a song and sometimes ticks it is a list you can't trust.
   * With it on, nothing opens until you say so.
   */
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const run = useRun();

  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicking(false);
        setPicked([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);

  const togglePick = (id: string) =>
    setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  /*
   * Open them together, in the order they are played rather than the order
   * they were ticked — which is the whole point of picking more than one.
   */
  const openPicked = () => {
    const { songIds, setlistId } = orderForRun(library, currentSet, picked);
    if (songIds.length < 2) return;
    openRun(songIds, setlistId);
    setPicking(false);
    setPicked([]);
    navigate(songUrl(songIds[0], setlistId ?? undefined));
  };

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
        {inSet.length > 1 && (
          <button
            className={picking ? 'icon-btn on' : 'icon-btn'}
            onClick={() => {
              setPicking((on) => !on);
              setPicked([]);
            }}
            aria-pressed={picking}
            aria-label="Select several songs"
            title="Select several songs and open them together"
          >
            ☑
          </button>
        )}
        <button className="icon-btn" onClick={() => void rescan()} disabled={scanning} title="Rescan the folder">
          {scanning ? '…' : '⟳'}
        </button>
      </div>

      {picking && (
        <div className="setbar">
          <span>
            {picked.length === 0
              ? 'Tap the songs to open together.'
              : `${picked.length} song${picked.length === 1 ? '' : 's'} picked`}
            {picked.length === 1 && ' — one song is not a run; pick another.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="chip" onClick={() => setPicked([])} disabled={picked.length === 0}>
              Clear
            </button>
            <button className="chip on" onClick={openPicked} disabled={picked.length < 2}>
              Open {picked.length > 1 ? `these ${picked.length}` : 'together'}
            </button>
          </span>
        </div>
      )}

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
            <SongRow
              key={song.id}
              song={song}
              picking={picking}
              picked={picked.includes(song.id)}
              open={run.songIds.includes(song.id)}
              onPick={() => togglePick(song.id)}
            />
          ))}
        </section>
      ))}

      <div style={{ height: 24 }} />
    </>
  );
}

function SongRow({
  song,
  setlistId,
  picking = false,
  picked = false,
  open = false,
  onPick,
}: {
  song: Song;
  setlistId?: string;
  /** Tapping the row ticks it rather than opening it. */
  picking?: boolean;
  picked?: boolean;
  /** Already one of the songs a run is holding. */
  open?: boolean;
  onPick?: () => void;
}) {
  const missing = useMissingAudio(song);
  return (
    <button
      className="row"
      aria-pressed={picking ? picked : undefined}
      onClick={() => (picking ? onPick?.() : navigate(songUrl(song.id, setlistId)))}
    >
      {picking && (
        <span className={picked ? 'tick on' : 'tick'} aria-hidden>
          {picked ? '✓' : ''}
        </span>
      )}
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
        {open && !picking && <span className="badge ok">open</span>}
        {song.transpose !== 0 && <span className="badge warn">{formatSemitones(song.transpose)}</span>}
        {song.tempoUnset && <span className="badge warn">tempo</span>}
        {song.variants.length === 0 && <span className="badge warn">no audio</span>}
        {!!missing && (
          <span className="badge warn" title="Files this song wants that are not here to play; the set's click and cues aside">
            {missing} file{missing === 1 ? '' : 's'} missing
          </span>
        )}
        <span aria-hidden>{picking ? '' : '›'}</span>
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

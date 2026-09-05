import { useState } from 'react';
import PrepareSetDialog from './PrepareSetDialog';
import { useStore } from '../lib/store';
import { navigate, songUrl } from '../lib/router';
import { formatClock, runningOrder } from '../lib/runningOrder';
import { isFromSet } from '../lib/alsImport';
import { canEditLibrary } from '../lib/appMode';
import { useMissingAudio } from '../lib/useMissingAudio';
import { sortSongs } from '../lib/songSort';
import SortBar, { useSort } from './SortBar';
import type { Song } from '../types';

export default function SetlistView({ setlistId }: { setlistId: string }) {
  const { library, updateSetlist, deleteSetlist, currentSet } = useStore();
  const setlist = library.setlists.find((s) => s.id === setlistId);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [sort, setSort] = useSort('ls.sort.setlist');

  if (!setlist) {
    return (
      <div className="empty">
        <h2>Setlist not found</h2>
        <button className="btn" onClick={() => navigate('/setlists')}>
          Back to setlists
        </button>
      </div>
    );
  }

  const songs = setlist.songIds
    .map((id) => library.songs.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= setlist.songIds.length) return;
    const ids = [...setlist.songIds];
    [ids[index], ids[target]] = [ids[target], ids[index]];
    updateSetlist(setlist.id, { songIds: ids });
  };

  const remove = (songId: string) => {
    updateSetlist(setlist.id, { songIds: setlist.songIds.filter((id) => id !== songId) });
  };

  // How long the set runs, and where each song falls in it — always worked
  // out from the running order, whichever way the list is shown.
  const order = runningOrder(songs);
  const byId = new Map(order.entries.map((e) => [e.song.id, e]));
  const setOrder = new Map(setlist.songIds.map((id, i) => [id, i]));
  const shown = sortSongs(songs, sort, setOrder).map((song) => byId.get(song.id)!);
  // Moving a song up or down means something only in the order it's played.
  const inSetOrder = sort.key === 'set' && sort.dir === 'asc';

  /*
   * A setlist that came from an Ableton set is rebuilt from it on every scan,
   * so editing it here would be undone the next time you press Rescan. The
   * controls that can't stick are not shown at all rather than shown and
   * quietly reverted — the set file is where you change this running order.
   */
  const fromSet = isFromSet(setlist.id) || !canEditLibrary;

  const candidates = library.songs.filter(
    (s) =>
      s.setPath === currentSet &&
      !setlist.songIds.includes(s.id) &&
      (filter.trim() === '' ||
        s.title.toLowerCase().includes(filter.trim().toLowerCase()) ||
        s.project.toLowerCase().includes(filter.trim().toLowerCase())),
  );

  return (
    <>
      <div className="topbar">
        <button className="icon-btn" onClick={() => navigate('/setlists')} aria-label="Back">
          ‹
        </button>
        <h1>
          {setlist.name}
          <span className="sub" style={{ display: 'block' }}>
            {songs.length} song{songs.length === 1 ? '' : 's'}
            {order.knownSec > 0 && ` · ${formatClock(order.knownSec)}`}
            {order.unknown > 0 && ` + ${order.unknown} not timed yet`}
          </span>
        </h1>
        {!fromSet && (
          <button className="icon-btn" onClick={() => setAdding((v) => !v)} aria-label="Add songs">
            {adding ? '×' : '+'}
          </button>
        )}
      </div>

      {fromSet && canEditLibrary && (
        <div className="notice">
          This running order comes from the Ableton set, and is read again every time you rescan —
          move a song in the arrangement and it moves here. That's also why it can't be edited here.
        </div>
      )}

      {adding && (
        <div className="panel stack">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search songs to add…"
            autoFocus
          />
          <div className="controls" style={{ padding: 0, maxHeight: 260, overflowY: 'auto' }}>
            {candidates.slice(0, 60).map((song) => (
              <button
                key={song.id}
                className="chip"
                onClick={() =>
                  updateSetlist(setlist.id, { songIds: [...setlist.songIds, song.id] })
                }
              >
                + {song.title}
              </button>
            ))}
            {candidates.length === 0 && (
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>Nothing left to add.</span>
            )}
          </div>
        </div>
      )}

      {songs.length === 0 && !adding && (
        <div className="empty">
          <p>This setlist is empty.</p>
          {!fromSet && (
            <button className="btn primary" onClick={() => setAdding(true)}>
              Add songs
            </button>
          )}
        </div>
      )}

      {songs.length > 1 && (
        <div style={{ padding: '6px 16px 0' }}>
          <SortBar sort={sort} onChange={setSort} />
        </div>
      )}

      {shown.map(({ song, durationSec, startsAtSec }) => {
        const i = setOrder.get(song.id) ?? 0;
        return (
        <div className="row" key={song.id}>
          <span className="mono" style={{ color: 'var(--text-dim)', width: 22 }} title="Where it comes in the set">
            {i + 1}
          </span>
          <button
            className="row-main"
            style={{ background: 'none', textAlign: 'left' }}
            onClick={() => navigate(songUrl(song.id, setlist.id))}
          >
            <div className="row-title">{song.title}</div>
            <div className="row-sub">
              {startsAtSec !== null && (
                <span className="mono" style={{ color: 'var(--accent)' }}>
                  {formatClock(startsAtSec)}
                </span>
              )}
              {startsAtSec !== null && ' · '}
              {song.tempoUnset ? 'tempo not set' : `${song.bpm} BPM`}
              {song.originalKey ? ` · ${song.originalKey}` : ''} · {song.project}
            </div>
          </button>
          <div className="row-right">
            <SilentBadge song={song} />
            <span
              className="mono"
              title={durationSec === null ? 'Play it once to time it' : undefined}
            >
              {durationSec === null ? '––––' : formatClock(durationSec)}
            </span>
            {!fromSet && inSetOrder && (
              <>
                <button
                  className="icon-btn"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  className="icon-btn"
                  onClick={() => move(i, 1)}
                  disabled={i === songs.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  className="icon-btn"
                  onClick={() => remove(song.id)}
                  aria-label="Remove from setlist"
                >
                  −
                </button>
              </>
            )}
          </div>
        </div>
        );
      })}

      {order.unknown > 0 && songs.length > 0 && (
        <div className="panel">
          <div style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>
            {order.unknown} song{order.unknown === 1 ? ' has' : 's have'} never been played on this
            device, so {order.unknown === 1 ? 'its length is' : 'their lengths are'} unknown — open{' '}
            {order.unknown === 1 ? 'it' : 'them'} once and the running order fills in.
          </div>
        </div>
      )}

      {/*
        Preparing belongs here, on the running order it prepares, with these
        songs ticked to start with. It used to live in Settings, which is
        where you go to change how the app behaves, not to hand a set to the
        band.
      */}
      {songs.length > 0 && (
        <div className="panel btn-row">
          <button className="btn primary" onClick={() => setPreparing(true)}>
            Prepare for Rehearsal Tool
          </button>
          <span style={{ color: 'var(--text-dim)', fontSize: 13, alignSelf: 'center' }}>
            {songs.length === 1 ? 'this song' : `these ${songs.length} songs`}, as small files the band's app plays
          </span>
        </div>
      )}
      {preparing && (
        <PrepareSetDialog preselect={songs.map((s) => s.title)} onClose={() => setPreparing(false)} />
      )}

      <div className="panel btn-row">
        {/* The name follows the set's folder, so renaming would be undone too. */}
        {!fromSet && (
          <button
            className="btn"
            onClick={() => {
              const name = window.prompt('Rename setlist', setlist.name);
              if (name?.trim()) updateSetlist(setlist.id, { name: name.trim() });
            }}
          >
            Rename
          </button>
        )}
        {canEditLibrary && (
          <button
            className="btn danger"
            onClick={() => {
              const warning = fromSet
                ? `Delete the setlist “${setlist.name}”? It comes from an Ableton set, so the next rescan will bring it back. The songs themselves stay put.`
                : `Delete the setlist “${setlist.name}”? The songs themselves stay put.`;
              if (window.confirm(warning)) {
                deleteSetlist(setlist.id);
                navigate('/setlists');
              }
            }}
          >
            Delete setlist
          </button>
        )}
      </div>
    </>
  );
}

/**
 * A song in the running order with nothing to hear.
 *
 * The setlist is the other place a song gets opened from, and it is the worse
 * one to find out in: you are working through a set in order, and the song
 * that turns out to be silent is the one you had planned the next ten minutes
 * around. Its own component so each row asks about its own files.
 */
function SilentBadge({ song }: { song: Song }) {
  const audio = useMissingAudio(song);
  if (song.variants.length === 0) {
    return (
      <span className="badge bad" title="This song has no parts at all — the set gives it no audio.">
        nothing to play
      </span>
    );
  }
  if (!audio?.silent) return null;
  return (
    <span
      className="badge bad"
      title="Every musical part is missing from the folder. Opening it would play the set's click and nothing else."
    >
      nothing to play
    </span>
  );
}

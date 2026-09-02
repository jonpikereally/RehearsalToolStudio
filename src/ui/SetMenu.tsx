import { useEffect, useState } from 'react';
import { navigate, songUrl } from '../lib/router';
import { formatClock } from '../lib/runningOrder';
import { otherSetsInProject, setLabel, type SongSet } from '../lib/songSets';
import type { SongId } from '../types';

/**
 * The rest of the set, from inside a song.
 *
 * The player could already step to the next song, which is the right control
 * for working through a set in order and the wrong one for "play that one
 * again" — four taps and four song loads away. This is the whole set at once.
 *
 * The set you're in is listed flat, because that's the list you want: one tap
 * to any song in it. The other sets in the project are underneath and folded,
 * because leaving the set is the rarer move and shouldn't cost the common one
 * any room.
 */
export default function SetMenu({
  current,
  sets,
  songId,
  onClose,
}: {
  current: SongSet;
  /** Every set in the library, for the way out. */
  sets: SongSet[];
  /** The song being played, marked in the list. */
  songId: SongId;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const others = otherSetsInProject(sets, current);
  const project = current.projects.length === 1 ? current.projects[0] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (set: SongSet, id: SongId) => {
    onClose();
    // Jumping within a setlist stays in it, so next/previous and the "3 of 12"
    // keep meaning what they did before the jump.
    navigate(songUrl(id, set.setlistId ?? undefined));
  };

  return (
    <>
      <div className="set-menu-backdrop" onClick={onClose} />
      <div className="set-menu" role="menu" aria-label="Songs in this set">
        <div className="set-menu-head">{setLabel(current)}</div>

        {current.songs.map((song, index) => (
          <button
            key={song.id}
            role="menuitem"
            className={song.id === songId ? 'set-menu-row on' : 'set-menu-row'}
            onClick={() => go(current, song.id)}
            aria-current={song.id === songId ? 'true' : undefined}
          >
            {/* A setlist has a running order worth numbering; a folder hasn't. */}
            {current.kind === 'setlist' && <span className="set-menu-num">{index + 1}</span>}
            <span className="set-menu-title">{song.title}</span>
            {song.durationSec ? (
              <span className="set-menu-time mono">{formatClock(song.durationSec)}</span>
            ) : null}
          </button>
        ))}

        {others.length > 0 && (
          <div className="set-menu-others">
            <div className="set-menu-head">
              {project ? `Other sets in ${project}` : 'Other sets'}
            </div>
            {others.map((set) => (
              <div key={set.id}>
                <button
                  className="set-menu-set"
                  onClick={() => setExpanded((open) => (open === set.id ? null : set.id))}
                  aria-expanded={expanded === set.id}
                >
                  <span className={expanded === set.id ? 'arrow open' : 'arrow'} aria-hidden>
                    ▸
                  </span>
                  <span className="set-menu-title">{set.name}</span>
                  <span className="set-menu-time">
                    {set.kind === 'setlist' ? 'set · ' : ''}
                    {set.songs.length}
                  </span>
                </button>
                {expanded === set.id &&
                  set.songs.map((song) => (
                    <button
                      key={song.id}
                      role="menuitem"
                      className="set-menu-row nested"
                      onClick={() => go(set, song.id)}
                    >
                      <span className="set-menu-title">{song.title}</span>
                    </button>
                  ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

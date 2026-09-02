import { useEffect, useMemo, useRef } from 'react';
import type { Song } from '../types';
import type { Player } from '../lib/usePlayer';
import { buildChart, rowAtBar } from '../lib/chart';
import { hiddenLanes } from '../lib/chartPrefs';
import { secToBar } from '../lib/bars';

/**
 * The words, big enough to read from behind a mic stand.
 *
 * Everything that helps in rehearsal — faders, markers, the timeline — is in
 * the way on stage, so this shows the line you're on, the one coming, and the
 * section you're in, and nothing else. Tap or press Escape to come back.
 *
 * Position is written straight to the DOM, as everywhere else that follows the
 * playhead: re-rendering React sixty times a second is what the transport was
 * carefully taken out of.
 */
export default function ConfidenceMonitor({
  song,
  player,
  onClose,
}: {
  song: Song;
  player: Player;
  onClose: () => void;
}) {
  const rows = useMemo(() => buildChart(song, hiddenLanes(song.id)), [song]);

  const sectionRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const chordsRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(-2);

  const { subscribePosition } = player;

  useEffect(() => {
    shownRef.current = -2;
    return subscribePosition((sec) => {
      const bar = secToBar(sec, song);
      const index = rowAtBar(rows, bar);

      // The bar counts on every frame; the words only change on a new line.
      if (barRef.current) barRef.current.textContent = String(Math.max(1, Math.floor(bar)));
      if (index === shownRef.current) return;
      shownRef.current = index;

      const row = rows[index];
      const next = rows[index + 1];

      if (sectionRef.current) {
        // A section name only appears on the row that starts it, so carry the
        // last one forward — on stage you want to know where you are, always.
        let name = '';
        for (let i = index; i >= 0; i--) {
          if (rows[i]?.section) {
            name = rows[i].section!;
            break;
          }
        }
        sectionRef.current.textContent = name;
      }
      if (nowRef.current) {
        nowRef.current.textContent = row?.lines.join(' · ') ?? (index < 0 ? 'ready' : '');
      }
      if (nextRef.current) nextRef.current.textContent = next?.lines.join(' · ') ?? '';
      if (chordsRef.current) {
        chordsRef.current.textContent = (row?.chords ?? []).map((c) => c.text).join('   ');
      }
    });
  }, [subscribePosition, rows, song]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // The transport still works while it's up — you're playing, after all.
      if (e.key === ' ') {
        e.preventDefault();
        void player.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, player]);

  return (
    <div className="monitor" role="dialog" aria-label={`${song.title} — words`}>
      <div className="monitor-top">
        <div className="monitor-section" ref={sectionRef} />
        <div className="monitor-title">{song.title}</div>
        <div className="monitor-bar mono" ref={barRef}>
          1
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Leave the big view">
          ×
        </button>
      </div>

      <div className="monitor-body">
        <div className="monitor-chords mono" ref={chordsRef} />
        <div className="monitor-now" ref={nowRef} />
        <div className="monitor-next" ref={nextRef} />
      </div>

      <div className="monitor-foot">
        <button
          className="monitor-play"
          onClick={() => void player.toggle()}
          aria-label={player.playing ? 'Pause' : 'Play'}
        >
          {player.playing ? '❙❙' : '▶'}
        </button>
      </div>
    </div>
  );
}

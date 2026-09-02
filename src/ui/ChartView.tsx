import { useEffect, useMemo, useRef, useState } from 'react';
import type { Song } from '../types';
import type { Player } from '../lib/usePlayer';
import { buildChart, chartLanes, rowAtBar } from '../lib/chart';
import { hiddenLanes, setLaneHidden } from '../lib/chartPrefs';
import { secToBar } from '../lib/bars';
import BlockHead, { type BlockChrome } from './BlockHead';

/**
 * Lyrics and chords, following the playhead.
 *
 * Like the timeline, this tracks position by writing to the DOM rather than
 * through React state — highlighting a row sixty times a second would put the
 * whole player back into the render loop the transport was taken out of.
 */
export default function ChartView({
  song,
  player,
  chrome,
}: {
  song: Song;
  player: Player;
  chrome: BlockChrome;
}) {
  const lanes = useMemo(() => chartLanes(song), [song]);
  const [hidden, setHidden] = useState<string[]>(() => hiddenLanes(song.id));

  // A song change brings its own preferences.
  useEffect(() => setHidden(hiddenLanes(song.id)), [song.id]);

  const toggleLane = (laneId: string) => {
    const nowHidden = !hidden.includes(laneId);
    setLaneHidden(song.id, laneId, nowHidden);
    setHidden((prev) => (nowHidden ? [...prev, laneId] : prev.filter((id) => id !== laneId)));
  };

  const rows = useMemo(() => buildChart(song, hidden), [song, hidden]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const activeRef = useRef(-1);

  const { subscribePosition } = player;

  useEffect(() => {
    activeRef.current = -1;
    return subscribePosition((sec) => {
      const index = rowAtBar(rows, secToBar(sec, song));
      if (index === activeRef.current) return;

      rowRefs.current[activeRef.current]?.classList.remove('on');
      activeRef.current = index;

      const el = rowRefs.current[index];
      if (!el) return;
      el.classList.add('on');

      // Keep the current line in view without yanking the whole page around.
      // `.chart` is positioned, so offsetTop is already relative to it.
      const box = scrollRef.current;
      if (!box) return;
      const wanted = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, wanted), behavior: 'smooth' });
    });
  }, [subscribePosition, rows, song]);

  const chips = lanes.length > 1 && (
    <div className="chart-lanes" role="group" aria-label="Which parts of the chart to show">
      {lanes.map((lane) => (
        <button
          key={lane.id}
          className={hidden.includes(lane.id) ? 'lane-chip' : 'lane-chip on'}
          onClick={() => toggleLane(lane.id)}
          aria-pressed={!hidden.includes(lane.id)}
          title={`${hidden.includes(lane.id) ? 'Show' : 'Hide'} ${lane.name.toLowerCase()}`}
        >
          {lane.name}
        </button>
      ))}
    </div>
  );

  const title = song.lyrics?.length ? 'Lyrics' : 'Chords';

  return (
    <section className={chrome.dragging ? 'block dragging' : 'block'} aria-label={title}>
      <BlockHead title={title} chrome={chrome} extra={chips} />
      {chrome.collapsed ? null : !rows.length ? (
        // Every lane switched off is a deliberate choice, so say so rather than
        // vanishing — otherwise the chart looks broken and there's no way back.
        <p className="chart-empty">Nothing shown — pick a part above.</p>
      ) : (
      <div className="chart" ref={scrollRef}>
      {rows.map((row, i) => (
        <div
          key={`${row.bar}-${i}`}
          className={`chart-row${row.lines.length ? '' : ' chords-only'}`}
          ref={(el) => {
            rowRefs.current[i] = el;
          }}
          onClick={() => player.seekToBar(row.bar)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              player.seekToBar(row.bar);
            }
          }}
          title={`Jump to bar ${Math.round(row.bar)}`}
        >
          {row.section && <div className="chart-section">{row.section}</div>}
          <span className="chart-bar mono">{Math.round(row.bar)}</span>
          <div className="chart-body">
            {row.chords.length > 0 && (
              <div className="chart-chords">
                {row.chords.map((c, j) => (
                  <span key={`${c.bar}-${j}`} className="chart-chord">
                    {c.text}
                  </span>
                ))}
              </div>
            )}
            {row.lines.map((line, j) => (
              <div key={j} className="chart-lyric">
                {line}
              </div>
            ))}
          </div>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

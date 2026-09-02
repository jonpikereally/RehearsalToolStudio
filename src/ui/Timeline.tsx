import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Song } from '../types';
import { barToSec, secPerBar, secToBar, tempoSegments, totalBars } from '../lib/bars';
import type { LoopRegion } from '../lib/audioEngine';

interface Props {
  song: Song;
  duration: number;
  /** Throttled — for the accessible value only. The playhead uses `subscribePosition`. */
  position: number;
  loop: LoopRegion | null;
  onSeek: (sec: number) => void;
  /** Called with a bar number when the user drags out a loop region. */
  onLoopDrag: (region: LoopRegion | null) => void;
  /** Frame-rate position feed, so the playhead moves without re-rendering. */
  subscribePosition: (cb: (sec: number) => void) => () => void;
}

/**
 * Bar ruler + playhead. Tap to seek to a bar line; drag horizontally with a
 * long press to set a loop region.
 */
export default function Timeline({
  song,
  duration,
  position,
  loop,
  onSeek,
  onLoopDrag,
  subscribePosition,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ bar: number; time: number; moved: boolean } | null>(null);

  // Move the playhead by touching one style property, not by re-rendering.
  useEffect(
    () =>
      subscribePosition((sec) => {
        const el = playheadRef.current;
        if (!el) return;
        const ratio = duration > 0 ? Math.max(0, Math.min(1, sec / duration)) : 0;
        el.style.left = `${ratio * 100}%`;
      }),
    [subscribePosition, duration],
  );

  const bars = totalBars(duration, song);
  const barSec = secPerBar(song);

  /** Draw a line every N bars, where N keeps them at least ~9px apart. */
  const gridStep = useMemo(() => {
    const width = ref.current?.clientWidth ?? 360;
    const pxPerBar = width / Math.max(1, bars);
    for (const step of [1, 2, 4, 8, 16, 32, 64]) {
      if (pxPerBar * step >= 9) return step;
    }
    return 128;
  }, [bars, duration]);

  const pct = (sec: number) => (duration > 0 ? Math.max(0, Math.min(1, sec / duration)) * 100 : 0);

  const barAtClientX = useCallback(
    (clientX: number): number => {
      const el = ref.current;
      if (!el) return 1;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.max(1, Math.round(secToBar(ratio * duration, song)));
    },
    [duration, song],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { bar: barAtClientX(e.clientX), time: Date.now(), moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start) return;
    const bar = barAtClientX(e.clientX);
    if (bar === start.bar && !start.moved) return;
    start.moved = true;
    const a = Math.min(start.bar, bar);
    const b = Math.max(start.bar, bar);
    if (b - a >= 1) {
      onLoopDrag({ startSec: barToSec(a, song), endSec: barToSec(b, song) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start) return;
    if (!start.moved) onSeek(barToSec(barAtClientX(e.clientX), song));
  };

  // The grid only changes with the tempo map or the duration, never the playhead.
  const gridlines = useMemo(() => {
    const lines: JSX.Element[] = [];
    if (barSec <= 0 || duration <= 0) return lines;
    for (let bar = 1; bar <= bars; bar += gridStep) {
      const sec = barToSec(bar, song);
      if (sec > duration) break;
      const strong = (bar - 1) % (gridStep * 4) === 0;
      lines.push(
        <div
          key={bar}
          className={strong ? 'gridline strong' : 'gridline'}
          style={{ left: `${(sec / duration) * 100}%` }}
        />,
      );
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, gridStep, barSec, duration, song.bpm, song.timeSigNum, song.timeSigDen, song.firstBarOffsetSec]);

  return (
    <div
      className="timeline"
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (dragStart.current = null)}
      role="slider"
      aria-label="Position"
      aria-valuemin={1}
      aria-valuemax={bars}
      aria-valuenow={Math.floor(secToBar(position, song))}
      tabIndex={0}
    >
      {gridlines}

      {loop && (
        <div
          className="loop-region"
          style={{ left: `${pct(loop.startSec)}%`, width: `${pct(loop.endSec) - pct(loop.startSec)}%` }}
        />
      )}

      {song.markers.map((marker) => {
        const sec = barToSec(marker.bar, song);
        if (sec > duration) return null;
        return (
          <div key={marker.id}>
            <div className="gridline strong" style={{ left: `${pct(sec)}%`, background: 'var(--good)' }} />
            <div className="marker" style={{ left: `${pct(sec)}%` }}>
              {marker.name}
            </div>
          </div>
        );
      })}

      {/*
        Where the tempo steps. The first segment is the song's own tempo and
        isn't a change, so it doesn't get a tick.
      */}
      {tempoSegments(song)
        .slice(1)
        .map((seg) => {
          if (seg.startSec > duration) return null;
          return (
            <div key={`t${seg.startBar}`}>
              <div
                className="gridline tempo-tick"
                style={{ left: `${pct(seg.startSec)}%` }}
              />
              <div className="tempo-flag" style={{ left: `${pct(seg.startSec)}%` }}>
                {Math.round(seg.bpm * 10) / 10}
              </div>
            </div>
          );
        })}

      {/* Position is written straight to this node by the subscription above. */}
      <div className="playhead" ref={playheadRef} />
    </div>
  );
}

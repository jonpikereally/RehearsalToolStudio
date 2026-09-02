import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Song } from '../types';
import { barToSec, secToBar, totalBars } from '../lib/bars';
import { clipSpans, describePatch, type PatchClip } from '../lib/midi';

/** How far a pointer may travel and still count as a tap rather than a drag. */
const SLOP_PX = 4;

/**
 * The song's patch changes, laid out along it.
 *
 * A list of sections with patches hanging off them answered "what does the
 * chorus do" but never "what is the rig on right now", which is the question
 * you have while playing. Drawn end to end, each clip holding until the next,
 * it reads the way the pedalboard actually behaves across the song.
 *
 * The same left-to-right as the transport's timeline above it, so a clip sits
 * under the part of the song it governs — and can be dragged along it, which
 * is how "that boost is a bar early" gets fixed while you can still hear it.
 */
export default function PatchLane({
  song,
  duration,
  clips,
  markers,
  onEdit,
  onAddAt,
  onMove,
  onResize,
  subscribePosition,
}: {
  song: Song;
  duration: number;
  clips: PatchClip[];
  /** Section names, drawn faintly behind — what you place a change against. */
  markers: Song['markers'];
  onEdit: (clip: PatchClip) => void;
  onAddAt: (bar: number) => void;
  /** A clip dragged to a new bar. Only called when the bar actually changed. */
  onMove: (clip: PatchClip, bar: number) => void;
  /** A clip's end pulled about, giving it a length of its own. */
  onResize: (clip: PatchClip, lengthBars: number) => void;
  subscribePosition: (cb: (sec: number) => void) => () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);

  /**
   * The drag in progress.
   *
   * The ref is the truth and the state is only for drawing: a pointer can move
   * again before React has re-rendered, and reading the drag back out of state
   * would drop that move — which is every drag short enough to be one flick.
   *
   * It's mirrored into state at all because the lane has to reflow under the
   * finger. Every clip's width depends on where its neighbours are, so a clip
   * dragged past another has to push it along visibly, or you're aiming at a
   * layout that only appears once you let go.
   */
  const grab = useRef<{
    id: string;
    /** Moving the whole clip, or pulling its end about. */
    mode: 'move' | 'resize';
    startBar: number;
    /** Where the clip ended when the drag began, for a resize. */
    startEnd: number;
    bar: number;
    end: number;
    barOffset: number;
    x: number;
    moved: boolean;
  } | null>(null);
  const [drag, setDrag] = useState<
    { id: string; mode: 'move' | 'resize'; bar: number; end: number; moved: boolean } | null
  >(null);

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

  const lastBar = totalBars(duration, song);

  // What to draw: the clips as stored, with the dragged one where it is now.
  const shown = drag
    ? clips.map((c) =>
        c.id === drag.id
          ? drag.mode === 'resize'
            ? { ...c, lengthBars: Math.max(1, drag.end - c.bar) }
            : { ...c, bar: drag.bar }
          : c,
      )
    : clips;
  const spans = clipSpans(shown, lastBar);

  /** Bars are the grid, so a clip's edges land where the music does. */
  const pctOfBar = (bar: number) =>
    duration > 0 ? Math.max(0, Math.min(100, (barToSec(bar, song) / duration) * 100)) : 0;

  const barAtClientX = (clientX: number): number => {
    const el = ref.current;
    if (!el) return 1;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.max(1, Math.round(secToBar(ratio * duration, song)));
  };

  const startDrag = (
    e: ReactPointerEvent,
    clip: PatchClip,
    endBar: number,
    mode: 'move' | 'resize',
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Grab the clip where it was taken hold of rather than by its left edge, so
    // it doesn't jump under the finger on the first pixel of movement.
    const under = barAtClientX(e.clientX);
    grab.current = {
      id: clip.id,
      mode,
      startBar: clip.bar,
      startEnd: endBar,
      bar: clip.bar,
      end: endBar,
      barOffset: (mode === 'resize' ? endBar : clip.bar) - under,
      x: e.clientX,
      moved: false,
    };
    setDrag({ id: clip.id, mode, bar: clip.bar, end: endBar, moved: false });
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const held = grab.current;
    if (!held) return;
    held.moved = held.moved || Math.abs(e.clientX - held.x) > SLOP_PX;
    const at = Math.max(1, barAtClientX(e.clientX) + held.barOffset);
    if (held.mode === 'resize') {
      // An end must stay past its start, or the clip has no length at all.
      const end = Math.max(held.startBar + 1, at);
      if (end === held.end && !held.moved) return;
      held.end = end;
      setDrag({ id: held.id, mode: 'resize', bar: held.bar, end, moved: held.moved });
      return;
    }
    if (at === held.bar && !held.moved) return;
    held.bar = at;
    setDrag({ id: held.id, mode: 'move', bar: at, end: held.end, moved: held.moved });
  };

  const endDrag = () => {
    const held = grab.current;
    grab.current = null;
    setDrag(null);
    if (!held) return;
    /*
     * Measured against where the clip started, not against what's on screen —
     * the drawn clip is already at the dragged position, so comparing with that
     * would call every drag a tap.
     */
    const clip = clips.find((c) => c.id === held.id);
    if (!clip) return;

    if (held.mode === 'resize') {
      if (held.moved && held.end !== held.startEnd) onResize(clip, held.end - clip.bar);
      return;
    }
    if (!held.moved || held.bar === held.startBar) onEdit(clip);
    else onMove(clip, held.bar);
  };

  /**
   * The keyboard's version of the same gestures. Enter opens the clip, which
   * the pointer does on release — a button's own click no longer carries that,
   * since telling a tap from a drag has to wait for the pointer to come up.
   */
  const onKey = (e: React.KeyboardEvent, clip: PatchClip) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onEdit(clip);
      return;
    }
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    const bar = Math.max(1, clip.bar + step * (e.shiftKey ? 4 : 1));
    if (bar !== clip.bar) onMove(clip, bar);
  };

  return (
    <div
      className="patch-lane"
      ref={ref}
      // Empty space is where a new one goes: tapping the gap after the second
      // chorus is how you'd say it out loud, so it's how you do it here.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.patch-clip-wrap')) return;
        onAddAt(barAtClientX(e.clientX));
      }}
      role="group"
      aria-label="Patch changes"
    >
      {markers.map((marker) => (
        <div key={marker.id} className="patch-marker" style={{ left: `${pctOfBar(marker.bar)}%` }}>
          <span>{marker.name}</span>
        </div>
      ))}

      {spans.map(({ clip, endBar, ownEnd }) => {
        const left = pctOfBar(clip.bar);
        const width = Math.max(pctOfBar(endBar) - left, 1.5);
        const dragging = drag?.id === clip.id && drag.moved;
        return (
          <div
            key={clip.id}
            className={ownEnd ? 'patch-clip-wrap ends' : 'patch-clip-wrap'}
            style={{ left: `${left}%`, width: `${width}%` }}
          >
            <button
              className={dragging ? 'patch-clip dragging' : 'patch-clip'}
              onPointerDown={(e) => startDrag(e, clip, endBar, 'move')}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={() => {
                grab.current = null;
                setDrag(null);
              }}
              onKeyDown={(e) => onKey(e, clip)}
              title={
                `Bar ${clip.bar} — ${describePatch(clip.patch)}. ` +
                (ownEnd ? `Ends at bar ${endBar}. ` : '') +
                'Drag to move it.'
              }
            >
              <span className="patch-clip-bar">
                {clip.bar}
                {ownEnd ? `–${endBar}` : ''}
              </span>
              <span className="patch-clip-name">
                {clip.patch.source ?? describePatch(clip.patch)}
              </span>
            </button>
            {/*
              Pulling the end about is how a change gets undone — a boost for
              eight bars, a stomp on for the chorus. Its own handle rather than
              a hot edge on the clip, so moving one never resizes it by accident.
            */}
            <span
              className="patch-clip-end"
              role="button"
              tabIndex={-1}
              aria-label={`Set how long ${clip.patch.source ?? 'this change'} lasts`}
              title={ownEnd ? `Ends at bar ${endBar}. Drag to change.` : 'Drag to give it a length'}
              onPointerDown={(e) => startDrag(e, clip, endBar, 'resize')}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={() => {
                grab.current = null;
                setDrag(null);
              }}
            />
          </div>
        );
      })}

      {clips.length === 0 && (
        <span className="patch-lane-empty">
          Nothing sent yet — tap anywhere along here to add a patch change.
        </span>
      )}

      <div className="playhead" ref={playheadRef} />
    </div>
  );
}

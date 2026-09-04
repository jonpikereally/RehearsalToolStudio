import { useRef, useState } from 'react';
import { formatPan } from '../lib/stemMix';

/**
 * Pan, as the knob it is on every desk ever built.
 *
 * A slider says "somewhere along a line"; pan is an angle either side of
 * centre, and a knob says that without needing a label. It also takes a
 * quarter of the width, which is what makes a channel strip possible.
 *
 * Dragging is vertical, not circular: circular knobs are miserable to control
 * with a mouse, and every DAW settled on up-for-more decades ago. Hold shift
 * for fine movement, double-click to centre, and the arrow keys do the same
 * job for anyone not using a pointer.
 */

/** Pixels of travel for the full sweep, hard left to hard right. */
const TRAVEL = 160;
/** The knob's sweep, either side of straight up. A desk's is about this. */
const SWEEP = 135;

export default function PanDial({
  value,
  onChange,
  label,
  size = 34,
}: {
  value: number;
  /**
   * Absolute where the move knows where it is going, and an updater where it
   * is relative — held keys repeat far faster than the mixer re-renders, and a
   * step taken from `value` would be a step taken from where the knob was
   * several presses ago. The updater is handed the live figure.
   */
  onChange: (pan: number | ((current: number) => number)) => void;
  /** The channel's name, for the accessible label. */
  label: string;
  size?: number;
}) {
  const drag = useRef<{ y: number; from: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = (pan: number) => Math.max(-1, Math.min(1, pan));
  // Snap the last couple of percent to dead centre. A pan of L1 is inaudible
  // and unintended, and a knob you cannot put back is infuriating.
  const settle = (pan: number) => (Math.abs(pan) < 0.02 ? 0 : clamp(pan));

  const onPointerDown = (e: React.PointerEvent) => {
    /*
     * No preventDefault here, however tempting. It suppresses the mouse events
     * the pointer sequence would otherwise produce — click and dblclick among
     * them — and double-click to centre is the one gesture a knob must have.
     * `touch-action: none` and `user-select: none` in the stylesheet do the
     * jobs preventDefault was there for.
     */
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, from: value };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    // Up is right, as it is on a fader and on every knob that has ever been
    // turned clockwise.
    const travelled = (drag.current.y - e.clientY) / TRAVEL;
    onChange(settle(drag.current.from + travelled * 2 * (e.shiftKey ? 0.25 : 1)));
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.01 : 0.05;
    const nudge = (by: number) => {
      e.preventDefault();
      onChange((current) => settle(current + by));
    };
    const go = (pan: number) => {
      e.preventDefault();
      onChange(settle(pan));
    };
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nudge(step);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nudge(-step);
    if (e.key === 'Home') go(-1);
    if (e.key === 'End') go(1);
    // The one thing a knob must always be able to do.
    if (e.key === 'Backspace' || e.key === 'Delete') go(0);
  };

  const angle = clamp(value) * SWEEP;
  const centre = size / 2;
  const radius = centre - 3;

  /** Polar to cartesian with zero straight up, which is where centre pan is. */
  const at = (degrees: number, r: number): [number, number] => {
    const rad = ((degrees - 90) * Math.PI) / 180;
    return [centre + r * Math.cos(rad), centre + r * Math.sin(rad)];
  };
  const arc = (from: number, to: number): string => {
    const [x0, y0] = at(from, radius);
    const [x1, y1] = at(to, radius);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweep = to > from ? 1 : 0;
    return `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} ${sweep} ${x1} ${y1}`;
  };
  const [px, py] = at(angle, radius - 4);

  return (
    <span
      className={dragging ? 'pan-dial dragging' : 'pan-dial'}
      role="slider"
      tabIndex={0}
      aria-label={`${label} pan`}
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
      aria-valuetext={formatPan(value)}
      title={`Pan — drag up and down, double-click to centre (${formatPan(value)})`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onChange(0)}
      onKeyDown={onKeyDown}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <path className="pan-dial-track" d={arc(-SWEEP, SWEEP)} />
        {/* The travel from centre, so how far off you are reads at a glance. */}
        {Math.abs(angle) > 1 && <path className="pan-dial-amount" d={arc(0, angle)} />}
        <line className="pan-dial-pointer" x1={centre} y1={centre} x2={px} y2={py} />
        <circle className="pan-dial-cap" cx={centre} cy={centre} r={2.2} />
      </svg>
    </span>
  );
}

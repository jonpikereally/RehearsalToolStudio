import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A small menu at the pointer.
 *
 * Fixed rather than absolute so it can't be clipped by whatever it was opened
 * from, and nudged back inside the viewport when it would run off the edge —
 * a menu opened from the last chip in a row otherwise opens half off-screen.
 */

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Shown in red, and separated from what comes before it. */
  danger?: boolean;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

export default function ContextMenu({
  at,
  items,
  onClose,
  label,
}: {
  at: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      x: Math.max(margin, Math.min(at.x, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(at.y, window.innerHeight - height - margin)),
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // `pointerdown` rather than click, so the menu is gone before whatever is
    // underneath has a chance to react to the press.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onClose);
    // Capture, so a scroll inside any pane closes it rather than leaving it
    // hanging over unrelated content.
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return (
    <div
      className="ctx-menu"
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? 'ctx-item danger' : 'ctx-item'}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

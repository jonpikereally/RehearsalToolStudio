import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

/**
 * The bar at the top of a movable block: a grip to drag it, a disclosure arrow
 * to fold it away, and room on the right for the block's own controls.
 */

export interface BlockChrome {
  collapsed: boolean;
  onToggle: () => void;
  onDragStart: (e: ReactPointerEvent) => void;
  dragging: boolean;
}

export default function BlockHead({
  title,
  chrome,
  extra,
}: {
  title: string;
  chrome: BlockChrome;
  /** Controls belonging to this block, shown only while it's open. */
  extra?: ReactNode;
}) {
  return (
    <div className="block-head">
      <span
        className="grip"
        onPointerDown={chrome.onDragStart}
        role="button"
        tabIndex={-1}
        aria-label={`Drag to move ${title}`}
        title="Drag to move this block"
      >
        ⠿
      </span>
      <button
        className="block-toggle"
        onClick={chrome.onToggle}
        aria-expanded={!chrome.collapsed}
        title={chrome.collapsed ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`}
      >
        <span className={chrome.collapsed ? 'arrow' : 'arrow open'} aria-hidden>
          ▸
        </span>
        {title}
      </button>
      {!chrome.collapsed && extra}
    </div>
  );
}

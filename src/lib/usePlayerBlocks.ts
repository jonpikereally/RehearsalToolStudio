import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { DEFAULT_ORDER, blockOrder, isCollapsed, setBlockOrder, setCollapsed, type BlockId } from './pageLayout';
import type { BlockChrome } from '../ui/BlockHead';

/**
 * Arranging and folding the player's blocks.
 *
 * The drag works like the stem list: the order rearranges under the finger as
 * it crosses each block's box, and is written out on release, so a drag that is
 * abandoned costs nothing.
 */
export interface PlayerBlocks {
  order: BlockId[];
  chromeFor: (id: BlockId) => BlockChrome;
  refFor: (id: BlockId) => (el: HTMLDivElement | null) => void;
  onMove: (e: ReactPointerEvent) => void;
  endDrag: () => void;
}

export function usePlayerBlocks(songId: string): PlayerBlocks {
  const [saved, setSaved] = useState<BlockId[]>(blockOrder);
  const [dragOrder, setDragOrder] = useState<BlockId[] | null>(null);
  const [draggingId, setDraggingId] = useState<BlockId | null>(null);
  const [collapsed, setCollapsedState] = useState<BlockId[]>([]);
  const refs = useRef(new Map<BlockId, HTMLDivElement>());

  // Folding is per song, so a new song brings its own.
  useEffect(() => {
    if (!songId) return;
    setCollapsedState(DEFAULT_ORDER.filter((id) => isCollapsed(songId, id)));
  }, [songId]);

  const order = dragOrder ?? saved;

  const refFor = useCallback(
    (id: BlockId) => (el: HTMLDivElement | null) => {
      if (el) refs.current.set(id, el);
      else refs.current.delete(id);
    },
    [],
  );

  const startDrag = useCallback(
    (id: BlockId) => (e: ReactPointerEvent) => {
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDraggingId(id);
      setDragOrder(blockOrder());
    },
    [],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!draggingId || !dragOrder) return;
      const y = e.clientY;
      let over = -1;
      dragOrder.forEach((id, index) => {
        const rect = refs.current.get(id)?.getBoundingClientRect();
        if (rect && y >= rect.top && y <= rect.bottom) over = index;
      });

      const from = dragOrder.indexOf(draggingId);
      if (over < 0 || over === from) return;
      const next = [...dragOrder];
      next.splice(over, 0, next.splice(from, 1)[0]);
      setDragOrder(next);
    },
    [draggingId, dragOrder],
  );

  const endDrag = useCallback(() => {
    if (dragOrder && draggingId) {
      setBlockOrder(dragOrder);
      setSaved(dragOrder);
    }
    setDraggingId(null);
    setDragOrder(null);
  }, [dragOrder, draggingId]);

  const chromeFor = useCallback(
    (id: BlockId): BlockChrome => ({
      collapsed: collapsed.includes(id),
      dragging: draggingId === id,
      onDragStart: startDrag(id),
      onToggle: () => {
        const nowCollapsed = !collapsed.includes(id);
        if (songId) setCollapsed(songId, id, nowCollapsed);
        setCollapsedState((prev) => (nowCollapsed ? [...prev, id] : prev.filter((b) => b !== id)));
      },
    }),
    [collapsed, draggingId, startDrag, songId],
  );

  return { order, chromeFor, refFor, onMove, endDrag };
}

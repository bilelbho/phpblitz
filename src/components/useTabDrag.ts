// Dragging tabs: the tab lifts into a floating card that follows the pointer, the
// other tabs slide apart where it would land, and dropping moves it there. Dragged away from the
// strip, the owner can offer drop zones (the terminal splits that way).
// Pointer events, not HTML5 drag and drop: the desktop web view keeps that for files.

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface TabDrag {
  id: string;
  from: number;
  /** Where it would land (index among all tabs). */
  to: number;
  /** Pointer position, and where the card was grabbed. */
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  width: number;
  height: number;
  /** Pulled away from the strip (drop zones instead of reordering). */
  outside: boolean;
}

interface Options {
  ids: string[];
  strip: RefObject<HTMLElement | null>;
  onMove: (from: number, to: number) => void;
  /** Dragging away from the strip: highlight a drop zone; return true from drop when handled. */
  outside?: { over: (x: number, y: number) => void; drop: (id: string, x: number, y: number) => boolean; leave: () => void };
  disabled?: boolean;
}

const THRESHOLD = 4;
const OUTSIDE = 26;

export function useTabDrag({ ids, strip, onMove, outside, disabled }: Options) {
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const latest = useRef({ ids, onMove, outside });
  latest.current = { ids, onMove, outside };
  /** Tab boxes when the drag started (before anything shifted). */
  const boxes = useRef<{ id: string; left: number; width: number }[]>([]);
  const gap = useRef(4);

  // After a drag, the click that follows pointerup must not select the tab under the pointer.
  const swallowClick = () => {
    const stop = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
  };

  const start = (e: React.PointerEvent, id: string) => {
    if (disabled || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button.tab-close, .term-tab-close, input')) return;
    const el = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    let current: TabDrag | null = null;

    const move = (ev: PointerEvent) => {
      if (!current) {
        if (Math.abs(ev.clientX - startX) < THRESHOLD && Math.abs(ev.clientY - startY) < THRESHOLD) return;
        const tabs = [...(strip.current?.querySelectorAll<HTMLElement>('[data-drag-id]') ?? [])];
        boxes.current = tabs.map((t) => {
          const r = t.getBoundingClientRect();
          return { id: t.dataset.dragId!, left: r.left, width: r.width };
        });
        const b = boxes.current;
        gap.current = b.length > 1 ? Math.max(0, b[1].left - (b[0].left + b[0].width)) : 4;
        const from = latest.current.ids.indexOf(id);
        current = { id, from, to: from, x: ev.clientX, y: ev.clientY, grabX: startX - el.left, grabY: startY - el.top, width: el.width, height: el.height, outside: false };
      }
      const box = strip.current?.getBoundingClientRect();
      const isOutside = !!latest.current.outside && !!box && (ev.clientY < box.top - OUTSIDE || ev.clientY > box.bottom + OUTSIDE);
      let to = current.from;
      if (!isOutside) {
        // Its new place: how many other tabs have their middle left of the pointer.
        to = boxes.current.filter((b) => b.id !== id && b.left + b.width / 2 < ev.clientX).length;
      }
      if (isOutside) latest.current.outside?.over(ev.clientX, ev.clientY);
      else if (current.outside) latest.current.outside?.leave();
      current = { ...current, x: ev.clientX, y: ev.clientY, to, outside: isOutside };
      setDrag(current);
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (!current) return;
      swallowClick();
      const done = current;
      current = null;
      setDrag(null);
      if (done.outside) {
        latest.current.outside?.leave();
        latest.current.outside?.drop(done.id, ev.clientX, ev.clientY);
      } else if (done.to !== done.from) {
        latest.current.onMove(done.from, done.to);
      }
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (current?.outside) latest.current.outside?.leave();
      current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  // Escape cancels a drag.
  useEffect(() => {
    if (!drag) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        latest.current.outside?.leave();
        setDrag(null);
        window.dispatchEvent(new PointerEvent('pointercancel'));
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [drag]);

  /** How far a tab slides to open the gap (px), and whether it is the one being dragged. */
  const shiftOf = (id: string): { x: number; dragged: boolean } => {
    if (!drag) return { x: 0, dragged: false };
    if (id === drag.id) return { x: 0, dragged: true };
    const i = latest.current.ids.indexOf(id);
    const w = drag.width + gap.current;
    if (drag.outside) return { x: 0, dragged: false };
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return { x: -w, dragged: false };
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return { x: w, dragged: false };
    return { x: 0, dragged: false };
  };

  return { drag, start, shiftOf };
}

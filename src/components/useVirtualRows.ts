// Renders only the rows of a long list that are in view (plus a margin), inside an existing scroll
// container. Rows have a fixed height; the list may sit below other content in the container.

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

const OVERSCAN = 12;

/**
 * `list` is the element the rows are rendered in (inside `scroller`). Returns the range to render and
 * the spacer heights above and below it.
 */
export function useVirtualRows(scroller: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, count: number, rowHeight: number) {
  const [view, setView] = useState({ top: 0, height: 800 });
  const attached = useRef<{ el: HTMLElement; detach: () => void } | null>(null);

  // The scroller may render after this component mounts (or be replaced): attach to whichever
  // element is current after each render.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (attached.current?.el === el) return;
    attached.current?.detach();
    attached.current = null;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Where the list starts inside the scroller's content.
      const offset = list.current ? list.current.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
      setView((v) => {
        const next = { top: el.scrollTop - offset, height: el.clientHeight };
        return v.top === next.top && v.height === next.height ? v : next;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    attached.current = {
      el,
      detach: () => {
        el.removeEventListener('scroll', schedule);
        ro.disconnect();
        cancelAnimationFrame(frame);
      },
    };
  });
  useLayoutEffect(() => () => attached.current?.detach(), []);

  const start = Math.max(0, Math.min(count, Math.floor(view.top / rowHeight) - OVERSCAN));
  const end = Math.max(start, Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN));
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight };
}

/** Scrolls `scroller` so row `index` of the list is visible. */
export function scrollRowIntoView(scroller: HTMLElement | null, list: HTMLElement | null, index: number, rowHeight: number) {
  if (!scroller || index < 0) return;
  const offset = list ? list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
  const top = offset + index * rowHeight;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + rowHeight - scroller.clientHeight;
}

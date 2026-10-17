// Renders only the rows of a long list that are in view (plus a margin), inside an existing scroll
// container. Rows have a fixed height; the list may sit below other content in the container.
//
// The range is computed from the scroller's live scroll position on every render (never from a
// remembered one), and re-checked after each commit: if the position changed meanwhile (content
// shrank and the browser clamped it, the panel was hidden and shown, a frame was skipped while the
// window was in the background) the list renders again instead of showing an empty band.

import { useLayoutEffect, useReducer, useRef, type RefObject } from 'react';

const OVERSCAN = 12;
/** The range moves in steps of this many rows (less than OVERSCAN, so nothing shows blank): a scroll
 * within a step doesn't re-render the list. */
const STEP = 6;

function rangeOf(scroller: HTMLElement | null, list: HTMLElement | null, count: number, rowHeight: number) {
  let top = 0;
  let height = 800;
  if (scroller) {
    // Where the list starts inside the scroller's content.
    const offset = list ? list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
    top = scroller.scrollTop - offset;
    height = scroller.clientHeight || height;
  }
  const first = Math.floor((Math.floor(top / rowHeight) - OVERSCAN) / STEP) * STEP;
  const last = Math.ceil((Math.ceil((top + height) / rowHeight) + OVERSCAN) / STEP) * STEP;
  const start = Math.max(0, Math.min(count, first));
  const end = Math.max(start, Math.min(count, last));
  return { start, end };
}

/**
 * `list` is the element the rows are rendered in (inside `scroller`). Returns the range to render and
 * the spacer heights above and below it.
 */
export function useVirtualRows(scroller: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, count: number, rowHeight: number) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const attached = useRef<{ el: HTMLElement; detach: () => void } | null>(null);

  const { start, end } = rangeOf(scroller.current, list.current, count, rowHeight);
  const latest = useRef({ start, end, count, rowHeight });
  latest.current = { start, end, count, rowHeight };

  useLayoutEffect(() => {
    // Attach to whichever scroller is current (it may render after this component, or be replaced).
    const el = scroller.current;
    if (attached.current?.el !== el) {
      attached.current?.detach();
      attached.current = null;
      if (el) {
        // Only when the rows to show change, not on every scroll event.
        const onScroll = () => {
          const now = rangeOf(el, list.current, latest.current.count, latest.current.rowHeight);
          if (now.start !== latest.current.start || now.end !== latest.current.end) rerender();
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        const ro = new ResizeObserver(onScroll);
        ro.observe(el);
        attached.current = {
          el,
          detach: () => {
            el.removeEventListener('scroll', onScroll);
            ro.disconnect();
          },
        };
      }
    }
    // The position may have moved during this commit: render again if the range is now different.
    const now = rangeOf(el, list.current, count, rowHeight);
    if (now.start !== start || now.end !== end) rerender();
  });
  useLayoutEffect(() => () => attached.current?.detach(), []);

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

// The caret position in the active editor. It changes on every arrow key, so it lives outside the
// workspace state: only the components that show it (status bar, Structure) re-render.

import { useSyncExternalStore } from 'react';

export interface Cursor {
  line: number;
  col: number;
}

let cursor: Cursor = { line: 1, col: 1 };
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setCursor(next: Cursor) {
  if (next.line === cursor.line && next.col === cursor.col) return;
  cursor = next;
  listeners.forEach((l) => l());
}

/** The current position, for code that reads it once (Run to Cursor). */
export function getCursor(): Cursor {
  return cursor;
}

/** Line and column; re-renders on every caret move. */
export function useCursor(): Cursor {
  return useSyncExternalStore(subscribe, getCursor);
}

/** The line only: re-renders when the caret moves to another line. */
export function useCursorLine(): number {
  return useSyncExternalStore(subscribe, () => cursor.line);
}

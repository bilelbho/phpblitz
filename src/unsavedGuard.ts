// Before the window closes or the project changes: unsaved files are saved, dropped or keep it open.
// The open workspace registers the question; with no project open there is nothing to ask.

let guard: (() => Promise<boolean>) | null = null;
let asking: Promise<boolean> | null = null;

export function setUnsavedGuard(g: (() => Promise<boolean>) | null) {
  guard = g;
}

/** True when the caller may close the window or the project (asked once, however often it's called). */
export function confirmLeave(): Promise<boolean> {
  if (!guard) return Promise.resolve(true);
  asking ??= guard().finally(() => (asking = null));
  return asking;
}

// Background work the way IntelliJ's "daemon" schedules it: a file shows up first, analysis runs
// once the editor has been quiet for a moment, one analysis at a time, newest text only, the
// active file first, and work for files the user already left is dropped. Low-priority work
// (indexing) yields to the user: it waits while files are being opened or typed in.

/** IntelliJ's default auto-reparse delay. */
export const ANALYSIS_DELAY = 300;

/** Above this size (characters), files get no code insight (IntelliJ: idea.max.intellisense.filesize, 2.5 MB). */
export const CODE_INSIGHT_LIMIT = 2_500_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves when the browser has idle time (or after `timeout` ms). */
export function whenIdle(timeout = 1000): Promise<void> {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number }).requestIdleCallback;
  return new Promise((resolve) => (ric ? ric(() => resolve(), { timeout }) : setTimeout(resolve, 16)));
}

let busyUntil = 0;

/** The user is doing something (opening a file, typing): low-priority work waits a little. */
export function markBusy(ms = 500) {
  busyUntil = Math.max(busyUntil, performance.now() + ms);
}

/** Await before each chunk of low-priority work. */
export async function lowPriority(): Promise<void> {
  for (;;) {
    const wait = busyUntil - performance.now();
    if (wait > 0) await sleep(Math.min(wait, 500));
    await whenIdle();
    if (busyUntil <= performance.now()) return;
  }
}

/**
 * Analysis requests: per file only the latest text is kept; one runs at a time; the file
 * `first()` names goes first; files `wanted()` no longer accepts are skipped.
 */
export class AnalysisQueue {
  private pending = new Map<string, string>();
  private timer = 0;
  private running = false;

  constructor(
    private run: (path: string, text: string) => Promise<void>,
    private first: () => string | null,
    private wanted: (path: string) => boolean,
  ) {}

  request(path: string, text: string, delay = ANALYSIS_DELAY) {
    this.pending.delete(path);
    this.pending.set(path, text); // newest last
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.pump(), delay);
  }

  drop(path: string) {
    this.pending.delete(path);
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size) {
        const active = this.first();
        const path = active && this.pending.has(active) ? active : [...this.pending.keys()].pop()!;
        const text = this.pending.get(path)!;
        this.pending.delete(path);
        if (!this.wanted(path)) continue;
        await this.run(path, text).catch(() => {});
      }
    } finally {
      this.running = false;
    }
  }
}

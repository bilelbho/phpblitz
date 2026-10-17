// Startup Performance (Help ▸ Startup Performance…): when each stage of opening the project
// started, how long it took and what it handled, so a slow project can be reported with numbers.
// Times are in ms from the moment the project was opened.

import { useSyncExternalStore } from 'react';

export interface Span {
  name: string;
  start: number;
  /** null while running. */
  end: number | null;
  detail: string;
}

class Perf {
  private t0 = performance.now();
  project = '';
  spans: Span[] = [];
  /** The report dialog is open. */
  open = false;
  private once = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;

  /** A project starts opening: the clock restarts. */
  begin(project: string) {
    this.t0 = performance.now();
    this.project = project;
    this.spans = [];
    this.once.clear();
    this.emit();
  }

  private now = () => Math.round(performance.now() - this.t0);

  /** Times a stage; `detail` describes its result ("5,628 files, 12 parsed"). */
  async time<T>(name: string, work: Promise<T>, detail?: (result: T) => string): Promise<T> {
    const span: Span = { name, start: this.now(), end: null, detail: '' };
    this.spans.push(span);
    this.emit();
    try {
      const result = await work;
      span.detail = detail?.(result) ?? '';
      return result;
    } catch (e) {
      span.detail = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      throw e;
    } finally {
      span.end = this.now();
      this.emit();
    }
  }

  /** Something that happened at one moment ("Workspace shown"). Only the first one counts. */
  mark(name: string, detail = '') {
    if (this.once.has(name)) return;
    this.once.add(name);
    const at = this.now();
    this.spans.push({ name, start: at, end: at, detail });
    this.emit();
  }

  /** A stage measured elsewhere, by its own clock readings (performance.now()). */
  record(name: string, startedAt: number, endedAt: number, detail = '') {
    this.spans.push({ name, start: Math.round(startedAt - this.t0), end: Math.round(endedAt - this.t0), detail });
    // Keep the report readable: the startup stages and the last 30 other entries.
    const opens = this.spans.filter((s) => s.name.startsWith('Open '));
    if (opens.length > 30) this.spans = this.spans.filter((s) => s !== opens[0]);
    this.emit();
  }

  show(open: boolean) {
    this.open = open;
    this.emit();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = () => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }
}

export const perf = new Perf();

export function usePerf(): Perf {
  useSyncExternalStore(perf.subscribe, perf.snapshot);
  return perf;
}

/** How long the window took to be ready after launch (the app's own code loaded and run). */
export function windowReadyMs(): number | null {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return nav ? Math.round(nav.domContentLoadedEventEnd) : null;
}

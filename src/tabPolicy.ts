// Editor tab rules from Settings ▸ Editor ▸ General ▸ Editor Tabs: where new tabs go, which tabs
// close when there are too many, and which tab becomes active when the current one closes.

import type { TabSettings } from './settings';

interface TabLike {
  id: string;
  kind: string;
  path?: string;
}

const nameOf = (t: TabLike) => (t.path ?? t.id).split('/').pop()!.toLowerCase();

/** Where a new tab goes: sorted, at the end, or right after the current tab. */
export function insertTab<T extends TabLike>(tabs: T[], tab: T, activeId: string | null, s: TabSettings): T[] {
  if (s.sortAlphabetically) {
    const at = tabs.findIndex((t) => nameOf(t).localeCompare(nameOf(tab)) > 0);
    return at < 0 ? [...tabs, tab] : [...tabs.slice(0, at), tab, ...tabs.slice(at)];
  }
  const current = tabs.findIndex((t) => t.id === activeId);
  if (s.openAtEnd || current < 0) return [...tabs, tab];
  return [...tabs.slice(0, current + 1), tab, ...tabs.slice(current + 1)];
}

/**
 * Tabs to close when there are more than the limit: never the active tab or unsaved files.
 * "Close unchanged" takes them from the left; "Close unused" takes the least recently used.
 */
export function overLimit<T extends TabLike>(tabs: T[], s: TabSettings, activeId: string | null, isDirty: (t: T) => boolean, recent: string[]): string[] {
  const extra = tabs.length - Math.max(1, s.limit);
  if (extra <= 0) return [];
  const closable = tabs.filter((t) => t.id !== activeId && !isDirty(t));
  const rank = (t: T) => {
    const i = t.path ? recent.indexOf(t.path) : -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const order = s.overLimit === 'unused' ? [...closable].sort((a, b) => rank(b) - rank(a)) : closable;
  return order.slice(0, extra).map((t) => t.id);
}

/** The tab to activate after closing `closing` (which includes the active tab). */
export function nextActive<T extends TabLike>(tabs: T[], closing: string[], activeId: string | null, s: TabSettings, recent: string[]): string | null {
  const rest = tabs.filter((t) => !closing.includes(t.id));
  if (!rest.length) return null;
  if (!activeId || !closing.includes(activeId)) return activeId;
  if (s.activateOnClose === 'recent') {
    for (const path of recent) {
      const hit = rest.find((t) => t.path === path);
      if (hit) return hit.id;
    }
  }
  const at = tabs.findIndex((t) => t.id === activeId);
  const after = tabs.slice(at + 1).find((t) => !closing.includes(t.id));
  const before = tabs.slice(0, at).reverse().find((t) => !closing.includes(t.id));
  return (s.activateOnClose === 'right' ? after ?? before : before ?? after)?.id ?? rest[0].id;
}

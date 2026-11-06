// Changelists: the Commit panel's changes in named groups, committed separately. "Changes" is the
// default list; a file in no other list is in the active one (new changes land there). Kept per
// project on this machine (localStorage), never in the repository.

import { useSyncExternalStore } from 'react';

export interface Changelist {
  id: string;
  name: string;
}

interface State {
  lists: Changelist[];
  /** Relative path → list id (files of the default list aren't stored). */
  files: Record<string, string>;
  active: string;
}

export const DEFAULT_LIST: Changelist = { id: 'default', name: 'Changes' };
const EMPTY: State = { lists: [DEFAULT_LIST], files: {}, active: DEFAULT_LIST.id };

const cache = new Map<string, State>();
const listeners = new Set<() => void>();
const key = (root: string) => `phpblitz.changelists:${root}`;

function load(root: string): State {
  let s = cache.get(root);
  if (!s) {
    try {
      const raw = JSON.parse(localStorage.getItem(key(root)) ?? 'null') as State | null;
      s = raw && Array.isArray(raw.lists) ? { ...raw, lists: [DEFAULT_LIST, ...raw.lists.filter((l) => l.id !== DEFAULT_LIST.id)] } : EMPTY;
    } catch {
      s = EMPTY;
    }
    cache.set(root, s);
  }
  return s;
}

function save(root: string, s: State) {
  cache.set(root, s);
  try {
    localStorage.setItem(key(root), JSON.stringify({ ...s, lists: s.lists.filter((l) => l.id !== DEFAULT_LIST.id) }));
  } catch {
    // Only a convenience.
  }
  listeners.forEach((l) => l());
}

/** The project's lists now (outside React). */
export const changelistsOf = (root: string): State => load(root);

export function useChangelists(root: string): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => load(root),
  );
}

/** The list a changed file is in: its own, or the active list. */
export function listOf(s: State, rel: string): string {
  const id = s.files[rel];
  return id && s.lists.some((l) => l.id === id) ? id : s.lists.some((l) => l.id === s.active) ? s.active : DEFAULT_LIST.id;
}

export function addList(root: string, name: string, files: string[] = []): string {
  const s = load(root);
  const id = `cl${Date.now().toString(36)}`;
  save(root, { ...s, lists: [...s.lists, { id, name: name.trim() }], files: { ...s.files, ...Object.fromEntries(files.map((f) => [f, id])) } });
  return id;
}

export function renameList(root: string, id: string, name: string) {
  const s = load(root);
  save(root, { ...s, lists: s.lists.map((l) => (l.id === id ? { ...l, name: name.trim() } : l)) });
}

/** The list goes; its files go back to the default list. */
export function deleteList(root: string, id: string) {
  if (id === DEFAULT_LIST.id) return;
  const s = load(root);
  save(root, {
    lists: s.lists.filter((l) => l.id !== id),
    files: Object.fromEntries(Object.entries(s.files).filter(([, l]) => l !== id)),
    active: s.active === id ? DEFAULT_LIST.id : s.active,
  });
}

export function moveToList(root: string, files: string[], id: string) {
  const s = load(root);
  const next = { ...s.files };
  for (const f of files) {
    if (id === DEFAULT_LIST.id && s.active === DEFAULT_LIST.id) delete next[f];
    else next[f] = id;
  }
  save(root, { ...s, files: next });
}

/** New changes land in this list from now on; `changed` (relative paths) stay where they are. */
export function setActiveList(root: string, id: string, changed: string[]) {
  const s = load(root);
  // Files in the old active list only because it was active: placed there for good.
  const files = { ...s.files };
  for (const f of changed) if (!files[f]) files[f] = listOf(s, f);
  save(root, { ...s, files, active: id });
}

/** Files committed or reverted leave their lists (a new change to them lands in the active list). */
export function forgetFiles(root: string, changed: Set<string>) {
  const s = load(root);
  const kept = Object.fromEntries(Object.entries(s.files).filter(([f]) => changed.has(f)));
  if (Object.keys(kept).length !== Object.keys(s.files).length) save(root, { ...s, files: kept });
}

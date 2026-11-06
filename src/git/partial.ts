// Partial commits: changes of a file left out of the next commit (the checkboxes in the diff view).
// A change is named by its text, so the choice survives edits elsewhere in the file. What's
// committed is HEAD's text with only the included changes applied.

import { useSyncExternalStore } from 'react';
import { lineChanges, type LineChange } from './textDiff';

/** path → the left-out changes' names. */
let excluded = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

/** A change's name: what it replaces and with what (and which time that pair occurs, for repeats). */
export function changeKeys(head: string[], work: string[]): { change: LineChange; key: string }[] {
  const seen = new Map<string, number>();
  return lineChanges(head, work).map((change) => {
    const text = `${head.slice(change.a0, change.a1).join('\n')}\u0000${work.slice(change.b0, change.b1).join('\n')}`;
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return { change, key: `${n}\u0001${text}` };
  });
}

/** The file's text with only the included changes applied to HEAD's (lines joined with `eol`). */
export function contentToCommit(head: string[], work: string[], left: ReadonlySet<string>, eol = '\n'): string {
  const out: string[] = [];
  let a = 0;
  for (const { change, key } of changeKeys(head, work)) {
    out.push(...head.slice(a, change.a0));
    out.push(...(left.has(key) ? head.slice(change.a0, change.a1) : work.slice(change.b0, change.b1)));
    a = change.a1;
  }
  out.push(...head.slice(a));
  return out.join(eol);
}

export function excludedOf(path: string): ReadonlySet<string> {
  return excluded.get(path) ?? new Set();
}

function set(path: string, keys: ReadonlySet<string>) {
  excluded = new Map(excluded);
  if (keys.size) excluded.set(path, keys);
  else excluded.delete(path);
  listeners.forEach((l) => l());
}

/** Includes or leaves out changes of a file. */
export function includeChanges(path: string, keys: string[], included: boolean) {
  const next = new Set(excludedOf(path));
  for (const k of keys) {
    if (included) next.delete(k);
    else next.add(k);
  }
  set(path, next);
}

/** The whole file in or out of the commit again: no change left out. */
export function clearPartial(path: string) {
  if (excluded.has(path)) set(path, new Set());
}

/** Only some of the file's changes go in (as far as these names still match its changes). */
export function isPartial(path: string): boolean {
  return (excluded.get(path)?.size ?? 0) > 0;
}

export function usePartialCommits() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => excluded,
  );
}

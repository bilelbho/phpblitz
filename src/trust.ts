// Trusted projects. A project you haven't trusted opens in Restricted Mode: PHPBlitz reads and
// analyzes its code (Mago and the index run inside PHPBlitz) but starts no program in it: no Git,
// PHP, Composer, test runs or language server, until you trust it. The Rust side enforces it
// (src-tauri/src/trust.rs). Settings ▸ Trusted Projects can turn the question off.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getSettings } from './settings';
import { isTauri, recentProjects } from './platform';

const KEY = 'phpblitz.trustedFolders';

/** Forward slashes, no trailing slash; on Windows paths compare without case. */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const same = (a: string, b: string) => (/^[a-z]:/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
const within = (path: string, folder: string) => same(path, folder) || (path.length > folder.length && path[folder.length] === '/' && same(path.slice(0, folder.length), folder));

const listeners = new Set<() => void>();
let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) {
      // First run with trust: the projects already opened in PHPBlitz were trusted by opening them.
      cache = recentProjects().map(norm);
      write(cache);
    } else cache = (JSON.parse(raw) as string[]).map(norm);
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: string[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Not kept: the question comes again next time.
  }
  listeners.forEach((l) => l());
}

/** Folders trusted, each with every project inside it. */
export function trustedFolders(): string[] {
  return read();
}

export function isTrusted(root: string): boolean {
  if (!getSettings().security.restrictedMode) return true;
  const path = norm(root);
  return read().some((f) => within(path, f));
}

/** Trusts a project, or a folder and every project in it. */
export function trustFolder(folder: string) {
  const f = norm(folder);
  write([...read().filter((x) => !within(x, f)), f]);
}

export function untrustFolder(folder: string) {
  const f = norm(folder);
  write(read().filter((x) => !same(x, f)));
}

/** Re-renders when the trusted folders change. */
export function useTrustedFolders(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );
}

/** Tells the Rust side whether programs may run in this project. */
export async function restrictProject(root: string, restricted: boolean): Promise<void> {
  if (isTauri) await invoke('trust_restrict', { root, restricted }).catch(() => {});
}

/** The refusal the Rust side sends for a program in a restricted project. */
export const isRestrictedError = (e: unknown) => String(e).includes('Restricted Mode');

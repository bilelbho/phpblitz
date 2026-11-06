// State kept between sessions in the project's `.blitz/cache` (git-ignored, this machine's only):
// the HTTP Client's history, the last coverage report. Projects on disk only; elsewhere nothing is kept.

import { invoke } from '@tauri-apps/api/core';
import type { Backend } from './backend/types';
import { isTauri } from './platform';

export type CacheFile = 'http-client.json' | 'coverage.json';

const kept = (backend: Backend) => isTauri && backend.kind === 'disk';

/** The file's JSON, or null (none yet, unreadable, not a project on disk). */
export async function readCache<T>(backend: Backend, name: CacheFile): Promise<T | null> {
  if (!kept(backend)) return null;
  try {
    const text = await invoke<string | null>('blitz_cache_read', { root: backend.root, name });
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

export async function writeCache(backend: Backend, name: CacheFile, value: unknown): Promise<void> {
  if (!kept(backend)) return;
  await invoke('blitz_cache_write', { root: backend.root, name, text: JSON.stringify(value) }).catch(() => {});
}

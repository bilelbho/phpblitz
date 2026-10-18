// Updates from GitHub Releases: checked in the background at startup (and every few hours),
// downloaded silently, then the app offers to restart into the new version.
//
// The release workflow publishes latest.json next to the installers, with a signature for each
// one; the updater only installs files signed with the key whose public half is in tauri.conf.json.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isTauri } from './platform';
import { getSettings } from './settings';

export const RELEASES_URL = 'https://github.com/bilelbho/phpblitz/releases/latest';

export type UpdateState = (
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'downloading'; version: string; percent: number | null }
  /** Downloaded: restarting installs it. */
  | { kind: 'ready'; version: string; notes: string }
  /** Available, but this copy can't install it itself (the portable Windows zip). */
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'error'; message: string }
) & {
  /** The result of Help ▸ Check for Updates (shown even when there's nothing new). */
  manual?: boolean;
};

let state: UpdateState = { kind: 'idle' };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/**
 * Looks for a newer version and, when this copy can install it, downloads it. Background checks
 * stay quiet when nothing is found or GitHub can't be reached; `manual` reports either way.
 */
export async function checkForUpdates({ manual = false } = {}): Promise<UpdateState> {
  if (!isTauri) return state;
  if (state.kind === 'checking' || state.kind === 'downloading') return state;
  // Already found: say so again.
  if (state.kind === 'ready' || (state.kind === 'available' && !manual)) {
    if (manual) set({ ...state, manual });
    return state;
  }
  set({ kind: 'checking', manual });
  try {
    const update = await check();
    if (!update) {
      set({ kind: 'none', manual });
      return state;
    }
    const notes = update.body ?? '';
    if (!(await invoke<boolean>('updater_supported').catch(() => false))) {
      set({ kind: 'available', version: update.version, notes, manual });
      return state;
    }
    let total = 0;
    let received = 0;
    set({ kind: 'downloading', version: update.version, percent: null });
    await update.download((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      else if (event.event === 'Progress') {
        received += event.data.chunkLength;
        if (total) set({ kind: 'downloading', version: update.version, percent: Math.min(100, Math.round((received / total) * 100)) });
      }
    });
    pending = update;
    set({ kind: 'ready', version: update.version, notes, manual });
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e);
    // A failed background check isn't worth a notification: the next one may work.
    set(manual ? { kind: 'error', message, manual } : { kind: 'idle' });
  }
  return state;
}

/** Installs the downloaded update and starts the new version (Windows: the installer restarts it). */
export async function restartToUpdate(): Promise<void> {
  if (!pending) return;
  await pending.install();
  await relaunch();
}

const EVERY = 6 * 60 * 60 * 1000;
let started = false;

/** Background checks, unless turned off in Settings ▸ Appearance & Behavior ▸ Appearance. */
export function startUpdateChecks() {
  if (!isTauri || started) return;
  started = true;
  const run = () => {
    if (getSettings().ui.checkUpdates) void checkForUpdates();
  };
  // Not during startup: the project is loading.
  window.setTimeout(run, 15_000);
  window.setInterval(run, EVERY);
}

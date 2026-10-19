// Errors the user can't see otherwise: panels that crashed (ErrorBoundary) and background work that
// failed with nobody catching it. Help ▸ Diagnostic Tools ▸ Error Log shows them, with a copy to
// paste into a bug report.

import { useSyncExternalStore } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from './platform';

export interface LoggedError {
  id: number;
  time: Date;
  /** "Panel: Commit", "Unhandled error", "Background task". */
  where: string;
  message: string;
  stack?: string;
}

const MAX = 100;
let entries: LoggedError[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function changed() {
  entries = [...entries];
  listeners.forEach((l) => l());
}

/** Browser notices about layout timing, not errors of the app. */
const NOISE = [/ResizeObserver loop/i, /^Script error\.?$/];

export function logError(where: string, error: unknown, extraStack?: string) {
  const err = error instanceof Error ? error : null;
  const message = err ? `${err.name}: ${err.message}` : typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  if (NOISE.some((re) => re.test(message))) return;
  const stack = [err?.stack, extraStack].filter(Boolean).join('\n\nComponent stack:') || undefined;
  const now = new Date();
  // The same failure repeating (a timer, a render loop) is one entry; so is a panel crash React
  // also reports as unhandled: the panel's entry, which says where, replaces that one.
  const last = entries[entries.length - 1];
  if (last && last.message === message && (last.where === where || now.getTime() - last.time.getTime() < 2000)) {
    if (where.startsWith('Panel:') && !last.where.startsWith('Panel:')) {
      entries[entries.length - 1] = { ...last, where, stack: stack ?? last.stack };
      changed();
    }
    return;
  }
  entries.push({ id: nextId++, time: now, where, message, stack });
  if (entries.length > MAX) entries.shift();
  changed();
}

export function clearErrors() {
  entries = [];
  changed();
}

export function useErrorLog(): LoggedError[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => entries,
  );
}

let installed = false;

/** Catches what nothing else catches: errors thrown in callbacks, promises rejected unhandled. */
export function installErrorLog() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => logError('Unhandled error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => logError('Background task', e.reason));
}

let version = '';
if (isTauri) getVersion().then((v) => (version = v), () => {});

/** One header line about the app and the system, for reports. */
export function systemLine(): string {
  const ua = navigator.userAgent;
  const os = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : 'Linux';
  return `PHPBlitz ${version || '(browser)'} · ${os} · ${navigator.hardwareConcurrency} cores`;
}

/** Errors as plain text for a bug report. */
export function errorReport(list: LoggedError[] = entries): string {
  const lines = [systemLine(), ''];
  for (const e of list) {
    lines.push(`[${e.time.toLocaleTimeString()}] ${e.where}: ${e.message}`);
    if (e.stack) lines.push(e.stack.replace(/^/gm, '    '));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// The Focus layout as it was left: saved for each project as it changes (.blitz/workspace.json, this
// machine only), and the last one used for projects opened the first time. Presets: named layouts
// (Window ▸ Layouts, the top bar's list) for every project.

import { useSyncExternalStore } from 'react';
import { projectStorage } from './projectStorage';
import { FOCUS_START, focusStateFrom, type FocusState } from './toolLayout';

const projectKey = (root: string) => `phpblitz.focusLayout:${root}`;
const LAST_KEY = 'phpblitz.focusLayout.last';
const PRESETS_KEY = 'phpblitz.focusPresets';

function read(get: () => string | null): unknown {
  try {
    const text = get();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The project's layout, else the last one used anywhere, else the default. */
export function loadFocusLayout(root: string): FocusState {
  const saved = read(() => projectStorage.getItem(projectKey(root))) ?? read(() => localStorage.getItem(LAST_KEY));
  return saved ? focusStateFrom(saved) : FOCUS_START;
}

let timer = 0;
/** Saves the layout soon (a drag changes it on every mouse move). */
export function saveFocusLayout(root: string, state: FocusState) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const text = JSON.stringify(state);
    projectStorage.setItem(projectKey(root), text);
    try {
      localStorage.setItem(LAST_KEY, text);
    } catch {
      // Only a convenience.
    }
  }, 300);
}

// ── Presets ──

export interface FocusPreset {
  name: string;
  layout: FocusState;
}

let presets: FocusPreset[] = loadPresets();
const listeners = new Set<() => void>();

function loadPresets(): FocusPreset[] {
  const saved = read(() => localStorage.getItem(PRESETS_KEY));
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((p): p is { name: string; layout: unknown } => !!p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim() !== '')
    .map((p) => ({ name: p.name.trim(), layout: focusStateFrom(p.layout) }));
}

function setPresets(next: FocusPreset[]) {
  presets = next;
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
  } catch {
    // Kept for this session.
  }
  listeners.forEach((l) => l());
}

export const focusPresets = () => presets;

export function useFocusPresets(): FocusPreset[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => presets,
  );
}

/** Saves `layout` under `name`, replacing a preset of that name (case-insensitive). */
export function saveFocusPreset(name: string, layout: FocusState) {
  const others = presets.filter((p) => p.name.toLowerCase() !== name.trim().toLowerCase());
  setPresets([...others, { name: name.trim(), layout }].sort((a, b) => a.name.localeCompare(b.name)));
}

export function renameFocusPreset(from: string, to: string) {
  const preset = presets.find((p) => p.name === from);
  if (!preset) return;
  setPresets(
    [...presets.filter((p) => p.name !== from && p.name.toLowerCase() !== to.trim().toLowerCase()), { ...preset, name: to.trim() }].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  );
}

export function deleteFocusPreset(name: string) {
  setPresets(presets.filter((p) => p.name !== name));
}

/** The same panels, in the same places and sizes (the preset now shown is checked in menus). */
export const sameLayout = (a: FocusState, b: FocusState) => JSON.stringify(focusStateFrom(a)) === JSON.stringify(focusStateFrom(b));

// ── The name dialog (Save Current Layout As…, Rename) ──

export type PresetDialog = { mode: 'save' } | { mode: 'rename'; from: string } | null;
let dialog: PresetDialog = null;
const dialogListeners = new Set<() => void>();

export function openPresetDialog(next: PresetDialog) {
  dialog = next;
  dialogListeners.forEach((l) => l());
}

export function usePresetDialog(): PresetDialog {
  return useSyncExternalStore(
    (l) => {
      dialogListeners.add(l);
      return () => dialogListeners.delete(l);
    },
    () => dialog,
  );
}

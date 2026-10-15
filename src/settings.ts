// Application settings (Settings window, Ctrl+Alt+S), saved in this machine's browser storage.

import { useSyncExternalStore } from 'react';

export interface TerminalSettings {
  /** Shell executable; empty = the first shell found (Windows PowerShell on Windows). */
  shellPath: string;
  /** Folder new tabs start in; empty = the project root. */
  startDir: string;
  /** Extra environment variables: "KEY=value; OTHER=value". */
  env: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  defaultTabName: string;
  /** Show the title a running program sets (e.g. via OSC 2) as the tab name. */
  useAppTitle: boolean;
  audibleBell: boolean;
  closeOnExit: boolean;
  copyOnSelect: boolean;
  pasteOnMiddleClick: boolean;
  /** Keys typed in the terminal go to the shell, not to PhpStorm-style shortcuts (Double Shift, Ctrl+N…). */
  overrideIdeShortcuts: boolean;
  highlightLinks: boolean;
  cursorShape: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
}

export interface EditorSettings {
  /** Color scheme id, see editor/themes.ts. */
  scheme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  ligatures: boolean;
  /** "N usages" above declarations. */
  codeVision: boolean;
  /** Parameter names and types from the language server, shown inline. */
  inlayHints: boolean;
  /** Lightbulb on the caret line when there are context actions. */
  lightbulb: boolean;
}

export interface Settings {
  editor: EditorSettings;
  terminal: TerminalSettings;
}

/** PhpStorm's defaults where it has one. */
export const DEFAULT_SETTINGS: Settings = {
  editor: {
    scheme: 'islands-dark',
    fontFamily: 'JetBrains Mono',
    fontSize: 13,
    lineHeight: 1.6,
    ligatures: false,
    codeVision: true,
    inlayHints: true,
    lightbulb: true,
  },
  terminal: {
    shellPath: '',
    startDir: '',
    env: '',
    fontFamily: 'JetBrains Mono',
    fontSize: 13,
    lineHeight: 1.0,
    defaultTabName: 'Local',
    useAppTitle: true,
    audibleBell: true,
    closeOnExit: true,
    copyOnSelect: false,
    pasteOnMiddleClick: true,
    overrideIdeShortcuts: true,
    highlightLinks: true,
    cursorShape: 'block',
    cursorBlink: true,
  },
};

const KEY = 'phpblitz.settings';
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      editor: { ...DEFAULT_SETTINGS.editor, ...(saved.editor ?? {}) },
      terminal: { ...DEFAULT_SETTINGS.terminal, ...(saved.terminal ?? {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current: Settings = load();

export function getSettings(): Settings {
  return current;
}

export function saveSettings(next: Settings) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not persisted when storage is unavailable; still applies for this session.
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** "A=1; B=two" → [["A","1"],["B","two"]] */
export function parseEnv(text: string): [string, string][] {
  return text
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i).trim(), s.slice(i + 1).trim()] as [string, string];
    })
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
}

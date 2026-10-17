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
  /** Color scheme id, see editor/themes.ts; 'theme' follows the UI theme. */
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
  /** Show /** doc comments *\/ formatted (reader mode); Ctrl+Alt+Q toggles one. */
  renderDocs: boolean;
  /** Editor ▸ General ▸ Soft Wraps: files soft-wrapped when opened ("*.md; *.txt"). Alt+Z toggles one editor. */
  softWrapFiles: string;
  /** Editor ▸ General ▸ Appearance (also in the gutter's right-click ▸ Appearance). */
  lineNumbers: boolean;
  foldingOutline: boolean;
  indentGuides: boolean;
  whitespaces: boolean;
  /** Editor ▸ General ▸ Gutter Icons: all of them, then one by one. Breakpoints always show. */
  gutterIcons: boolean;
  gutterBookmarks: boolean;
  gutterRun: boolean;
  gutterDocs: boolean;
  gutterChanges: boolean;
}

export type UiTheme = 'islands-dark' | 'islands-light' | 'islands-darcula' | 'high-contrast';

/** Appearance & Behavior ▸ Appearance. */
export interface UiSettings {
  theme: UiTheme;
  /** Follow Windows' light / dark mode (Blitz Light / Blitz Dark). */
  syncOs: boolean;
  /** UI zoom in percent (Alt+Shift+= / Alt+Shift+Minus / Alt+Shift+0). */
  zoom: number;
  customFont: boolean;
  fontFamily: string;
  fontSize: number;
  contrastScrollbars: boolean;
  compact: boolean;
  fullPathInTitle: boolean;
  projectColors: boolean;
  smoothScrolling: boolean;
  menuIcons: boolean;
  indentGuides: boolean;
  smallerIndents: boolean;
  toolWindowBars: boolean;
  toolWindowNames: boolean;
}

/** Editor ▸ General ▸ Editor Tabs. */
export interface TabSettings {
  placement: 'top' | 'bottom' | 'none';
  /** One row that scrolls or squeezes its tabs, or several rows. */
  mode: 'scroll' | 'squeeze' | 'multiple';
  showIcon: boolean;
  showExtension: boolean;
  showDirForDuplicates: boolean;
  markModified: boolean;
  pathOnHover: boolean;
  closeButton: 'right' | 'left' | 'none';
  sortAlphabetically: boolean;
  openAtEnd: boolean;
  previewTab: boolean;
  limit: number;
  /** Over the limit: close tabs without changes, or the least recently used one. */
  overLimit: 'unchanged' | 'unused';
  activateOnClose: 'left' | 'right' | 'recent';
}

/** PHP ▸ Debug. */
export interface DebugSettings {
  /** Port PHPBlitz listens on for Xdebug (Xdebug 3's default is 9003). */
  port: number;
  /** Stop on the first line of a script even without breakpoints. */
  breakAtFirstLine: boolean;
  /** Break where an exception is thrown and not caught. */
  breakOnExceptions: boolean;
  /** Array items / object properties fetched at once (more load with "Show more"). */
  maxChildren: number;
  /** Show variable values at the end of lines while stopped. */
  inlineValues: boolean;
}

export interface Settings {
  ui: UiSettings;
  tabs: TabSettings;
  editor: EditorSettings;
  terminal: TerminalSettings;
  debug: DebugSettings;
}

/** PhpStorm's defaults where it has one. */
export const DEFAULT_SETTINGS: Settings = {
  ui: {
    theme: 'islands-dark',
    syncOs: false,
    zoom: 100,
    customFont: false,
    fontFamily: 'Inter',
    fontSize: 13,
    contrastScrollbars: false,
    compact: false,
    fullPathInTitle: false,
    projectColors: true,
    // Off like VS Code: animating each wheel tick makes fast wheels and touchpads trail behind.
    smoothScrolling: false,
    menuIcons: true,
    indentGuides: false,
    smallerIndents: false,
    toolWindowBars: true,
    toolWindowNames: false,
  },
  tabs: {
    placement: 'top',
    mode: 'scroll',
    showIcon: true,
    showExtension: true,
    showDirForDuplicates: true,
    markModified: true,
    pathOnHover: true,
    closeButton: 'right',
    sortAlphabetically: false,
    openAtEnd: false,
    previewTab: true,
    limit: 30,
    overLimit: 'unused',
    activateOnClose: 'left',
  },
  editor: {
    scheme: 'theme',
    fontFamily: 'JetBrains Mono',
    fontSize: 13,
    lineHeight: 1.6,
    ligatures: false,
    codeVision: true,
    inlayHints: true,
    lightbulb: true,
    renderDocs: true,
    softWrapFiles: '*.md; *.txt; *.rst; *.adoc',
    lineNumbers: true,
    foldingOutline: true,
    indentGuides: true,
    whitespaces: false,
    gutterIcons: true,
    gutterBookmarks: true,
    gutterRun: true,
    gutterDocs: true,
    gutterChanges: true,
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
  debug: {
    port: 9003,
    breakAtFirstLine: false,
    breakOnExceptions: false,
    maxChildren: 100,
    inlineValues: true,
  },
};

const KEY = 'phpblitz.settings';
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    // Settings saved before 0.1.3 had smooth scrolling on by default (it made scrolling lag): off once.
    if (saved.ui && !saved.version) {
      saved.ui.smoothScrolling = false;
      saved.version = 2;
      localStorage.setItem(KEY, JSON.stringify(saved));
    }
    return {
      ui: { ...DEFAULT_SETTINGS.ui, ...(saved.ui ?? {}) },
      tabs: { ...DEFAULT_SETTINGS.tabs, ...(saved.tabs ?? {}) },
      editor: { ...DEFAULT_SETTINGS.editor, ...(saved.editor ?? {}) },
      terminal: { ...DEFAULT_SETTINGS.terminal, ...(saved.terminal ?? {}) },
      debug: { ...DEFAULT_SETTINGS.debug, ...(saved.debug ?? {}) },
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
    localStorage.setItem(KEY, JSON.stringify({ ...next, version: 2 }));
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

/** The UI theme in effect (Sync with OS picks light or dark from Windows). */
export function effectiveTheme(ui: UiSettings): UiTheme {
  if (ui.syncOs && typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'islands-light' : 'islands-dark';
  }
  return ui.theme;
}

/** Editor color scheme for "Theme default": the scheme that goes with the UI theme. */
export function editorSchemeOf(s: Settings): string {
  if (s.editor.scheme !== 'theme') return s.editor.scheme;
  const theme = effectiveTheme(s.ui);
  return theme === 'islands-light' ? 'light' : theme === 'islands-darcula' ? 'darcula' : theme === 'high-contrast' ? 'high-contrast' : 'islands-dark';
}

/** Changes some editor settings right away (the gutter's right-click ▸ Appearance). */
export function updateEditorSettings(patch: Partial<EditorSettings>) {
  const s = getSettings();
  saveSettings({ ...s, editor: { ...s.editor, ...patch } });
}

/** Whether a file matches "*.md; *.txt"-style patterns (by file name). */
export function matchesFilePatterns(path: string, patterns: string): boolean {
  const name = path.split('/').pop() ?? path;
  return patterns
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(name));
}

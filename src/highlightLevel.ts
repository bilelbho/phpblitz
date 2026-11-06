// Customize Highlighting Level (the scrollbar's right-click menu): per file and language, which
// problems the editor marks. None: no problems; Syntax: syntax errors only; All Problems: everything
// (the default). It changes what the editor shows, not what is checked.

import { useSyncExternalStore } from 'react';
import * as monaco from 'monaco-editor';
import type { Problem } from './backend/types';
import { uriToPath } from './lsp/client';

export type Level = 'none' | 'syntax' | 'all';
export type CheckedLanguage = 'php' | 'javascript' | 'typescript';

export const LEVELS: [Level, string][] = [
  ['none', 'None'],
  ['syntax', 'Syntax'],
  ['all', 'All Problems'],
];
export const LANGUAGE_NAMES: Record<CheckedLanguage, string> = { php: 'PHP', javascript: 'JavaScript', typescript: 'TypeScript' };

const KEY = 'phpblitz.highlightLevels';
/** path → language → level; only levels other than All Problems are kept. */
let levels: Record<string, Partial<Record<CheckedLanguage, Level>>> = load();
const listeners = new Set<() => void>();

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** The languages a file's problems come in (what the menu offers for it). */
export function checkedLanguages(path: string): CheckedLanguage[] {
  if (/\.(php|phtml)$/i.test(path)) return ['php'];
  if (/\.(ts|tsx|mts|cts)$/i.test(path)) return ['typescript'];
  if (/\.(js|jsx|mjs|cjs)$/i.test(path)) return ['javascript'];
  return [];
}

export function levelOf(path: string, lang: CheckedLanguage): Level {
  return levels[path]?.[lang] ?? 'all';
}

export function setLevel(path: string, lang: CheckedLanguage, level: Level) {
  const forFile = { ...levels[path] };
  if (level === 'all') delete forFile[lang];
  else forFile[lang] = level;
  levels = { ...levels };
  if (Object.keys(forFile).length) levels[path] = forFile;
  else delete levels[path];
  try {
    localStorage.setItem(KEY, JSON.stringify(levels));
  } catch {
    // Only a preference.
  }
  listeners.forEach((l) => l());
  // TypeScript marks its own problems: checked again, they come back for a raised level.
  if ((lang === 'javascript' || lang === 'typescript') && level !== 'none') {
    const ts = monaco.languages.typescript;
    const d = lang === 'typescript' ? ts.typescriptDefaults : ts.javascriptDefaults;
    d.setDiagnosticsOptions(d.getDiagnosticsOptions());
  }
}

/** Re-renders when a level changes. */
export function useHighlightLevels() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => levels,
  );
}

/** A PHP file's problems as its level shows them. */
export function shownProblems(path: string, problems: Problem[]): Problem[] {
  const level = levelOf(path, 'php');
  if (level === 'all' || !checkedLanguages(path).includes('php')) return problems;
  if (level === 'none') return [];
  return problems.filter(isSyntaxProblem);
}

/** Mago says which problems are syntax errors; `php -l` and language servers only say it in the message. */
const isSyntaxProblem = (p: Problem) => p.category === 'syntax' || (!p.category && /\b(syntax|parse) error\b/i.test(p.message));

/** TypeScript's syntax diagnostics are numbered 1000–1999; the rest are about types and names. */
const isSyntaxCode = (code: monaco.editor.IMarker['code']) => {
  const n = Number(typeof code === 'object' && code ? code.value : code);
  return n >= 1000 && n < 2000;
};

// The TypeScript service sets its markers itself: those a file's level hides are taken off again.
monaco.editor.onDidChangeMarkers((uris) => {
  for (const uri of uris) {
    const path = uriToPath(uri.toString());
    const lang = checkedLanguages(path).find((l) => l !== 'php');
    if (!lang) continue;
    const level = levelOf(path, lang);
    if (level === 'all') continue;
    const model = monaco.editor.getModel(uri);
    if (!model) continue;
    for (const owner of ['typescript', 'javascript']) {
      const markers = monaco.editor.getModelMarkers({ resource: uri, owner });
      const kept = level === 'none' ? [] : markers.filter((m) => isSyntaxCode(m.code));
      // Only when something goes: setting them fires this event again.
      if (kept.length !== markers.length) monaco.editor.setModelMarkers(model, owner, kept);
    }
  }
});

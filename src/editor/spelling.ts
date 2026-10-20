// Typos in the editor: the open file is checked in the background (src-tauri/src/spell.rs) a moment
// after each change, misspelled words get a green wavy underline, and the hover, Alt+Enter,
// Alt+Shift+Enter and F2 offer "Typo: Rename to…" and "Save '…' to dictionary". Not in the
// Problems list. The project's dictionary lives in .blitz/project.json, shared with the team.

import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { getSettings } from '../settings';
import { isTauri } from '../platform';
import { projectStorage } from '../projectStorage';

/** Languages whose names, comments and strings are checked. */
const LANGUAGES = new Set(['php', 'javascript', 'typescript', 'markdown', 'plaintext']);
const DELAY_MS = 500;
/** Bigger files (minified, generated) aren't checked. */
const MAX_CHARS = 400_000;

export interface Typo {
  range: monaco.Range;
  word: string;
}

const typos = new Map<string, Typo[]>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Typos of a file (for the counter in the editor's corner). */
export function useTypoCount(uri: string | undefined): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (uri ? typos.get(uri)?.length ?? 0 : 0),
  );
}

export function typosOf(model: monaco.editor.ITextModel): Typo[] {
  return typos.get(model.uri.toString()) ?? [];
}

export function typoAt(model: monaco.editor.ITextModel, pos: monaco.IPosition): Typo | null {
  return typosOf(model).find((t) => t.range.containsPosition(pos)) ?? null;
}

/** A typo as a problem marker, for the hover popup (it shows markers). */
export function typoMarker(model: monaco.editor.ITextModel, t: Typo): monaco.editor.IMarker {
  return {
    owner: 'spelling',
    resource: model.uri,
    severity: monaco.MarkerSeverity.Hint,
    message: `Typo: In word '${t.word}'`,
    startLineNumber: t.range.startLineNumber,
    startColumn: t.range.startColumn,
    endLineNumber: t.range.endLineNumber,
    endColumn: t.range.endColumn,
  };
}

// ── The project's dictionary ─────────────────────────────────────

let root = '';
const dictKey = () => `phpblitz.dictionary:${root}`;
let words: string[] = [];

function readWords(): string[] {
  try {
    const list = JSON.parse(projectStorage.getItem(dictKey()) ?? '[]');
    return Array.isArray(list) ? list.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

/** The project's own name (its folder, composer.json's "name"): known without being saved. */
let projectWords: string[] = [];

const sendWords = () => (isTauri ? invoke('spell_set_words', { words: [...words, ...projectWords] }).catch(() => {}) : Promise.resolve());

/** The open project changed: its dictionary (and its name) go to the checker. */
export function openProjectDictionary(projectRoot: string) {
  root = projectRoot;
  words = readWords();
  projectWords = nameWords(projectRoot.split('/').pop() ?? '');
  void sendWords();
  if (!isTauri) return;
  void invoke<string>('read_file', { path: `${projectRoot}/composer.json` })
    .then((text) => {
      const name = (JSON.parse(text) as { name?: unknown }).name;
      if (typeof name !== 'string' || root !== projectRoot) return;
      projectWords = [...new Set([...projectWords, ...nameWords(name)])];
      return sendWords().then(recheckAll);
    })
    .catch(() => {});
}

/** "kimai/kimai", "acme-shop", "MyApp" → its words. */
function nameWords(name: string): string[] {
  return name
    .split(/[^A-Za-z]+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/))
    .filter((w) => w.length >= 3);
}

/** Save '…' to dictionary: it counts as spelled right in this project (and for the team). */
export async function saveToDictionary(word: string) {
  if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words = [...words, word].sort((a, b) => a.localeCompare(b));
  projectStorage.setItem(dictKey(), JSON.stringify(words));
  await sendWords();
  recheckAll();
}

export function suggestionsFor(word: string): Promise<string[]> {
  return isTauri ? invoke<string[]>('spell_suggest', { word, max: 6 }).catch(() => []) : Promise.resolve([]);
}

// ── Checking ─────────────────────────────────────────────────────

const checkers = new Set<() => void>();
function recheckAll() {
  checkers.forEach((c) => c());
}

/** Checks the editor's file now and after each change; returns a dispose function. */
export function attachSpelling(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  const decorations = editor.createDecorationsCollection();
  let timer = 0;
  let run = 0;
  const check = () => {
    window.clearTimeout(timer);
    const model = editor.getModel();
    if (!model) return;
    const uri = model.uri.toString();
    const off = !isTauri || !getSettings().editor.spellCheck || !LANGUAGES.has(model.getLanguageId()) || model.getValueLength() > MAX_CHARS;
    if (off) {
      decorations.clear();
      if (typos.delete(uri)) changed();
      return;
    }
    const version = model.getVersionId();
    const id = ++run;
    void invoke<{ offset: number; length: number; word: string }[]>('spell_check', { text: model.getValue() })
      .then((found) => {
        // A newer check (or another file) is on its way.
        if (id !== run || editor.getModel() !== model || model.getVersionId() !== version) return;
        const list = found.map((t) => {
          const start = model.getPositionAt(t.offset);
          const end = model.getPositionAt(t.offset + t.length);
          return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), word: t.word };
        });
        typos.set(uri, list);
        decorations.set(list.map((t) => ({ range: t.range, options: { inlineClassName: 'typo-squiggle', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } })));
        changed();
      })
      .catch(() => {});
  };
  const later = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(check, DELAY_MS);
  };
  const subs = [editor.onDidChangeModelContent(later), editor.onDidChangeModel(check), editor.onDidChangeModelLanguage(check)];
  checkers.add(check);
  check();
  return () => {
    window.clearTimeout(timer);
    subs.forEach((s) => s.dispose());
    checkers.delete(check);
    decorations.clear();
  };
}

/** The name around a typo (the whole identifier), and the range it covers. */
export function nameAround(model: monaco.editor.ITextModel, t: Typo): { name: string; range: monaco.Range } {
  const line = model.getLineContent(t.range.startLineNumber);
  let s = t.range.startColumn - 1;
  let e = t.range.endColumn - 1;
  while (s > 0 && /[\w$]/.test(line[s - 1])) s--;
  while (e < line.length && /\w/.test(line[e])) e++;
  return { name: line.slice(s, e), range: new monaco.Range(t.range.startLineNumber, s + 1, t.range.startLineNumber, e + 1) };
}

/** The name with the misspelled word replaced: getAuthPasswordAStito + Stipo → getAuthPasswordAStipo. */
export function correctedName(model: monaco.editor.ITextModel, t: Typo, suggestion: string): string {
  const { name, range } = nameAround(model, t);
  const at = t.range.startColumn - range.startColumn;
  return name.slice(0, at) + suggestion + name.slice(at + t.word.length);
}

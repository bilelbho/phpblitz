// Find in Files / Replace in Files. The desktop app searches in Rust (src-tauri/src/search.rs);
// the sample project and the browser use the small JavaScript version below.

import { dirMarks } from './dirMarks';
import { invoke } from '@tauri-apps/api/core';
import type { Backend } from './backend/types';
import { isTauri } from './platform';

export interface SearchOptions {
  query: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  /** Comma-separated globs, e.g. "*.php, *.blade.php". */
  fileMask: string;
}

export interface SearchMatch {
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  previewColumn: number;
  previewLength: number;
}

export interface SearchResult {
  files: { path: string; matches: SearchMatch[] }[];
  total: number;
  truncated: boolean;
  millis: number;
}

const MAX_MATCHES = 2000;

/**
 * Searches the project. `unsaved` holds the editor text of files with unsaved changes:
 * those are searched as shown in the editor, not as saved on disk.
 */
export async function searchInFiles(
  backend: Backend,
  files: string[],
  options: SearchOptions,
  unsaved: Map<string, string> = new Map(),
  /** Search only this folder. */
  dir?: string,
): Promise<SearchResult> {
  const within = (p: string) => !dir || p.startsWith(dir + '/');
  const result =
    isTauri && backend.kind === 'disk'
      ? await invoke<SearchResult>('search_in_files', { root: dir ?? backend.root, options: { ...options, excluded: dirMarks.excludedFolders().map((rel) => `${backend.root}/${rel}`) } })
      : await searchInMemory(backend, files.filter(within), options);
  if (!unsaved.size) return withoutExcluded(result, dir);
  const mask = maskToRegExp(options.fileMask);
  const re = toRegExp(options, true);
  const merged = result.files.filter((f) => !unsaved.has(f.path));
  for (const [path, text] of unsaved) {
    if ((mask && !mask.test(path)) || !within(path)) continue;
    const matches = matchText(text, re, MAX_MATCHES);
    if (matches.length) merged.push({ path, matches });
  }
  merged.sort((a, b) => a.path.localeCompare(b.path));
  return withoutExcluded({ ...result, files: merged, total: merged.reduce((n, f) => n + f.matches.length, 0) }, dir);
}

/** Drops matches in folders marked Excluded (Project tree ▸ Mark Directory As). */
function withoutExcluded(result: SearchResult, dir?: string): SearchResult {
  if (dir && dirMarks.isExcluded(dir)) return result;
  const files = result.files.filter((f) => !dirMarks.isExcluded(f.path));
  if (files.length === result.files.length) return result;
  return { ...result, files, total: files.reduce((n, f) => n + f.matches.length, 0) };
}

function matchText(text: string, re: RegExp, limit: number): SearchMatch[] {
  const matches: SearchMatch[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    for (const m of line.matchAll(re)) {
      if (!m[0] || matches.length >= limit) continue;
      const indent = line.length - line.trimStart().length;
      matches.push({
        line: i + 1,
        column: m.index! + 1,
        endColumn: m.index! + 1 + m[0].length,
        preview: line.slice(indent),
        previewColumn: m.index! - indent,
        previewLength: m[0].length,
      });
    }
  });
  return matches;
}

/** Replaces in one text (used for files open in the editor, so the change can be undone). */
export async function replaceInText(options: SearchOptions, replacement: string, text: string): Promise<{ text: string; count: number }> {
  if (isTauri) return invoke('replace_in_text', { options, replacement, text });
  const re = toRegExp(options, true);
  let count = 0;
  const out = text.replace(re, (...args) => {
    count++;
    return options.regex ? expand(replacement, args) : replacement;
  });
  return { text: out, count };
}

export interface ReplaceInFilesResult {
  count: number;
  /** Files left unchanged: not UTF-8 text, unreadable, or not writable. */
  skipped: { path: string; reason: string }[];
}

/** Replace in files that are not open, each saved like a save (Local History under `root`, atomic). */
export function replaceInFiles(options: SearchOptions, replacement: string, paths: string[], root: string): Promise<ReplaceInFilesResult> {
  return invoke<ReplaceInFilesResult>('replace_in_files', { options, replacement, paths, root });
}

// ── JavaScript fallback ───────────────────────────────────────

function toRegExp(o: SearchOptions, global: boolean): RegExp {
  const source = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(o.wholeWord ? `\\b(?:${source})\\b` : source, `${global ? 'g' : ''}${o.matchCase ? '' : 'i'}m`);
}

function expand(replacement: string, args: unknown[]): string {
  return replacement.replace(/\$(\d+)/g, (_, n) => String(args[Number(n)] ?? ''));
}

function maskToRegExp(mask: string): RegExp | null {
  const globs = mask.split(',').map((m) => m.trim()).filter(Boolean);
  if (!globs.length) return null;
  const parts = globs.map((g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.'));
  return new RegExp(`(^|/)(${parts.join('|')})$`, 'i');
}

async function searchInMemory(backend: Backend, files: string[], o: SearchOptions): Promise<SearchResult> {
  const started = performance.now();
  if (!o.query) throw new Error('Empty search');
  let re: RegExp;
  try {
    re = toRegExp(o, true);
  } catch (e) {
    throw new Error(`Bad pattern: ${e instanceof Error ? e.message : e}`);
  }
  const mask = maskToRegExp(o.fileMask);
  const result: SearchResult = { files: [], total: 0, truncated: false, millis: 0 };
  for (const path of [...files].sort()) {
    if (mask && !mask.test(path)) continue;
    const text = await backend.readFile(path).catch(() => '');
    const matches = matchText(text, re, MAX_MATCHES - result.total);
    result.total += matches.length;
    if (matches.length) result.files.push({ path, matches });
  }
  result.truncated = result.total >= MAX_MATCHES;
  result.millis = Math.round(performance.now() - started);
  return result;
}

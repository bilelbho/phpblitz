// Client for Mago, built into the Rust core (src-tauri/src/mago.rs):
// lint + incremental analysis for errors as you type, and code formatting.

import { invoke } from '@tauri-apps/api/core';
import * as monaco from 'monaco-editor';
import { isTauri } from './platform';
import type { Problem } from './backend/types';

/** Mago runs in the Rust core, so it needs the desktop app. */
export const magoAvailable = isTauri;

export interface MagoDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  help?: string | null;
  source: 'syntax' | 'lint' | 'analysis';
  fixes: MagoFix[];
}

export interface MagoFix {
  title: string;
  safety: 'safe' | 'potentially-unsafe' | 'unsafe';
  edits: { line: number; column: number; endLine: number; endColumn: number; text: string }[];
}

export interface MagoSummary {
  files: number;
  issues: number;
  millis: number;
  phpVersion: string;
  integrations: string[];
  vendor: boolean;
  configFile: string | null;
  configError: string | null;
}

/** `excludes`: folders (relative to the project) marked Excluded, which aren't analyzed. */
export const magoOpen = (root: string, excludes: string[] = []) => invoke<MagoSummary>('mago_open', { root, excludes });
export const magoClose = () => invoke('mago_close').catch(() => {});
export const magoCheck = (path: string, content: string) => invoke<MagoDiagnostic[]>('mago_check', { path, content });
/** Project Errors: at most `limit` problems (a huge project has tens of thousands), and the real total. */
export const magoProjectIssues = (limit = PROJECT_ISSUES_LIMIT) =>
  invoke<{ total: number; files: { path: string; diagnostics: MagoDiagnostic[] }[] }>('mago_project_issues', { limit });
export const PROJECT_ISSUES_LIMIT = 5000;
export const magoFormat = (content: string) => invoke<string | null>('mago_format', { content });
export const magoDisableRule = (category: string, code: string) => invoke<MagoSummary>('mago_disable_rule', { category, code });
export const magoEnsureConfig = () => invoke<string>('mago_ensure_config');
/** Files changed or deleted on disk: Mago reads them itself and re-checks once for the whole batch. */
export const magoSync = (changed: string[], removed: string[]) => invoke('mago_sync', { changed, removed });

/** The comment that hides one problem, e.g. `// @mago-expect lint:no-multi-assignments`. */
export function suppressionComment(p: Problem): string | null {
  return p.category && p.category !== 'syntax' && p.code ? `// @mago-expect ${p.category}:${p.code}` : null;
}

export function toProblem(path: string, d: MagoDiagnostic): Problem {
  return {
    path,
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    severity: d.severity,
    message: d.message,
    code: d.code || undefined,
    source: d.source === 'analysis' ? 'Mago analyzer' : d.source === 'lint' ? 'Mago linter' : 'syntax',
    help: d.help ?? undefined,
    category: d.source,
    fixes: d.fixes.length ? d.fixes : undefined,
  };
}

// Reformat Code (Ctrl+Alt+L) uses Mago's formatter.
monaco.languages.registerDocumentFormattingEditProvider('php', {
  displayName: 'Mago',
  async provideDocumentFormattingEdits(model) {
    if (!magoAvailable) return [];
    const formatted = await magoFormat(model.getValue());
    return formatted === null ? [] : [{ range: model.getFullModelRange(), text: formatted }];
  },
});

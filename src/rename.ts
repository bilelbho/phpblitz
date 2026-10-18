// Rename refactoring (Shift+F6) without a language server, from the symbol index: the
// declarations (for a method, also where it is overridden or implemented) and the usages the index
// finds. Usages on values of unknown type ("dynamic") are only renamed on request.
// Local variables are renamed within their function.

import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from './useWorkspace';
import { findUsages, targetAt, type Target } from './navigation';
import { baseName } from './backend/types';

/** A name to replace: 1-based line, UTF-16 columns (Monaco's), end exclusive. */
export interface NameEdit {
  path: string;
  line: number;
  column: number;
  endColumn: number;
}

export interface RenamePlan {
  /** "class", "method", "property", "constant", "function", "variable". */
  kind: string;
  /** Without `$`. */
  oldName: string;
  declarations: NameEdit[];
  usages: NameEdit[];
  /** Called on values of unknown type: maybe this symbol, maybe another with the same name. */
  dynamic: NameEdit[];
  /** A class file named after the class (Post.php): renamed with it. */
  file?: string;
  /** Declared in vendor/: can't be renamed. */
  error?: string;
  /** A JavaScript or TypeScript name (from the TypeScript service): `$` is allowed in it. */
  script?: boolean;
}

/** What planning needs from the workspace. */
export type RenameContext = Pick<Workspace, 'backend' | 'liveTextOf' | 'dirty'>;

interface Location {
  path: string;
  line: number;
  name: string;
}

const IDENT = /^[A-Za-z_\x80-\uffff][\w\x80-\uffff]*$/;
const SCRIPT_IDENT = /^[A-Za-z_$\x80-\uffff][\w$\x80-\uffff]*$/;
export const validName = (name: string, script = false) => (script ? SCRIPT_IDENT : IDENT).test(name);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where `name` is declared on a line: the column it starts at (1-based), or 0. */
function declarationColumn(line: string, kind: string, name: string): number {
  const n = escape(name);
  const re =
    kind === 'class'
      ? new RegExp(`\\b(?:class|interface|trait|enum)\\s+${n}\\b`, 'i')
      : kind === 'method' || kind === 'function'
        ? new RegExp(`\\bfunction\\s+&?\\s*${n}\\b`, 'i')
        : kind === 'property'
          ? new RegExp(`\\$${n}\\b`)
          : new RegExp(`\\b(?:const\\s+(?:[\\w\\\\|?]+\\s+)?|case\\s+)${n}\\b`);
  const m = re.exec(line);
  return m ? m.index + m[0].length - name.length + 1 : 0;
}

/** What a Rename at a position would change; null when there is nothing to rename there. */
export async function planRename(ws: RenameContext, model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<RenamePlan | null> {
  const path = pathOf(model);
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
  const isVariable = word.word.startsWith('$') || before.endsWith('$');
  const target = targetAt(model, position);
  if (!target) return isVariable ? planVariable(model, position, path) : null;
  return planForTarget(ws, target);
}

/** What renaming a class, member or function changes (see planRename). */
export async function planForTarget(ws: RenameContext, target: Target): Promise<RenamePlan> {
  const texts = new Map<string, string[]>();
  const linesOf = async (p: string) => {
    let lines = texts.get(p);
    if (!lines) {
      const text = ws.liveTextOf(p) ?? (await ws.backend.readFile(p).catch(() => ''));
      lines = text.split(/\r?\n/);
      texts.set(p, lines);
    }
    return lines;
  };

  const kind = target.kind === 'member' ? (target.memberKind === 'const' ? 'constant' : target.memberKind ?? 'method') : target.kind;
  const oldName = (target.kind === 'member' ? target.name : target.name.split('\\').pop()!).replace(/^\$/, '');
  const locations = await invoke<Location[]>('index_declarations', { target });
  if (!locations.length) return { kind, oldName, declarations: [], usages: [], dynamic: [], error: `Can't find where ${oldName} is declared.` };
  const vendor = `${ws.backend.root}/vendor/`;
  const inLibrary = locations.find((l) => l.path.startsWith(vendor));
  if (inLibrary) return { kind, oldName, declarations: [], usages: [], dynamic: [], error: `${oldName} is declared in a library (${inLibrary.path.slice(ws.backend.root.length + 1)}), which can't be changed.` };

  const declarations: NameEdit[] = [];
  for (const l of locations) {
    const line = (await linesOf(l.path))[l.line - 1] ?? '';
    const column = declarationColumn(line, kind === 'constant' ? 'const' : kind, oldName);
    if (column) declarations.push({ path: l.path, line: l.line, column, endColumn: column + oldName.length });
  }

  // Usages, with unsaved editor text searched as it is.
  const overrides: Record<string, string> = {};
  for (const p of ws.dirty) {
    const live = ws.liveTextOf(p);
    if (live !== undefined) overrides[p] = live;
  }
  const found = await findUsages(target as Target, overrides, false);
  const usages: NameEdit[] = [];
  const dynamic: NameEdit[] = [];
  for (const u of found.items) {
    if (u.path.startsWith(vendor)) continue;
    let { column } = u;
    if (target.kind !== 'member') {
      // A class or function written qualified (\App\Models\Post, Models\Post): only its last part;
      // an alias (use … as P) keeps its own name.
      const written = ((await linesOf(u.path))[u.line - 1] ?? '').slice(u.column - 1, u.endColumn - 1);
      const last = written.split('\\').pop() ?? '';
      if (last.toLowerCase() !== oldName.toLowerCase()) continue;
      column = u.endColumn - last.length;
    }
    (u.dynamic ? dynamic : usages).push({ path: u.path, line: u.line, column, endColumn: column + oldName.length });
  }

  const declPath = locations[0].path;
  const file = target.kind === 'class' && baseName(declPath).replace(/\.php$/i, '') === oldName ? declPath : undefined;
  return { kind, oldName, declarations, usages, dynamic, file };
}

/** A local variable: every `$name` in its function (or, outside functions, in the file's top level). */
function planVariable(model: monaco.editor.ITextModel, position: monaco.IPosition, path: string): RenamePlan | null {
  const name = model.getWordAtPosition(position)!.word.replace(/^\$/, '');
  if (name === 'this') return null;
  const text = model.getValue();
  const scopes = functionScopes(text);
  // The innermost function around an offset (its parameters included); undefined: the top level.
  const scopeAt = (at: number) => scopes.filter(([s, e]) => s <= at && at <= e).sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0]?.[0];
  const here = scopeAt(model.getOffsetAt(position));
  const usages: NameEdit[] = [];
  const re = new RegExp(`\\$${escape(name)}\\b`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (scopeAt(m.index) !== here) continue;
    const p = model.getPositionAt(m.index + 1);
    usages.push({ path, line: p.lineNumber, column: p.column, endColumn: p.column + name.length });
  }
  return usages.length ? { kind: 'variable', oldName: name, declarations: [], usages, dynamic: [] } : null;
}

/** Each function's scope as offsets: from `function` (parameters included) to its closing `}`. Skips strings and comments. */
function functionScopes(text: string): [number, number][] {
  const out: [number, number][] = [];
  const opens: { at: number; fn: number }[] = [];
  let pendingFunction = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') i = nextLine(text, i);
    else if (c === '#' && text[i + 1] !== '[') i = nextLine(text, i);
    else if (c === '/' && text[i + 1] === '*') i = Math.max(i, text.indexOf('*/', i + 2) + 1 || text.length);
    else if (c === "'" || c === '"') i = endOfString(text, i);
    else if (c === 'f' && text.startsWith('function', i) && !/\w/.test(text[i - 1] ?? '') && !/\w/.test(text[i + 8] ?? '')) pendingFunction = i;
    else if (c === ';' && pendingFunction >= 0) pendingFunction = -1; // abstract / interface method
    else if (c === '{') {
      opens.push({ at: i, fn: pendingFunction });
      pendingFunction = -1;
    } else if (c === '}') {
      const o = opens.pop();
      if (o && o.fn >= 0) out.push([o.fn, i]);
    }
  }
  return out;
}

const nextLine = (text: string, i: number) => {
  const n = text.indexOf('\n', i);
  return n < 0 ? text.length : n;
};

function endOfString(text: string, i: number) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j;
  }
  return text.length;
}

export function pathOf(model: monaco.editor.ITextModel): string {
  let p = decodeURIComponent(model.uri.path);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

/** The edits a plan makes, by file. */
export function renameEdits(plan: RenamePlan, includeDynamic: boolean): Map<string, NameEdit[]> {
  const byFile = new Map<string, NameEdit[]>();
  const seen = new Set<string>();
  for (const e of [...plan.declarations, ...plan.usages, ...(includeDynamic ? plan.dynamic : [])]) {
    const key = `${e.path}:${e.line}:${e.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
  }
  return byFile;
}

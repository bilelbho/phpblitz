// TODO comments, like PhpStorm's TODO tool window: `todo` and `fixme` (any case, as a word) inside a
// comment: //, #, /* … */, docblock lines, <!-- -->, {{-- --}}.

import type { Workspace } from './useWorkspace';
import { searchInFiles } from './search';

export interface TodoItem {
  path: string;
  /** 1-based. */
  line: number;
  /** The comment from its opener to the end of the line: "//todo: fix this thing here". */
  text: string;
  /** Where "todo…" starts and ends in `text` (the part shown highlighted). */
  start: number;
  end: number;
}

const WORD = /\b(todo|fixme)\b/i;
const OPENER = /\/\/|#|\/\*|<!--|\{\{--/;
const CLOSER = /\s*(\*\/|-->|--\}\})/;

/** The TODO in one line of code, as columns (0-based, end exclusive) of the line; null if none. */
export function todoInLine(line: string): { comment: number; start: number; end: number } | null {
  const m = WORD.exec(line);
  if (!m) return null;
  // The comment the word is in: an opener before it, or a docblock line (" * TODO …").
  const opener = OPENER.exec(line);
  const star = /^\s*\*(?!\/)/.exec(line);
  const comment = opener && opener.index < m.index ? opener.index : star ? star[0].length - 1 : -1;
  if (comment < 0 || comment > m.index) return null;
  // Up to the comment's end (it may close mid-line), else the end of the line.
  const closer = CLOSER.exec(line.slice(m.index));
  const end = closer ? m.index + closer.index : line.trimEnd().length;
  return { comment, start: m.index, end };
}

/** Every TODO in a text. */
export function todosInText(path: string, text: string): TodoItem[] {
  const out: TodoItem[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = todoInLine(line);
    if (!t) return;
    const shown = line.slice(t.comment, t.end);
    out.push({ path, line: i + 1, text: shown, start: t.start - t.comment, end: t.end - t.comment });
  });
  return out;
}

/** Every TODO in the project's own files (not vendor/ or node_modules/), unsaved editor text included. */
export async function projectTodos(ws: Workspace): Promise<TodoItem[]> {
  const unsaved = new Map([...ws.dirty].map((p) => [p, ws.liveTextOf(p) ?? ''] as const));
  const result = await searchInFiles(ws.backend, ws.files, { query: '\\b(todo|fixme)\\b', regex: true, matchCase: false, wholeWord: false, fileMask: '' }, unsaved);
  const out: TodoItem[] = [];
  for (const f of result.files) {
    if (/\/(vendor|node_modules)\//.test(f.path)) continue;
    for (const m of f.matches) {
      const t = todoInLine(m.preview);
      if (!t) continue;
      out.push({ path: f.path, line: m.line, text: m.preview.slice(t.comment, t.end), start: t.start - t.comment, end: t.end - t.comment });
    }
  }
  // One item per line (a line with "TODO … fixme" matches twice).
  const seen = new Set<string>();
  return out.filter((t) => !seen.has(`${t.path}:${t.line}`) && !!seen.add(`${t.path}:${t.line}`));
}

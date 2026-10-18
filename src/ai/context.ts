// What the model is told about the code: the open file (around the caret when it's long), the
// selection, its problems, and for PHP the outline of the classes it uses, from the index (their
// methods and properties with types, so answers call real APIs instead of guessed ones).

import type { Problem } from '../backend/types';
import { importsOf } from '../php';
import { symbols, type IndexClass, type IndexMember } from '../symbols';

export interface CodeContext {
  path: string;
  /** Relative to the project, for the model and the UI. */
  rel: string;
  language: string;
  text: string;
  /** 1-based lines. */
  cursorLine: number;
  selection?: { text: string; startLine: number; endLine: number };
  problems: Problem[];
}

/** Longest file text sent (characters): about 15k tokens. */
const MAX_FILE = 60_000;
const MAX_CLASSES = 12;
const MAX_MEMBERS = 40;

/** The file, or the part around the caret when it's too long, with line numbers where it starts. */
export function fileExcerpt(text: string, cursorLine: number, max = MAX_FILE): { text: string; firstLine: number; cut: boolean } {
  if (text.length <= max) return { text, firstLine: 1, cut: false };
  const lines = text.split('\n');
  let start = Math.max(0, cursorLine - 1);
  let end = start + 1;
  let size = lines[start]?.length ?? 0;
  // Grow around the caret, a line on each side at a time.
  while (size < max && (start > 0 || end < lines.length)) {
    if (start > 0) size += lines[--start].length + 1;
    if (end < lines.length && size < max) size += lines[end++].length + 1;
  }
  return { text: lines.slice(start, end).join('\n'), firstLine: start + 1, cut: true };
}

function signature(m: IndexMember): string {
  const vis = m.visibility === 'public' ? '' : `${m.visibility} `;
  const stat = m.isStatic ? 'static ' : '';
  if (m.kind === 'method') return `  ${vis}${stat}function ${m.name}(${m.params ?? ''})${m.detail ? `: ${m.detail.replace(/^:\s*/, '')}` : ''}`;
  if (m.kind === 'property') return `  ${vis}${stat}${m.detail ? `${m.detail} ` : ''}$${m.name}`;
  return `  const ${m.name}${m.detail ? ` ${m.detail}` : ''}`;
}

export function outline(c: IndexClass): string {
  const members = c.allMembers.filter((m) => m.visibility !== 'private' || c.members.includes(m)).slice(0, MAX_MEMBERS);
  const more = c.allMembers.length > members.length ? `\n  … ${c.allMembers.length - members.length} more` : '';
  return `${c.kind} ${c.fqn}${c.extends ? ` extends ${c.extends}` : ''}\n${members.map(signature).join('\n')}${more}`;
}

/** Classes a PHP file uses: its imports and its parent, outlined from the index. */
async function relatedClasses(text: string): Promise<string[]> {
  const names = new Set(importsOf(text).values());
  const parent = /\bclass\s+\w+\s+extends\s+([\w\\]+)/.exec(text)?.[1];
  if (parent) names.add(parent);
  const found = await Promise.all([...names].slice(0, MAX_CLASSES).map((n) => symbols.classInfo(n, text).catch(() => null)));
  return found.filter((c): c is IndexClass => !!c && c.kind !== undefined).map(outline);
}

/** The context as text for a prompt. */
export async function describeContext(ctx: CodeContext): Promise<string> {
  const parts: string[] = [];
  const excerpt = fileExcerpt(ctx.text, ctx.cursorLine);
  const where = excerpt.cut ? ` (lines ${excerpt.firstLine}–${excerpt.firstLine + excerpt.text.split('\n').length - 1} of a longer file)` : '';
  parts.push(`File: ${ctx.rel}${where}\n\`\`\`${ctx.language}\n${excerpt.text}\n\`\`\``);
  if (ctx.selection) parts.push(`Selected (lines ${ctx.selection.startLine}–${ctx.selection.endLine}):\n\`\`\`${ctx.language}\n${ctx.selection.text}\n\`\`\``);
  else parts.push(`The caret is on line ${ctx.cursorLine}.`);
  if (ctx.problems.length) {
    parts.push(`Problems PHPBlitz reports in this file:\n${ctx.problems.slice(0, 30).map((p) => `- line ${p.line}: ${p.severity}${p.code ? ` [${p.code}]` : ''} ${p.message}`).join('\n')}`);
  }
  if (ctx.language === 'php') {
    const classes = await relatedClasses(ctx.text);
    if (classes.length) parts.push(`Classes this file uses (outlines from the project's index):\n\`\`\`\n${classes.join('\n\n')}\n\`\`\``);
  }
  return parts.join('\n\n');
}

/** A short label for the UI: "UserController.php, lines 10–24". */
export function contextLabel(ctx: CodeContext): string {
  const name = ctx.rel.split('/').pop() ?? ctx.rel;
  return ctx.selection ? `${name}, ${ctx.selection.startLine === ctx.selection.endLine ? `line ${ctx.selection.startLine}` : `lines ${ctx.selection.startLine}–${ctx.selection.endLine}`}` : name;
}

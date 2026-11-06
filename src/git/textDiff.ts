// Two-way comparison for the diff viewer (and the merge editor's options): which lines changed,
// with what counts as a change (whitespace, empty lines, imports), and what inside a changed block
// is highlighted (words, characters, or line by line).

import { diffLines } from './diff';

/** What differences don't count. */
export type WhitespaceMode = 'none' | 'trim' | 'all' | 'all-empty' | 'imports';
/** What's highlighted inside a changed block. */
export type HighlightMode = 'lines' | 'words' | 'split' | 'chars' | 'none';

export const WHITESPACE_MODES: [WhitespaceMode, string][] = [
  ['none', 'Do not ignore'],
  ['trim', 'Trim whitespaces'],
  ['all', 'Ignore whitespaces'],
  ['all-empty', 'Ignore whitespaces and empty lines'],
  ['imports', 'Ignore imports and formatting'],
];
export const HIGHLIGHT_MODES: [HighlightMode, string][] = [
  ['lines', 'Highlight lines'],
  ['words', 'Highlight words'],
  ['split', 'Highlight split changes'],
  ['chars', 'Highlight characters'],
  ['none', 'Do not highlight'],
];

/** Lines [a0, a1) of the left side became [b0, b1) of the right (0-based, end excluded). */
export interface LineChange {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** A highlighted part inside a changed block: on one side, line (0-based) and columns [start, end) (0-based). */
export interface InnerRange {
  side: 'a' | 'b';
  line: number;
  start: number;
  end: number;
}

/** use / import / require lines: with "imports and formatting", changes to them don't count. */
const IMPORT = /^\s*(use\s+[\w\\{}, ]+(\s+as\s+\w+)?\s*;|import\s.+|(require|include)(_once)?\b.*;|from\s+\S+\s+import\s.+)\s*$/;

/** How a line compares under a whitespace mode; null when the line doesn't take part at all. */
function keyOf(line: string, mode: WhitespaceMode): string | null {
  switch (mode) {
    case 'none':
      return line;
    case 'trim':
      return line.trim();
    case 'all':
      return line.replace(/\s+/g, '');
    case 'all-empty': {
      const k = line.replace(/\s+/g, '');
      return k ? k : null;
    }
    case 'imports': {
      if (IMPORT.test(line)) return null;
      const k = line.replace(/\s+/g, '');
      return k ? k : null;
    }
  }
}

/** The changed line blocks between two texts, as the whitespace mode counts them. */
export function lineChanges(a: string[], b: string[], mode: WhitespaceMode = 'none'): LineChange[] {
  const keep = (lines: string[]) => {
    const keys: string[] = [];
    const at: number[] = [];
    lines.forEach((l, i) => {
      const k = keyOf(l, mode);
      if (k !== null) {
        keys.push(k);
        at.push(i);
      }
    });
    return { keys, at };
  };
  const A = keep(a);
  const B = keep(b);
  // Where a position in the compared (kept) lines is in the real lines.
  const realA = (i: number) => (i < A.at.length ? A.at[i] : a.length);
  const realB = (i: number) => (i < B.at.length ? B.at[i] : b.length);
  return diffLines(A.keys, B.keys).map((h) => {
    const fa0 = h.oldStart - 1;
    const fa1 = fa0 + h.oldLines.length;
    const fb0 = h.start - 1;
    const fb1 = fb0 + h.count;
    const a0 = realA(fa0);
    const b0 = realB(fb0);
    return { a0, a1: fa1 > fa0 ? A.at[fa1 - 1] + 1 : a0, b0, b1: fb1 > fb0 ? B.at[fb1 - 1] + 1 : b0 };
  });
}

/** Tokens for word highlighting: words, runs of whitespace, single other characters. */
const WORD = /\w+|\s+|[^\w\s]/g;

/**
 * What to highlight inside one changed block: the tokens (words or characters) that differ, as
 * ranges on each side. Whitespace that doesn't count under the mode isn't highlighted.
 */
export function innerRanges(aLines: string[], bLines: string[], mode: 'words' | 'chars', ws: WhitespaceMode = 'none'): InnerRange[] {
  type Tok = { text: string; line: number; col: number };
  const tokens = (lines: string[]): Tok[] =>
    lines.flatMap((l, line) => {
      const out: Tok[] = [];
      if (mode === 'chars') for (let col = 0; col < l.length; col++) out.push({ text: l[col], line, col });
      else for (const m of l.matchAll(WORD)) out.push({ text: m[0], line, col: m.index! });
      // Line breaks compare too (a line joined or split is a change).
      out.push({ text: '\n', line, col: l.length });
      return out;
    });
  const ignoreSpace = ws !== 'none';
  const all = { a: tokens(aLines), b: tokens(bLines) };
  const kept = (t: Tok[]) => (ignoreSpace ? t.filter((x) => x.text === '\n' || x.text.trim()) : t);
  const A = kept(all.a);
  const B = kept(all.b);
  const out: InnerRange[] = [];
  for (const h of diffLines(
    A.map((t) => t.text),
    B.map((t) => t.text),
  )) {
    const push = (side: 'a' | 'b', toks: Tok[]) => {
      for (const t of toks) if (t.text !== '\n') out.push({ side, line: t.line, start: t.col, end: t.col + t.text.length });
    };
    push('a', A.slice(h.oldStart - 1, h.oldStart - 1 + h.oldLines.length));
    push('b', B.slice(h.start - 1, h.start - 1 + h.count));
  }
  return merge(out);
}

/** Neighbouring ranges on the same line become one (a changed "foo bar" is one highlight, not three). */
function merge(ranges: InnerRange[]): InnerRange[] {
  const sorted = [...ranges].sort((x, y) => (x.side < y.side ? -1 : x.side > y.side ? 1 : x.line - y.line || x.start - y.start));
  const out: InnerRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.side === r.side && last.line === r.line && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Highlight split changes: a block with as many lines on both sides becomes one change per line pair. */
export function splitChanges(changes: LineChange[], a: string[], b: string[], ws: WhitespaceMode): LineChange[] {
  return changes.flatMap((c) => {
    const n = c.a1 - c.a0;
    if (n < 2 || n !== c.b1 - c.b0) return [c];
    const out: LineChange[] = [];
    for (let i = 0; i < n; i++) {
      // Pairs that are the same (as the mode compares) aren't changes.
      if (keyOf(a[c.a0 + i], ws) === keyOf(b[c.b0 + i], ws)) continue;
      out.push({ a0: c.a0 + i, a1: c.a0 + i + 1, b0: c.b0 + i, b1: c.b0 + i + 1 });
    }
    return out.length ? out : [c];
  });
}

/** Stretches between changes, for folding and scrolling together: alternating unchanged and changed. */
export interface Part {
  changed: boolean;
  a: { start: number; count: number };
  b: { start: number; count: number };
}

/** The whole of both texts as parts (1-based lines). */
export function partsOf(changes: LineChange[], aLength: number, bLength: number): Part[] {
  const parts: Part[] = [];
  let a = 0;
  let b = 0;
  for (const c of changes) {
    if (c.a0 > a || c.b0 > b) parts.push({ changed: false, a: { start: a + 1, count: c.a0 - a }, b: { start: b + 1, count: c.b0 - b } });
    parts.push({ changed: true, a: { start: c.a0 + 1, count: c.a1 - c.a0 }, b: { start: c.b0 + 1, count: c.b1 - c.b0 } });
    a = c.a1;
    b = c.b1;
  }
  if (a < aLength || b < bLength) parts.push({ changed: false, a: { start: a + 1, count: aLength - a }, b: { start: b + 1, count: bLength - b } });
  return parts;
}

/** Lines [a0, a1) of the left side that are lines [b0, b1) of the right somewhere else: moved, not deleted and added. */
export interface MovedBlock {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Fewer letters and digits than this in a block: too little to call it moved ("}" and "return;" are everywhere). */
const MOVED_MIN_CHARS = 20;
/** Past this many changed lines, moves aren't looked for (the comparison has to stay quick). */
const MOVED_MAX_LINES = 5000;

/**
 * Moved code: runs of deleted lines that come back, the same apart from indentation, as added lines
 * elsewhere. Each line is in one block at most; the longest runs are taken first.
 */
export function movedBlocks(a: string[], b: string[], changes: LineChange[]): MovedBlock[] {
  const inA = new Uint8Array(a.length);
  const inB = new Uint8Array(b.length);
  let total = 0;
  for (const c of changes) {
    for (let i = c.a0; i < c.a1; i++) inA[i] = 1;
    for (let j = c.b0; j < c.b1; j++) inB[j] = 1;
    total += c.a1 - c.a0 + c.b1 - c.b0;
  }
  if (!total || total > MOVED_MAX_LINES) return [];
  const key = (l: string) => l.trim();
  const added = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const k = inB[j] && key(b[j]);
    if (k) (added.get(k) ?? added.set(k, []).get(k)!).push(j);
  }
  const candidates: MovedBlock[] = [];
  for (let i = 0; i < a.length; i++) {
    const k = inA[i] && key(a[i]);
    if (!k) continue;
    for (const j of added.get(k) ?? []) {
      // Only where a run starts: the lines before don't match too.
      if (i > 0 && j > 0 && inA[i - 1] && inB[j - 1] && key(a[i - 1]) === key(b[j - 1])) continue;
      let n = 0;
      while (i + n < a.length && j + n < b.length && inA[i + n] && inB[j + n] && key(a[i + n]) === key(b[j + n])) n++;
      // Blank lines at the end belong to whatever comes next.
      while (n > 0 && !key(a[i + n - 1])) n--;
      let chars = 0;
      for (let x = 0; x < n; x++) chars += a[i + x].replace(/[^\p{L}\p{N}]/gu, '').length;
      if (chars >= MOVED_MIN_CHARS) candidates.push({ a0: i, a1: i + n, b0: j, b1: j + n });
    }
  }
  candidates.sort((x, y) => y.a1 - y.a0 - (x.a1 - x.a0) || x.a0 - y.a0);
  const usedA = new Uint8Array(a.length);
  const usedB = new Uint8Array(b.length);
  const out: MovedBlock[] = [];
  for (const m of candidates) {
    let free = true;
    for (let x = 0; free && x < m.a1 - m.a0; x++) free = !usedA[m.a0 + x] && !usedB[m.b0 + x];
    if (!free) continue;
    usedA.fill(1, m.a0, m.a1);
    usedB.fill(1, m.b0, m.b1);
    out.push(m);
  }
  return out.sort((x, y) => x.a0 - y.a0);
}

/** Lines as the mode compares them, the ones it leaves out (empty lines, imports) gone. */
export function comparable(lines: string[], mode: WhitespaceMode): string[] {
  return lines.map((l) => keyOf(l, mode)).filter((k): k is string => k !== null);
}

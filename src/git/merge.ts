// Three-way merge of a conflicted file (the merge editor): the common base and both sides are
// compared line by line. A change on one side only, or the same change on both, merges by itself;
// different changes to the same lines are a conflict the user resolves.

import { diffLines } from './diff';
import { comparable } from './textDiff';

export type Segment =
  /** Lines no side changed. */
  | { kind: 'same'; lines: string[] }
  /** Changed on one side (or the same way on both): merged as that side has it. */
  | { kind: 'change'; side: 'ours' | 'theirs' | 'both'; base: string[]; ours: string[]; theirs: string[] }
  /** Changed differently on both sides. */
  | { kind: 'conflict'; base: string[]; ours: string[]; theirs: string[] };

interface Edit {
  /** Base lines [a0, a1) became side lines [b0, b1) (0-based). */
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** What whitespace differences don't count in the merge editor. */
/** all-empty and imports: also empty lines, and use / import lines (as in the diff viewer). */
export type MergeWhitespace = 'none' | 'trim' | 'all' | 'all-empty' | 'imports';

/** What merge3 itself compares lines by: the other modes come after (see merge3). */
type LineWhitespace = 'none' | 'trim' | 'all';

const keyOf = (line: string, ws: LineWhitespace) => (ws === 'trim' ? line.trim() : ws === 'all' ? line.replace(/\s+/g, '') : line);

function edits(base: string[], side: string[], ws: LineWhitespace): Edit[] {
  const key = (lines: string[]) => (ws === 'none' ? lines : lines.map((l) => keyOf(l, ws)));
  return diffLines(key(base), key(side)).map((h) => ({ a0: h.oldStart - 1, a1: h.oldStart - 1 + h.oldLines.length, b0: h.start - 1, b1: h.start - 1 + h.count }));
}

/** Lines of a text; \r\n and \n alike, so a side checked out with other line endings doesn't conflict everywhere. */
export function toLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Splits the three versions into unchanged parts, merged changes and conflicts, in file order.
 * With whitespace ignored, lines that differ only in it count as unchanged: the result keeps them
 * as your side has them.
 */
export function merge3(baseText: string, oursText: string, theirsText: string, ws: MergeWhitespace = 'none'): Segment[] {
  if (ws === 'all-empty' || ws === 'imports') return ignoringLines(mergeLines(baseText, oursText, theirsText, 'all'), ws);
  return mergeLines(baseText, oursText, theirsText, ws);
}

function mergeLines(baseText: string, oursText: string, theirsText: string, ws: LineWhitespace): Segment[] {
  const base = toLines(baseText);
  const ours = toLines(oursText);
  const theirs = toLines(theirsText);
  const all = [...edits(base, ours, ws).map((e) => ({ ...e, side: 'ours' as const })), ...edits(base, theirs, ws).map((e) => ({ ...e, side: 'theirs' as const }))].sort(
    (x, y) => x.a0 - y.a0 || x.a1 - y.a1,
  );
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, k) => keyOf(line, ws) === keyOf(b[k], ws));
  /** Unchanged base lines [from, to), as your side has them (shifted by your edits before them). */
  let oursShift = 0;
  const unchanged = (from: number, to: number) => ours.slice(from + oursShift, to + oursShift);

  const out: Segment[] = [];
  let at = 0; // base lines before this are emitted
  let i = 0;
  while (i < all.length) {
    // A group: edits whose base ranges overlap, or touch from different sides (changes right next to
    // each other on both sides conflict, as in git). One side's own edits never touch: lines between.
    const lo = all[i].a0;
    let hi = all[i].a1;
    const group = [all[i++]];
    while (i < all.length && (all[i].a0 < hi || (all[i].a0 === hi && group.some((g) => g.side !== all[i].side)))) {
      hi = Math.max(hi, all[i].a1);
      group.push(all[i++]);
    }
    if (lo > at) out.push({ kind: 'same', lines: unchanged(at, lo) });
    // Each side's text for base lines [lo, hi): its edits, with the unchanged base lines around them.
    const sideText = (side: 'ours' | 'theirs', lines: string[]) => {
      const mine = group.filter((g) => g.side === side);
      if (!mine.length) return side === 'ours' ? unchanged(lo, hi) : base.slice(lo, hi);
      const first = mine[0];
      const last = mine[mine.length - 1];
      return lines.slice(first.b0 - (first.a0 - lo), last.b1 + (hi - last.a1));
    };
    const o = sideText('ours', ours);
    const t = sideText('theirs', theirs);
    const b = base.slice(lo, hi);
    const changedOurs = group.some((g) => g.side === 'ours');
    const changedTheirs = group.some((g) => g.side === 'theirs');
    if (changedOurs && changedTheirs && !same(o, t)) out.push({ kind: 'conflict', base: b, ours: o, theirs: t });
    else out.push({ kind: 'change', side: changedOurs && changedTheirs ? 'both' : changedOurs ? 'ours' : 'theirs', base: b, ours: o, theirs: t });
    for (const g of group) if (g.side === 'ours') oursShift += g.b1 - g.b0 - (g.a1 - g.a0);
    at = hi;
  }
  if (at < base.length) out.push({ kind: 'same', lines: unchanged(at, base.length) });
  return out;
}

/**
 * Empty lines (and imports) not counting: a conflict whose sides differ only in them is your side's
 * change, and a change that's only them is unchanged (as your side has it). Lines stay where the
 * merge put them, so nothing is moved or lost.
 */
function ignoringLines(segments: Segment[], ws: 'all-empty' | 'imports'): Segment[] {
  const same = (a: string[], b: string[]) => {
    const x = comparable(a, ws);
    const y = comparable(b, ws);
    return x.length === y.length && x.every((k, i) => k === y[i]);
  };
  const out: Segment[] = [];
  for (const s of segments) {
    let next: Segment = s;
    if (s.kind === 'conflict' && same(s.ours, s.theirs)) next = same(s.base, s.ours) ? { kind: 'same', lines: s.ours } : { kind: 'change', side: 'ours', base: s.base, ours: s.ours, theirs: s.theirs };
    else if (s.kind === 'change' && same(s.base, s.ours) && same(s.base, s.theirs)) next = { kind: 'same', lines: s.ours };
    const last = out[out.length - 1];
    if (next.kind === 'same' && last?.kind === 'same') out[out.length - 1] = { kind: 'same', lines: [...last.lines, ...next.lines] };
    else out.push(next);
  }
  return out;
}

/** A side's change in a chunk: waiting, taken into the result, or left out. */
export type SideState = 'pending' | 'applied' | 'ignored';

/** A changed segment's state: each side that changed it (null: that side didn't), and the order sides were applied in. */
export interface ChunkState {
  ours: SideState | null;
  theirs: SideState | null;
  applied: ('ours' | 'theirs')[];
}

/** Before anything is taken: every side that changed the segment is pending; unchanged segments have no state. */
export function initialStates(segments: Segment[]): (ChunkState | null)[] {
  return segments.map((s) => {
    if (s.kind === 'same') return null;
    const ours = s.kind === 'conflict' || s.side !== 'theirs' ? 'pending' : null;
    const theirs = s.kind === 'conflict' || s.side !== 'ours' ? 'pending' : null;
    return { ours, theirs, applied: [] };
  });
}

/** Nothing left to decide in this chunk. */
export const isResolved = (st: ChunkState | null) => !st || (st.ours !== 'pending' && st.theirs !== 'pending');

/** The chunk's state after applying or ignoring one side. The same change on both sides goes in once. */
export function act(s: Segment, st: ChunkState, side: 'ours' | 'theirs', action: 'apply' | 'ignore'): ChunkState {
  if (st[side] !== 'pending') return st;
  const next: ChunkState = { ...st, [side]: action === 'apply' ? 'applied' : 'ignored', applied: action === 'apply' ? [...st.applied, side] : st.applied };
  if (s.kind === 'change' && s.side === 'both') {
    const other = side === 'ours' ? 'theirs' : 'ours';
    next[other] = next[side];
  }
  return next;
}

/** What a segment puts in the result: the base, with the applied sides' text in the order applied. */
export function resultLines(s: Segment, st: ChunkState | null): string[] {
  if (s.kind === 'same') return s.lines;
  const applied = st?.applied ?? [];
  if (!applied.length) return s.base;
  // One side, or the same change made on both: that side's text.
  if (applied.length === 1 || (s.kind === 'change' && s.side === 'both')) return s[applied[0]];
  return [...s[applied[0]], ...s[applied[1]]];
}

/** The merged text; `states` has one entry per segment. */
export function mergedText(segments: Segment[], states: (ChunkState | null)[], eol = '\n'): string {
  return segments.flatMap((s, i) => resultLines(s, states[i])).join(eol);
}

/** Every change applied (conflicts stay as they are): what a merge without questions would make. */
export function applyNonConflicting(segments: Segment[], states: (ChunkState | null)[], sides: ('ours' | 'theirs')[]): (ChunkState | null)[] {
  return states.map((st, i) => {
    const s = segments[i];
    if (!st || s.kind !== 'change') return st;
    return sides.reduce((acc, side) => act(s, acc, side, 'apply'), st);
  });
}

/** Where a segment is in each pane: its first line (1-based) and how many lines it has. */
export interface SegmentPlace {
  ours: { start: number; count: number };
  theirs: { start: number; count: number };
  result: { start: number; count: number };
}

/** Each segment's lines in the three panes, with the result as these states make it. */
export function segmentPlaces(segments: Segment[], states: (ChunkState | null)[]): SegmentPlace[] {
  const next = { ours: 1, theirs: 1, result: 1 };
  return segments.map((s, i) => {
    const counts =
      s.kind === 'same'
        ? { ours: s.lines.length, theirs: s.lines.length, result: s.lines.length }
        : { ours: s.ours.length, theirs: s.theirs.length, result: resultLines(s, states[i]).length };
    const place = {
      ours: { start: next.ours, count: counts.ours },
      theirs: { start: next.theirs, count: counts.theirs },
      result: { start: next.result, count: counts.result },
    };
    next.ours += counts.ours;
    next.theirs += counts.theirs;
    next.result += counts.result;
    return place;
  });
}

/** The line in another pane that matches `line` in this one: same offset into the same segment. */
export function matchingLine(places: { start: number; count: number }[], to: { start: number; count: number }[], line: number): number {
  let k = places.length - 1;
  while (k > 0 && places[k].start > line) k--;
  const offset = line - places[k].start;
  return to[k].start + Math.max(0, Math.min(offset, to[k].count - 1));
}

/**
 * A three-way merge done at once: every change from either side applied, conflicts written with
 * git's markers (ours first). The text keeps `ours`'s line ending.
 */
export function mergeWithMarkers(baseText: string, oursText: string, theirsText: string, labels: { ours: string; theirs: string }): { text: string; conflicts: number } {
  const segments = merge3(baseText, oursText, theirsText);
  let conflicts = 0;
  const lines = segments.flatMap((s) => {
    if (s.kind === 'same') return s.lines;
    if (s.kind === 'change') return s.side === 'theirs' ? s.theirs : s.ours;
    conflicts++;
    return [`<<<<<<< ${labels.ours}`, ...s.ours, '=======', ...s.theirs, `>>>>>>> ${labels.theirs}`];
  });
  return { text: lines.join(eolOf(oursText)), conflicts };
}

/** The line ending a file uses (its first line's). */
export function eolOf(text: string): '\r\n' | '\n' {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

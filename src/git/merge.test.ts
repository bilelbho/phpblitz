import { describe, expect, it } from 'vitest';
import { act, applyNonConflicting, eolOf, mergeWithMarkers, initialStates, isResolved, matchingLine, merge3, mergedText, segmentPlaces, type ChunkState, type Segment } from './merge';

const text = (...lines: string[]) => lines.join('\n');
const conflicts = (segments: Segment[]) => segments.filter((s) => s.kind === 'conflict');
/** Applies every non-conflicting change, and resolves conflict number n (in order) as asked. */
function resolve(segments: Segment[], picks: (('ours' | 'theirs')[] | null)[] = []): (ChunkState | null)[] {
  let states = applyNonConflicting(segments, initialStates(segments), ['ours', 'theirs']);
  let c = 0;
  states = states.map((st, i) => {
    const s = segments[i];
    if (!st || s.kind !== 'conflict') return st;
    const sides = picks[c++] ?? [];
    return sides.reduce((acc, side) => act(s, acc, side, 'apply'), st);
  });
  return states;
}

describe('merge3', () => {
  const base = text('a', 'b', 'c', 'd', 'e', 'f', 'g');

  it('merges changes to different lines by itself', () => {
    const ours = text('a', 'B', 'c', 'd', 'e', 'f', 'g');
    const theirs = text('a', 'b', 'c', 'd', 'e', 'F', 'g');
    const segments = merge3(base, ours, theirs);
    expect(conflicts(segments)).toEqual([]);
    expect(mergedText(segments, resolve(segments))).toBe(text('a', 'B', 'c', 'd', 'e', 'F', 'g'));
  });

  it('takes the same change made on both sides once', () => {
    const both = text('a', 'b', 'C', 'd', 'e', 'f', 'g');
    const segments = merge3(base, both, both);
    expect(conflicts(segments)).toEqual([]);
    expect(segments.find((s) => s.kind === 'change')).toMatchObject({ side: 'both' });
    expect(mergedText(segments, resolve(segments))).toBe(both);
  });

  it('reports different changes to the same lines as a conflict', () => {
    const ours = text('a', 'b', 'OURS', 'd', 'e', 'f', 'g');
    const theirs = text('a', 'b', 'THEIRS', 'd', 'e', 'f', 'g');
    const segments = merge3(base, ours, theirs);
    expect(conflicts(segments)).toEqual([{ kind: 'conflict', base: ['c'], ours: ['OURS'], theirs: ['THEIRS'] }]);
    // Unresolved: the base lines; then each resolution.
    expect(mergedText(segments, resolve(segments))).toBe(base);
    expect(mergedText(segments, resolve(segments, [['ours']]))).toBe(ours);
    expect(mergedText(segments, resolve(segments, [['theirs']]))).toBe(theirs);
    expect(mergedText(segments, resolve(segments, [['ours', 'theirs']]))).toBe(text('a', 'b', 'OURS', 'THEIRS', 'd', 'e', 'f', 'g'));
  });

  it('treats changes to neighbouring lines on both sides as one conflict', () => {
    const ours = text('a', 'b', 'C1', 'd', 'e', 'f', 'g');
    const theirs = text('a', 'b', 'c', 'D1', 'e', 'f', 'g');
    const [conflict] = conflicts(merge3(base, ours, theirs));
    expect(conflict).toEqual({ kind: 'conflict', base: ['c', 'd'], ours: ['C1', 'd'], theirs: ['c', 'D1'] });
  });

  it('keeps one conflict per region, and merges what is between them', () => {
    const ours = text('A', 'b', 'c', 'd', 'e', 'f', 'G');
    const theirs = text('a1', 'b', 'c', 'D', 'e', 'f', 'g1');
    const segments = merge3(base, ours, theirs);
    expect(conflicts(segments).map((c) => c.kind === 'conflict' && [c.ours, c.theirs])).toEqual([
      [['A'], ['a1']],
      [['G'], ['g1']],
    ]);
    expect(mergedText(segments, resolve(segments, [['ours'], ['theirs']]))).toBe(text('A', 'b', 'c', 'D', 'e', 'f', 'g1'));
  });

  it('handles lines added at the same place on both sides', () => {
    const ours = text('a', 'b', 'mine', 'c', 'd', 'e', 'f', 'g');
    const theirs = text('a', 'b', 'yours', 'c', 'd', 'e', 'f', 'g');
    const segments = merge3(base, ours, theirs);
    expect(conflicts(segments)).toEqual([{ kind: 'conflict', base: [], ours: ['mine'], theirs: ['yours'] }]);
    expect(mergedText(segments, resolve(segments, [['theirs', 'ours']]))).toBe(text('a', 'b', 'yours', 'mine', 'c', 'd', 'e', 'f', 'g'));
  });

  it('ignores line-ending differences between the versions', () => {
    const ours = text('a', 'B', 'c', 'd', 'e', 'f', 'g').replace(/\n/g, '\r\n');
    expect(conflicts(merge3(base, ours, base))).toEqual([]);
  });

  it('merges a new base (both sides added the file) as one conflict where they differ', () => {
    const segments = merge3('', text('x', 'same'), text('y', 'same'));
    expect(conflicts(segments).length).toBe(1);
  });
});

describe('merge3 with whitespace ignored', () => {
  const base = text('if ($a) {', '    return 1;', '}');
  // Ours only re-indents; theirs changes the value on the same line.
  const ours = text('if ($a) {', '        return 1;', '}');
  const theirs = text('if ($a) {', '    return 2;', '}');

  it('is a conflict when whitespace counts', () => {
    expect(conflicts(merge3(base, ours, theirs))).toHaveLength(1);
  });

  it('merges by itself when it does not, keeping your formatting elsewhere', () => {
    const segments = merge3(base, ours, theirs, 'all');
    expect(conflicts(segments)).toEqual([]);
    expect(mergedText(segments, resolve(segments))).toBe(theirs);
    // A re-indent alone is no change: the result keeps your side's lines around the changes.
    const reindented = merge3(text('a', 'b'), text('  a', 'b'), text('a', 'B'), 'all');
    expect(mergedText(reindented, resolve(reindented))).toBe(text('  a', 'B'));
  });
});

describe('chunk states', () => {
  const base = text('a', 'b', 'c', 'd', 'e', 'f', 'g');
  // A change from ours (b), a conflict (d), a change from theirs (f).
  const segments = merge3(base, text('a', 'B', 'c', 'D1', 'e', 'f', 'g'), text('a', 'b', 'c', 'D2', 'e', 'F', 'g'));

  it('starts with nothing applied: the result is the base', () => {
    const states = initialStates(segments);
    expect(mergedText(segments, states)).toBe(base);
    expect(states.filter((s) => s && !isResolved(s)).length).toBe(3);
  });

  it('applies the non-conflicting changes of one side or both', () => {
    const left = applyNonConflicting(segments, initialStates(segments), ['ours']);
    expect(mergedText(segments, left)).toBe(text('a', 'B', 'c', 'd', 'e', 'f', 'g'));
    const all = applyNonConflicting(segments, initialStates(segments), ['ours', 'theirs']);
    expect(mergedText(segments, all)).toBe(text('a', 'B', 'c', 'd', 'e', 'F', 'g'));
    // The conflict is still open.
    expect(all.filter((s) => s && !isResolved(s)).length).toBe(1);
  });

  it('resolves a conflict by ignoring one side and applying the other', () => {
    const i = segments.findIndex((s) => s.kind === 'conflict');
    let st = initialStates(segments)[i]!;
    st = act(segments[i], st, 'ours', 'ignore');
    expect(isResolved(st)).toBe(false);
    st = act(segments[i], st, 'theirs', 'apply');
    expect(isResolved(st)).toBe(true);
    expect(st.applied).toEqual(['theirs']);
  });
});

describe('segmentPlaces and matchingLine', () => {
  // same(a b) · conflict(c → OURS1 OURS2 | THEIRS) · same(d e f g)
  const segments = merge3(text('a', 'b', 'c', 'd', 'e', 'f', 'g'), text('a', 'b', 'OURS1', 'OURS2', 'd', 'e', 'f', 'g'), text('a', 'b', 'THEIRS', 'd', 'e', 'f', 'g'));

  it('places each segment in the three panes', () => {
    const places = segmentPlaces(segments, initialStates(segments));
    expect(places[1]).toEqual({ ours: { start: 3, count: 2 }, theirs: { start: 3, count: 1 }, result: { start: 3, count: 1 } });
    expect(places[2].ours.start).toBe(5);
    expect(places[2].theirs.start).toBe(4);
    // Resolved with both sides, the result grows.
    expect(segmentPlaces(segments, resolve(segments, [['ours', 'theirs']]))[2].result.start).toBe(6);
  });

  it('maps a line to the same place in another pane', () => {
    const places = segmentPlaces(segments, initialStates(segments));
    const ours = places.map((p) => p.ours);
    const theirs = places.map((p) => p.theirs);
    expect(matchingLine(ours, theirs, 2)).toBe(2); // before the conflict
    expect(matchingLine(ours, theirs, 4)).toBe(3); // the conflict's 2nd line: theirs has only one
    expect(matchingLine(ours, theirs, 6)).toBe(5); // after it: shifted by one
  });
});

describe('mergeWithMarkers', () => {
  const base = text('a', 'b', 'c', 'd');
  it('merges both sides by itself where they don’t meet, keeping ours’s line endings', () => {
    const r = mergeWithMarkers(base, text('A', 'b', 'c', 'd').replace(/\n/g, '\r\n'), text('a', 'b', 'c', 'D'), { ours: 'Yours', theirs: 'Shelf' });
    expect(r).toEqual({ text: ['A', 'b', 'c', 'D'].join('\r\n'), conflicts: 0 });
  });
  it('writes conflict markers where both changed the same lines', () => {
    const r = mergeWithMarkers(base, text('a', 'X', 'c', 'd'), text('a', 'Y', 'c', 'd'), { ours: 'Yours', theirs: 'Shelf' });
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(text('a', '<<<<<<< Yours', 'X', '=======', 'Y', '>>>>>>> Shelf', 'c', 'd'));
  });
});

describe('eolOf', () => {
  it('tells CRLF from LF', () => {
    expect(eolOf('a\r\nb')).toBe('\r\n');
    expect(eolOf('a\nb')).toBe('\n');
    expect(eolOf('one line')).toBe('\n');
  });
});

describe('merge3 ignoring empty lines and imports', () => {
  const kinds = (s: Segment[]) => s.map((x) => (x.kind === 'change' ? `change:${x.side}` : x.kind));

  it('a conflict that differs only in empty lines is your change', () => {
    const base = 'a\nb\nc';
    const ours = 'a\nB\n\nc';
    const theirs = 'a\nB\nc';
    expect(kinds(merge3(base, ours, theirs, 'all'))).toContain('conflict');
    const s = merge3(base, ours, theirs, 'all-empty');
    expect(kinds(s)).toEqual(['same', 'change:ours', 'same']);
    expect(mergedText(s, applyNonConflicting(s, initialStates(s), ['ours', 'theirs']), '\n')).toBe('a\nB\n\nc');
  });

  it('a change that is only imports counts as unchanged', () => {
    const base = '<?php\nuse A;\nf();';
    const theirs = '<?php\nuse A;\nuse B;\nf();';
    expect(kinds(merge3(base, base, theirs, 'all-empty'))).toEqual(['same', 'change:theirs', 'same']);
    expect(kinds(merge3(base, base, theirs, 'imports'))).toEqual(['same']);
  });

  it('real conflicts stay conflicts', () => {
    expect(kinds(merge3('a\nb\nc', 'a\nX\nc', 'a\nY\nc', 'all-empty'))).toContain('conflict');
  });
});

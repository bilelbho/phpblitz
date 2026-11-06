import { describe, expect, it } from 'vitest';
import { diffLines, oldLineOf } from './diff';

const lines = (s: string) => s.split('');

describe('diffLines', () => {
  it('finds nothing in equal texts', () => {
    expect(diffLines(lines('abc'), lines('abc'))).toEqual([]);
  });

  it('marks added, modified and deleted lines', () => {
    expect(diffLines(lines('abc'), lines('abXc'))).toEqual([{ start: 3, count: 1, oldLines: [], oldStart: 3, kind: 'added' }]);
    expect(diffLines(lines('abc'), lines('aXc'))).toEqual([{ start: 2, count: 1, oldLines: ['b'], oldStart: 2, kind: 'modified' }]);
    expect(diffLines(lines('abc'), lines('ac'))).toEqual([{ start: 2, count: 0, oldLines: ['b'], oldStart: 2, kind: 'deleted' }]);
  });

  it('maps a line back to the old text', () => {
    // a b c d e  →  a X Y c e (b changed into two lines, d deleted)
    const hunks = diffLines(lines('abcde'), lines('aXYce'));
    const old = [1, 2, 3, 4, 5].map((l) => oldLineOf(hunks, l));
    expect(old).toEqual([1, null, null, 3, 5]);
  });

  it('keeps separate edits apart', () => {
    const hunks = diffLines(lines('abcdefgh'), lines('aXcdefgYh'));
    expect(hunks.map((h) => [h.kind, h.start, h.count])).toEqual([
      ['modified', 2, 1],
      ['added', 8, 1],
    ]);
  });
});

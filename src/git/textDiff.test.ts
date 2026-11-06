import { describe, expect, it } from 'vitest';
import { innerRanges, lineChanges, movedBlocks, partsOf, splitChanges } from './textDiff';

describe('lineChanges', () => {
  const a = ['<?php', 'function f() {', '    return 1;', '}'];

  it('finds changed blocks', () => {
    const b = ['<?php', 'function f() {', '    return 2;', '}'];
    expect(lineChanges(a, b)).toEqual([{ a0: 2, a1: 3, b0: 2, b1: 3 }]);
  });

  it('trims or ignores whitespace by mode', () => {
    const indented = ['<?php', 'function f() {', '        return 1;  ', '}'];
    expect(lineChanges(a, indented, 'none')).toHaveLength(1);
    expect(lineChanges(a, indented, 'trim')).toEqual([]);
    const spaced = ['<?php', 'function f () {', '    return 1;', '}'];
    expect(lineChanges(a, spaced, 'trim')).toHaveLength(1);
    expect(lineChanges(a, spaced, 'all')).toEqual([]);
  });

  it('ignores added or removed empty lines', () => {
    const b = ['<?php', '', 'function f() {', '    return 1;', '', '}'];
    expect(lineChanges(a, b, 'all')).toHaveLength(2);
    expect(lineChanges(a, b, 'all-empty')).toEqual([]);
  });

  it('maps changes back to the real lines when lines are left out', () => {
    const b = ['<?php', '', 'function f() {', '    return 2;', '}'];
    expect(lineChanges(a, b, 'all-empty')).toEqual([{ a0: 2, a1: 3, b0: 3, b1: 4 }]);
  });

  it('ignores imports and formatting', () => {
    const x = ['<?php', 'use App\\Models\\User;', 'use App\\Models\\Post;', '', 'class A {}'];
    const y = ['<?php', 'use App\\Models\\Post;', 'use App\\Models\\User;', 'use Illuminate\\Support\\Str;', 'class  A  {}'];
    expect(lineChanges(x, y, 'all')).not.toEqual([]);
    expect(lineChanges(x, y, 'imports')).toEqual([]);
  });
});

describe('innerRanges', () => {
  it('highlights the words that changed', () => {
    const r = innerRanges(['return $this->amount;'], ['return $this->total;'], 'words');
    expect(r).toEqual([
      { side: 'a', line: 0, start: 14, end: 20 },
      { side: 'b', line: 0, start: 14, end: 19 },
    ]);
  });

  it('highlights single characters', () => {
    const r = innerRanges(['$total = 10;'], ['$total = 15;'], 'chars');
    expect(r).toEqual([
      { side: 'a', line: 0, start: 10, end: 11 },
      { side: 'b', line: 0, start: 10, end: 11 },
    ]);
  });

  it('leaves whitespace out when it does not count', () => {
    expect(innerRanges(['a  =  1;'], ['a = 1;'], 'words', 'trim')).toEqual([]);
    expect(innerRanges(['a  =  1;'], ['a = 1;'], 'words', 'none').length).toBeGreaterThan(0);
  });
});

describe('splitChanges', () => {
  it('splits a block into one change per changed line pair', () => {
    const a = ['x', 'one', 'two', 'three', 'y'];
    const b = ['x', 'ONE', 'two', 'THREE', 'y'];
    const blocks = [{ a0: 1, a1: 4, b0: 1, b1: 4 }];
    expect(splitChanges(blocks, a, b, 'none')).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2 },
      { a0: 3, a1: 4, b0: 3, b1: 4 },
    ]);
  });
});

describe('partsOf', () => {
  it('alternates unchanged and changed stretches over both texts', () => {
    const parts = partsOf([{ a0: 2, a1: 3, b0: 2, b1: 4 }], 5, 6);
    expect(parts).toEqual([
      { changed: false, a: { start: 1, count: 2 }, b: { start: 1, count: 2 } },
      { changed: true, a: { start: 3, count: 1 }, b: { start: 3, count: 2 } },
      { changed: false, a: { start: 4, count: 2 }, b: { start: 5, count: 2 } },
    ]);
  });
});

describe('movedBlocks', () => {
  const fn = (name: string) => [`function ${name}($items)`, '{', `    return count($items) + strlen('${name}');`, '}'];
  const moved = (a: string[], b: string[]) => movedBlocks(a, b, lineChanges(a, b));

  it('finds a function moved further down, re-indented', () => {
    const a = [...fn('first'), '', ...fn('second'), '', 'echo 1;'];
    const b = [...fn('second'), '', 'echo 1;', '', ...fn('first').map((l) => '  ' + l)];
    const m = moved(a, b);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ a0: 0, a1: 4, b0: 7, b1: 11 });
  });

  it('ignores small or trivial blocks, and code that was only deleted', () => {
    expect(moved(['a', '}', 'x();', 'b'], ['a', 'b', '}', 'x();'])).toEqual([]);
    expect(moved([...fn('gone'), 'rest'], ['rest'])).toEqual([]);
  });

  it('uses each line once', () => {
    const keep = ['k1', 'k2', 'k3', 'k4', 'k5'];
    const a = [...fn('one'), ...keep];
    const b = [...keep, ...fn('one'), ...fn('one')];
    expect(moved(a, b)).toHaveLength(1);
  });
});

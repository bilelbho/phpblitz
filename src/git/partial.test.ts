import { describe, expect, it } from 'vitest';
import { changeKeys, contentToCommit } from './partial';

const head = ['<?php', 'a = 1;', 'b = 2;', 'c = 3;', 'd = 4;', 'e = 5;'];
const work = ['<?php', 'a = 10;', 'b = 2;', 'c = 3;', 'NEW', 'd = 4;', 'e = 50;'];

describe('partial commits', () => {
  const keys = changeKeys(head, work);

  it('names each change', () => {
    expect(keys.map((k) => k.change)).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2 },
      { a0: 4, a1: 4, b0: 4, b1: 5 },
      { a0: 5, a1: 6, b0: 6, b1: 7 },
    ]);
  });

  it('commits everything when nothing is left out', () => {
    expect(contentToCommit(head, work, new Set())).toBe(work.join('\n'));
  });

  it('keeps HEAD where a change is left out', () => {
    const left = new Set([keys[1].key]);
    expect(contentToCommit(head, work, left).split('\n')).toEqual(['<?php', 'a = 10;', 'b = 2;', 'c = 3;', 'd = 4;', 'e = 50;']);
    const onlyFirst = new Set([keys[1].key, keys[2].key]);
    expect(contentToCommit(head, work, onlyFirst, '\r\n')).toBe(['<?php', 'a = 10;', 'b = 2;', 'c = 3;', 'd = 4;', 'e = 5;'].join('\r\n'));
  });

  it('tells repeated identical changes apart', () => {
    const h = ['x', 'same', 'y', 'same', 'z'];
    const w = ['x', 'other', 'y', 'other', 'z'];
    const k = changeKeys(h, w);
    expect(k).toHaveLength(2);
    expect(k[0].key).not.toBe(k[1].key);
    expect(contentToCommit(h, w, new Set([k[1].key]))).toBe(['x', 'other', 'y', 'same', 'z'].join('\n'));
  });
});

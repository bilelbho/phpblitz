import { describe, expect, it } from 'vitest';
import { moveStep, rebaseProblem, rebaseTodo, type RebaseStep } from './rebase';

const steps: RebaseStep[] = [
  { hash: 'aaa', action: 'pick' },
  { hash: 'bbb', action: 'reword', message: 'Better subject' },
  { hash: 'ccc', action: 'fixup' },
  { hash: 'ddd', action: 'drop' },
];

describe('interactive rebase', () => {
  it('writes the todo, rewording through an exec line', () => {
    expect(rebaseTodo(steps, (i) => `C:/repo/.git/msg-${i}`)).toBe(
      ['pick aaa', 'pick bbb', 'exec git commit --amend --allow-empty --quiet --file "C:/repo/.git/msg-1"', 'fixup ccc', 'drop ddd', ''].join('\n'),
    );
  });

  it('refuses steps git would stop on', () => {
    expect(rebaseProblem(steps)).toBeNull();
    expect(rebaseProblem([{ hash: 'a', action: 'squash' }, { hash: 'b', action: 'pick' }])).toMatch(/first commit/);
    expect(rebaseProblem([{ hash: 'a', action: 'drop' }, { hash: 'b', action: 'fixup' }])).toMatch(/first commit/);
    expect(rebaseProblem([{ hash: 'a', action: 'drop' }])).toMatch(/dropped/);
    expect(rebaseProblem([{ hash: 'a', action: 'reword', message: '  ' }])).toMatch(/message/);
  });

  it('moves steps within the list', () => {
    expect(moveStep(steps, 1, -1).map((s) => s.hash)).toEqual(['bbb', 'aaa', 'ccc', 'ddd']);
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 3, 1)).toBe(steps);
  });
});

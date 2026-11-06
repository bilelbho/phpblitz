import { beforeEach, describe, expect, it } from 'vitest';
import type { Problem } from './backend/types';
import { checkedLanguages, levelOf, setLevel, shownProblems } from './highlightLevel';

const p = (message: string, category?: Problem['category']): Problem => ({ path: 'a.php', line: 1, message, severity: 'error', category });
const problems = [p('Unexpected token', 'syntax'), p('Undefined variable $x', 'analysis'), p('syntax error, unexpected end of file'), p('Unused import', 'lint')];

beforeEach(() => {
  setLevel('a.php', 'php', 'all');
});

describe('highlighting level', () => {
  it('shows every problem by default', () => {
    expect(levelOf('a.php', 'php')).toBe('all');
    expect(shownProblems('a.php', problems)).toHaveLength(4);
  });

  it('keeps only syntax errors at Syntax (tagged by Mago, or said in the message)', () => {
    setLevel('a.php', 'php', 'syntax');
    expect(shownProblems('a.php', problems).map((x) => x.message)).toEqual(['Unexpected token', 'syntax error, unexpected end of file']);
  });

  it('shows none at None, for that file only', () => {
    setLevel('a.php', 'php', 'none');
    expect(shownProblems('a.php', problems)).toEqual([]);
    expect(shownProblems('b.php', problems)).toHaveLength(4);
  });

  it('offers the languages a file is checked in', () => {
    expect(checkedLanguages('src/User.php')).toEqual(['php']);
    expect(checkedLanguages('app.ts')).toEqual(['typescript']);
    expect(checkedLanguages('app.jsx')).toEqual(['javascript']);
    expect(checkedLanguages('README.md')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { splitAnswer, tokens } from './answer';
import { stripFences } from './client';
import { fileExcerpt } from './context';
import { trimOverlap } from './ghost';

describe('splitAnswer', () => {
  it('separates text and code blocks', () => {
    const answer = 'Use a scope:\n\n```php\npublic function scopeActive($q)\n{\n    return $q;\n}\n```\n\nThen call `User::active()`.';
    expect(splitAnswer(answer)).toEqual([
      { kind: 'text', text: 'Use a scope:\n\n' },
      { kind: 'code', lang: 'php', code: 'public function scopeActive($q)\n{\n    return $q;\n}', closed: true },
      { kind: 'text', text: '\n\nThen call `User::active()`.' },
    ]);
  });

  it('keeps a block that is still streaming open', () => {
    expect(splitAnswer('Here:\n```ts\nconst a = 1;\n')).toEqual([
      { kind: 'text', text: 'Here:\n' },
      { kind: 'code', lang: 'ts', code: 'const a = 1;\n', closed: false },
    ]);
  });

  it('handles several blocks and blocks without a language', () => {
    const parts = splitAnswer('```\na\n```\n```sql\nselect 1\n```');
    expect(parts).toEqual([
      { kind: 'code', lang: '', code: 'a', closed: true },
      { kind: 'code', lang: 'sql', code: 'select 1', closed: true },
    ]);
  });
});

describe('helpers', () => {
  it('strips one fence around the whole answer only', () => {
    expect(stripFences('```php\n$a = 1;\n```')).toBe('$a = 1;');
    expect(stripFences('$a = 1;')).toBe('$a = 1;');
    expect(stripFences('text ```php\nx\n``` more')).toBe('text ```php\nx\n``` more');
  });

  it('cuts long files around the caret', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(fileExcerpt(text, 1)).toEqual({ text, firstLine: 1, cut: false });
    const part = fileExcerpt(text, 500, 200);
    expect(part.cut).toBe(true);
    expect(part.text).toContain('line 500');
    expect(part.firstLine).toBeGreaterThan(480);
    expect(part.text.length).toBeLessThanOrEqual(210);
  });

  it('drops what the suffix already has from ghost text', () => {
    expect(trimOverlap('$user->save();\n}', '}\n')).toBe('$user->save();');
    expect(trimOverlap('return $a;', '\n}')).toBe('return $a;');
  });

  it('formats token counts', () => {
    expect(tokens(950)).toBe('950');
    expect(tokens(1234)).toBe('1.2k');
    expect(tokens(23456)).toBe('23k');
  });
});

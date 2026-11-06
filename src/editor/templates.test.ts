import { describe, expect, it } from 'vitest';
import { BUILTIN_LIVE, BUILTIN_POSTFIX, expressionBefore, inHtmlOfPhp, inPhpCode, liveTemplates, templateSnippet } from './templates';

const body = (abbr: string) => BUILTIN_LIVE.find((t) => t.abbr === abbr)!.body;
const postfix = (key: string) => BUILTIN_POSTFIX.find((t) => t.key === key)!.body;

describe('templateSnippet', () => {
  it('makes fields, keeps PHP variables and indents in the editor unit', () => {
    expect(templateSnippet(body('fore'), '\t')).toBe('foreach (\\$${1:items} as \\$${2:item}) {\n\t$0\n}');
    expect(templateSnippet(body('fori'), '  ')).toBe('for (\\$${1:i} = 0; \\$$1 < ${2:count}; \\$$1++) {\n  $0\n}');
    expect(templateSnippet(body('thr'), '    ')).toBe("throw new ${1:\\\\RuntimeException}('${2:message}');");
  });
  it('puts the expression in postfix templates', () => {
    expect(templateSnippet(postfix('fore'), '    ', '$user->posts()')).toBe('foreach (\\$user->posts() as \\$${1:item}) {\n    $0\n}');
    expect(templateSnippet(postfix('nn'), '    ', '$x')).toBe('if (\\$x !== null) {\n    $0\n}');
  });
});

describe('liveTemplates', () => {
  it('drops turned-off ones; the user’s win on the same abbreviation', () => {
    const all = liveTemplates([{ abbr: 'fore', description: 'mine', body: 'x' }, { abbr: 'bad abbr', description: '', body: 'y' }], ['vd']);
    expect(all.filter((t) => t.abbr === 'fore').map((t) => t.description)).toEqual(['mine']);
    expect(all.some((t) => t.abbr === 'vd' || t.abbr === 'bad abbr')).toBe(false);
  });
});

describe('expressionBefore', () => {
  const at = (s: string) => expressionBefore(s, s.length)?.text ?? null;
  it('finds variables, chains, calls, indexes and static calls', () => {
    expect(at('    $items')).toBe('$items');
    expect(at('return $this->user->posts()[0]')).toBe('$this->user->posts()[0]');
    expect(at('x = User::query()->where("a", f($b))')).toBe('User::query()->where("a", f($b))');
    expect(at('strtoupper($s)')).toBe('strtoupper($s)');
    expect(at('$a?->b')).toBe('$a?->b');
  });
  it('refuses words and numbers', () => {
    expect(at('echo foo')).toBeNull();
    expect(at('1.5')).toBeNull();
    expect(at('call(')).toBeNull();
  });
});

describe('inPhpCode', () => {
  const t = '<p><?php $a = "it\'s"; // note\n/* c */ $b ?></p>';
  const at = (needle: string, after = 0) => inPhpCode(t, t.indexOf(needle) + after);
  it('tells code from strings, comments and the HTML around', () => {
    expect(at('$a')).toBe(true);
    expect(at('s"')).toBe(false);
    expect(at('note')).toBe(false);
    expect(at(' c ')).toBe(false);
    expect(at('$b')).toBe(true);
    expect(at('</p>')).toBe(false);
    expect(at('<p>', 1)).toBe(false);
    expect(inHtmlOfPhp(t, t.indexOf('</p>'))).toBe(true);
    expect(inHtmlOfPhp(t, t.indexOf('$a'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { BUILTIN_SURROUND, isInline, surroundKey, surroundSnippet, surroundTemplates } from './surround';

const body = (label: string) => BUILTIN_SURROUND.find((t) => t.label === label)!.body;

describe('Surround With', () => {
  it("wraps lines one level deeper, at the first line's indentation", () => {
    const snippet = surroundSnippet(body('if'), '        $a = 1;\n            $b = 2;', '        ', '    ');
    expect(snippet).toBe('        if (${1:condition}) {\n            \\$a = 1;\n                \\$b = 2;\n        }');
  });

  it('keeps PHP variables as text and shares fields with the same name', () => {
    expect(surroundSnippet(body('for'), 'x();', '', '    ')).toBe('for (\\$${1:i} = 0; \\$$1 < ${2:count}; \\$$1++) {\n    x();\n}');
    expect(surroundSnippet(body('try / catch'), 'x();', '', '\t')).toBe('try {\n\tx();\n} catch (${1:\\\\Throwable} \\$${2:e}) {\n\t$0\n}');
  });

  it('indents nested levels of the template (switch: two levels)', () => {
    expect(surroundSnippet(body('switch'), 'x();', '', '  ')).toBe('switch (${1:value}) {\n  case ${2:case}:\n    x();\n    break;\n}');
  });

  it('wraps text inside a line for inline templates', () => {
    expect(isInline(body('isset()'))).toBe(true);
    expect(isInline(body('foreach'))).toBe(false);
    expect(surroundSnippet(body('isset()'), '$user->name', '    ', '    ')).toBe('isset(\\$user->name)');
  });

  it("lists built-ins not hidden, then the user's valid templates, with keys", () => {
    const list = surroundTemplates([{ label: 'unless', body: 'if (!$C$) {\n    $SELECTION$\n}' }, { label: 'broken', body: 'no selection' }], ['while']);
    expect(list.some((t) => t.label === 'while')).toBe(false);
    expect(list[list.length - 1].label).toBe('unless');
    expect(list.some((t) => t.label === 'broken')).toBe(false);
    expect([0, 9, 10].map(surroundKey)).toEqual(['1', '0', 'a']);
  });
});

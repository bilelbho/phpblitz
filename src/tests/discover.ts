// Tests in a PHP file, for the editor's gutter run icons and "run the test at the caret":
// PHPUnit test classes and their test methods (test* names, #[Test], @test), and Pest's test() /
// it() calls inside describe() blocks. Also the --filter patterns that run exactly those tests.

export interface FoundTest {
  kind: 'class' | 'method' | 'pest';
  /** 1-based line of the declaration / call. */
  line: number;
  /** Last line of its body, when known (the caret inside it means "this test"). */
  endLine: number;
  /** What the gutter menu calls it: CalculatorTest, testAdds, it adds numbers. */
  label: string;
  /** PHPUnit: the class without a leading backslash (Tests\CalculatorTest). */
  className?: string;
  /** PHPUnit method, or Pest's full test name (`describe` → it does…). */
  testName?: string;
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Blanks out strings and comments (keeping line breaks and lengths) so braces can be counted. */
function codeOnly(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if ((c === '/' && next === '/') || (c === '#' && next !== '[')) {
      for (; i < text.length && text[i] !== '\n'; i++) out += ' ';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === '\n' ? '\n' : ' ';
    } else if (c === "'" || c === '"') {
      out += c;
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') {
          out += ' ';
          i++;
        }
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < text.length) {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Line (1-based) where the block opened at or after `offset` closes. */
function blockEnd(code: string, offset: number): number {
  const open = code.indexOf('{', offset);
  if (open < 0) return lineAt(code, offset);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return lineAt(code, i);
  }
  return lineAt(code, code.length);
}

function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

export function findTests(text: string): FoundTest[] {
  const code = codeOnly(text);
  const out: FoundTest[] = [];
  const ns = /^\s*namespace\s+([\w\\]+)\s*;/m.exec(text)?.[1];

  // PHPUnit classes.
  const classRe = /^[ \t]*((?:(?:final|abstract|readonly)\s+)*)class\s+(\w+)\s+extends\s+([\w\\]+)/gm;
  for (let m = classRe.exec(code); m; m = classRe.exec(code)) {
    if (/abstract/.test(m[1])) continue;
    const [, , name, parent] = m;
    if (!/Test$/.test(name) && !/TestCase$/.test(parent)) continue;
    const className = ns ? `${ns}\\${name}` : name;
    const start = m.index;
    const endLine = blockEnd(code, start);
    out.push({ kind: 'class', line: lineAt(code, start + m[0].indexOf('class')), endLine, label: name, className });
    // Its test methods: test* names, or marked #[Test] / @test just above.
    const body = code.slice(start, offsetOfLine(code, endLine + 1));
    const methodRe = /^[ \t]*((?:(?:public|final|static)\s+)*)function\s+(\w+)\s*\(/gm;
    for (let f = methodRe.exec(body); f; f = methodRe.exec(body)) {
      const method = f[2];
      if (/static/.test(f[1])) continue;
      const at = start + f.index;
      const before = text.slice(Math.max(0, text.lastIndexOf('}', at - 1), text.lastIndexOf(';', at - 1), text.lastIndexOf('{', at - 1)), at);
      const marked = /#\[\s*(?:\\?PHPUnit\\Framework\\Attributes\\)?Test\s*[\](]/.test(before) || /@test\b/.test(before);
      if (!method.startsWith('test') && !marked) continue;
      const line = lineAt(code, at + f[0].indexOf('function'));
      out.push({ kind: 'method', line, endLine: blockEnd(code, at), label: method, className, testName: method });
    }
  }
  if (out.length) return out;

  // Pest: test('…') / it('…'), with the describe('…') blocks around them.
  const describes: { name: string; end: number }[] = [];
  const callRe = /^[ \t]*(describe|test|it)\s*\(\s*(['"])((?:\\.|(?!\2).)*)\2/gm;
  for (let m = callRe.exec(text); m; m = callRe.exec(text)) {
    const line = lineAt(text, m.index);
    while (describes.length && describes[describes.length - 1].end < line) describes.pop();
    const desc = m[3].replace(/\\(['"\\])/g, '$1');
    const endLine = blockEnd(code, m.index);
    if (m[1] === 'describe') {
      describes.push({ name: desc, end: endLine });
      continue;
    }
    const own = m[1] === 'it' ? `it ${desc}` : desc;
    const testName = [...describes.map((d) => `\`${d.name}\``), own].join(' → ');
    out.push({ kind: 'pest', line, endLine, label: own, testName });
  }
  return out;
}

function offsetOfLine(text: string, line: number): number {
  let offset = 0;
  for (let n = 1; n < line; n++) {
    const i = text.indexOf('\n', offset);
    if (i < 0) return text.length;
    offset = i + 1;
  }
  return offset;
}

/** The innermost test around a line: a method / Pest test, else the class. */
export function testAt(tests: FoundTest[], line: number): FoundTest | null {
  const around = tests.filter((t) => line >= t.line && line <= t.endLine);
  return around.sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0] ?? null;
}

/** PHPUnit --filter for these tests: `Class::method` names (each with any data set), or exact names. */
export function phpunitFilter(tests: { className: string; name: string; exact?: boolean }[]): string {
  const parts = tests.map((t) => escapeRegex(`${t.className.replace(/^\\/, '')}::${t.name}`) + (t.exact ? '' : '( with data set .*)?'));
  return `/^(?:${parts.join('|')})$/`;
}

/**
 * Pest --filter: matched against the test's name, which Pest prefixes internally (no ^). Pest turns
 * each test into a method named after its description, so one data set can't be picked out: a test
 * runs with all of its data sets.
 */
export function pestFilter(names: string[]): string {
  const parts = [...new Set(names)].map((n) => escapeRegex(n) + '( with data set .*)?');
  return `(?:${parts.join('|')})$`;
}

import { describe, expect, it } from 'vitest';
import { coverageTree, keptOf, parseClover, percent, reportOf } from './coverage';

const CLOVER = `<?xml version="1.0" encoding="UTF-8"?>
<coverage generated="1762400000">
  <project timestamp="1762400000">
    <package name="App">
      <file name="/app/src/Models/User.php">
        <class name="App\\Models\\User" namespace="App\\Models">
          <metrics complexity="2" methods="2" coveredmethods="1" statements="3" coveredstatements="2" elements="5" coveredelements="3"/>
        </class>
        <line num="8" type="method" name="name" visibility="public" complexity="1" crap="1" count="4"/>
        <line num="10" type="stmt" count="4"/>
        <line num="13" type="method" name="greet" visibility="public" complexity="1" crap="2" count="0"/>
        <line num="15" type="stmt" count="0"/>
        <line num="16" type="stmt" count="2"/>
      </file>
    </package>
    <file name="/app/src/Models/Post.php">
      <line num="5" type="stmt" count="1"/>
    </file>
    <file name="/app/src/helpers.php">
      <line num="3" type="stmt" count="0"/>
      <line num="4" type="stmt" count="0"/>
    </file>
  </project>
</coverage>`;

describe('parseClover', () => {
  it('reads lines hit per file, methods apart', () => {
    const files = parseClover(CLOVER, (p) => p.replace(/^\/app/, 'C:/p'));
    const user = files.get('C:/p/src/Models/User.php')!;
    expect([...user.lines]).toEqual([
      [10, 4],
      [15, 0],
      [16, 2],
    ]);
    expect(user).toMatchObject({ statements: 3, coveredStatements: 2, methods: 2, coveredMethods: 1 });
    expect(files.get('C:/p/src/helpers.php')).toMatchObject({ statements: 2, coveredStatements: 0 });
  });

  it('adds up one file listed twice and maps Windows paths', () => {
    const xml = `<coverage><project>
      <file name="C:\\p\\a.php"><line num="1" type="stmt" count="0"/><line num="2" type="stmt" count="1"/></file>
      <file name="C:\\p\\a.php"><line num="1" type="stmt" count="3"/><line num="9" type="method" count="1"/></file>
    </project></coverage>`;
    const a = parseClover(xml).get('C:/p/a.php')!;
    expect(a).toMatchObject({ statements: 2, coveredStatements: 2, methods: 1, coveredMethods: 1 });
  });
});

describe('coverageTree', () => {
  it('sums folders, lists folders first and joins single-folder chains', () => {
    const files = parseClover(CLOVER, (p) => p.replace(/^\/app/, 'C:/p'));
    const top = coverageTree(files.values(), 'C:/p');
    expect(top).toMatchObject({ statements: 6, coveredStatements: 3, methods: 2, coveredMethods: 1 });
    const src = top.children[0];
    expect(src.name).toBe('src');
    expect(src.children.map((c) => c.name)).toEqual(['Models', 'helpers.php']);
    expect(src.children[0]).toMatchObject({ path: 'C:/p/src/Models', statements: 4, coveredStatements: 3 });
    expect(src.children[0].children.map((c) => c.name)).toEqual(['Post.php', 'User.php']);

    const deep = coverageTree(parseClover('<file name="/r/app/Http/Controllers/A.php"><line num="1" type="stmt" count="1"/></file>').values(), '/r');
    expect(deep.children[0]).toMatchObject({ name: 'app/Http/Controllers', path: '/r/app/Http/Controllers' });
  });

  it('formats percentages', () => {
    expect(percent(2, 3)).toBe('66%');
    expect(percent(0, 0)).toBe('–');
  });
});

describe('kept coverage', () => {
  it('survives being written and read back', () => {
    const report = { label: 'PHPUnit', at: 1762400000000, files: parseClover(CLOVER) };
    const back = reportOf(JSON.parse(JSON.stringify(keptOf(report))));
    expect(back.label).toBe('PHPUnit');
    expect([...back.files.keys()]).toEqual([...report.files.keys()]);
    for (const [path, f] of report.files) expect(back.files.get(path)).toEqual(f);
  });
});

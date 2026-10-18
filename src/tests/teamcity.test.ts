import { describe, expect, it } from 'vitest';
import { TestTree, parseLocation, parseServiceMessage, stackLocations, unescapeValue } from './teamcity';

describe('service messages', () => {
  it('parses names and escaped values', () => {
    expect(parseServiceMessage("##teamcity[testFailed name='testAdds' message='Failed |'1|' |[x|]|n' flowId='7']")).toEqual({
      name: 'testFailed',
      attrs: { name: 'testAdds', message: "Failed '1' [x]\n", flowId: '7' },
    });
    expect(parseServiceMessage('plain output')).toBeNull();
    expect(unescapeValue('a|0x00e9b')).toBe('aéb');
  });

  it('splits location hints', () => {
    expect(parseLocation('php_qn:///opt/project/tests/CalcTest.php::\\Tests\\CalcTest::testAdds with data set "one"')).toEqual({
      file: '/opt/project/tests/CalcTest.php',
      className: '\\Tests\\CalcTest',
      testName: 'testAdds',
    });
    expect(parseLocation('pest_qn://tests\\Unit\\CalcTest.php::it adds')).toEqual({ file: 'tests/Unit/CalcTest.php', testName: 'it adds' });
    expect(parseLocation(undefined)).toBeNull();
  });

  it('finds file:line references in stack traces', () => {
    expect(stackLocations('Failed asserting that 2 is 3.\n\n/opt/project/tests/CalcTest.php:14\nC:\\app\\x.php:3\n')).toEqual([
      { text: '/opt/project/tests/CalcTest.php:14', file: '/opt/project/tests/CalcTest.php', line: 14 },
      { text: 'C:\\app\\x.php:3', file: 'C:/app/x.php', line: 3 },
    ]);
  });
});

describe('TestTree', () => {
  const hint = (m: string) => `php_qn:///opt/project/tests/CalcTest.php::\\Tests\\CalcTest${m}`;
  const run = [
    "##teamcity[testCount count='3' flowId='1']",
    "##teamcity[testSuiteStarted name='/opt/project/phpunit.xml' flowId='1']",
    `##teamcity[testSuiteStarted name='Tests\\CalcTest' locationHint='${hint('')}' flowId='1']`,
    `##teamcity[testStarted name='testAdds' locationHint='${hint('::testAdds')}' flowId='1']`,
    'printed by the test',
    "##teamcity[testFinished name='testAdds' duration='4' flowId='1']",
    `##teamcity[testStarted name='testSubtracts' locationHint='${hint('::testSubtracts')}' flowId='1']`,
    "##teamcity[testFailed name='testSubtracts' message='Failed asserting that 2 matches expected 3.' details='/opt/project/tests/CalcTest.php:20|n' type='comparisonFailure' expected='3' actual='2' flowId='1']",
    "##teamcity[testFinished name='testSubtracts' duration='2' flowId='1']",
    `##teamcity[testStarted name='testDivides' locationHint='${hint('::testDivides')}' flowId='1']`,
    "##teamcity[testFailed name='testDivides' message='DivisionByZeroError: Division by zero' details='' flowId='1']",
    "##teamcity[testFinished name='testDivides' duration='1' flowId='1']",
    "##teamcity[testSuiteFinished name='Tests\\CalcTest' flowId='1']",
    "##teamcity[testSuiteFinished name='/opt/project/phpunit.xml' flowId='1']",
  ];

  it('builds classes and tests, skipping the configuration wrapper', () => {
    const tree = new TestTree((f) => f.replace('/opt/project', 'C:/work/app'));
    run.forEach((l) => tree.line(l));
    tree.finish(1);
    expect(tree.total).toBe(3);
    const [cls] = tree.root.children;
    expect(cls).toMatchObject({ kind: 'class', name: 'CalcTest', status: 'error', duration: 7, path: 'C:/work/app/tests/CalcTest.php' });
    expect(tree.tests().map((t) => [t.testName, t.status])).toEqual([
      ['testAdds', 'passed'],
      ['testSubtracts', 'failed'],
      ['testDivides', 'error'],
    ]);
    const [adds, subtracts] = tree.tests();
    expect(adds.output).toBe('printed by the test\n');
    expect(subtracts).toMatchObject({ expected: '3', actual: '2', details: '/opt/project/tests/CalcTest.php:20\n' });
  });

  it('settles tests that were still running', () => {
    const tree = new TestTree((f) => f);
    run.slice(0, 5).forEach((l) => tree.line(l));
    tree.finish(null);
    expect(tree.tests()[0].status).toBe('ignored');
  });
});

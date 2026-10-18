import { describe, expect, it } from 'vitest';
import { findTests, pestFilter, phpunitFilter, testAt } from './discover';

const PHPUNIT = `<?php
namespace Tests\\Unit;

use PHPUnit\\Framework\\Attributes\\Test;
use PHPUnit\\Framework\\TestCase;

final class CalculatorTest extends TestCase
{
    public function testAdds(): void
    {
        $this->assertSame('}', '}'); // a } in a string and a comment
    }

    #[Test]
    public function subtracts(): void
    {
    }

    /** @test */
    public function divides(): void {}

    private function helper(): void {}

    public static function provider(): array { return []; }
}

abstract class BaseTest extends TestCase {}
`;

const PEST = `<?php
test('sums', function () {
    expect(1 + 1)->toBe(2);
});

describe('Cart', function () {
    it('adds "items"', function () {
    });
});

it('is outside', fn () => true);
`;

describe('findTests', () => {
  it('finds PHPUnit classes and test methods', () => {
    const tests = findTests(PHPUNIT);
    expect(tests.map((t) => [t.kind, t.label, t.line, t.endLine])).toEqual([
      ['class', 'CalculatorTest', 7, 25],
      ['method', 'testAdds', 9, 12],
      ['method', 'subtracts', 15, 17],
      ['method', 'divides', 20, 20],
    ]);
    expect(tests[1].className).toBe('Tests\\Unit\\CalculatorTest');
  });

  it('finds Pest tests with their describe blocks', () => {
    expect(findTests(PEST).map((t) => [t.testName, t.line])).toEqual([
      ['sums', 2],
      ['`Cart` → it adds "items"', 7],
      ['it is outside', 11],
    ]);
  });

  it('picks the innermost test at a line', () => {
    const tests = findTests(PHPUNIT);
    expect(testAt(tests, 11)?.label).toBe('testAdds');
    expect(testAt(tests, 22)?.label).toBe('CalculatorTest');
    expect(testAt(tests, 40)).toBeNull();
  });
});

describe('filters', () => {
  it('builds PHPUnit filters that allow data sets', () => {
    const f = phpunitFilter([{ className: '\\Tests\\CalcTest', name: 'testAdds' }]);
    const re = new RegExp(f.slice(1, -1));
    expect(re.test('Tests\\CalcTest::testAdds')).toBe(true);
    expect(re.test('Tests\\CalcTest::testAdds with data set "one"')).toBe(true);
    expect(re.test('Tests\\CalcTest::testAddsMore')).toBe(false);
  });

  it('builds Pest filters without duplicates', () => {
    expect(pestFilter(['it adds', 'it adds'])).toBe('(?:it adds( with data set .*)?)$');
  });
});

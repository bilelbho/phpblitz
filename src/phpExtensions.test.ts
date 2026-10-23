import { describe, expect, it } from 'vitest';
import { requiredExtensions } from './phpExtensions';

describe('PHP extensions', () => {
  it('reads ext-* requirements from composer.json and composer.lock, with who needs them', () => {
    const json = JSON.stringify({ require: { php: '>=8.2', 'ext-intl': '*', 'symfony/mime': '^7' }, 'require-dev': { 'ext-Zend-OPcache': '*' } });
    const lock = JSON.stringify({
      packages: [
        { name: 'symfony/mime', require: { 'ext-fileinfo': '*', php: '>=8.2' } },
        { name: 'league/mime-type-detection', require: { 'ext-fileinfo': '*' } },
      ],
      'packages-dev': [{ name: 'phpunit/phpunit', require: { 'ext-dom': '*', 'ext-intl': '*' } }],
    });
    const needs = Object.fromEntries(requiredExtensions(json, lock).map((n) => [n.name, n.by]));
    expect(needs.intl).toEqual(['composer.json', 'phpunit/phpunit']);
    expect(needs.fileinfo).toEqual(['league/mime-type-detection', 'symfony/mime']);
    expect(needs['zend opcache']).toEqual(['composer.json']);
    expect(needs.openssl).toEqual(['Composer']);
    expect(needs.php).toBeUndefined();
  });

  it('needs nothing without Composer files', () => {
    expect(requiredExtensions(null, null)).toEqual([]);
    expect(requiredExtensions('not json', null).map((n) => n.name)).toEqual(['openssl']);
  });
});

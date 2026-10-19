import { describe, expect, it } from 'vitest';
import { FileResolver, findFileRefs } from './fileLinks';

const refs = (text: string) => findFileRefs(text).map((r) => [text.slice(r.start, r.end), r.path, r.line, r.column]);

describe('findFileRefs', () => {
  it('reads the usual forms of a location', () => {
    expect(refs('app/Models/User.php:42 and src/main.ts:3:7')).toEqual([
      ['app/Models/User.php:42', 'app/Models/User.php', 42, undefined],
      ['src/main.ts:3:7', 'src/main.ts', 3, 7],
    ]);
    expect(refs('PHP Fatal error:  Uncaught Error in /var/www/html/app/Models/User.php on line 42')).toEqual([
      ['/var/www/html/app/Models/User.php on line 42', '/var/www/html/app/Models/User.php', 42, undefined],
    ]);
    expect(refs('#0 /app/vendor/laravel/framework/src/Foo.php(123): Bar->baz()')[0]).toEqual(['/app/vendor/laravel/framework/src/Foo.php(123)', '/app/vendor/laravel/framework/src/Foo.php', 123, undefined]);
    expect(refs('C:\\work\\shop\\tests\\UserTest.php:17')).toEqual([['C:\\work\\shop\\tests\\UserTest.php:17', 'C:\\work\\shop\\tests\\UserTest.php', 17, undefined]]);
    expect(refs('resources/views/welcome.blade.php')).toEqual([['resources/views/welcome.blade.php', 'resources/views/welcome.blade.php', undefined, undefined]]);
  });

  it('leaves URLs, versions and plain words alone', () => {
    expect(refs('see https://example.com/docs/index.html for more')).toEqual([]);
    expect(refs('PHP 8.3.12 (cli) with Zend 4.3')).toEqual([]);
    expect(refs('OK (12 tests, 30 assertions)')).toEqual([]);
  });
});

describe('FileResolver', () => {
  const files = ['C:/work/shop/app/Models/User.php', 'C:/work/shop/app/Http/Controllers/UserController.php', 'C:/work/shop/tests/Feature/User.php', 'C:/work/shop/routes/web.php'];
  const r = new FileResolver('C:/work/shop', files);

  it('finds relative, absolute and container paths', () => {
    expect(r.resolve('app/Models/User.php', 'C:/work/shop')).toBe('C:/work/shop/app/Models/User.php');
    expect(r.resolve('../routes/web.php', 'C:/work/shop/app')).toBe('C:/work/shop/routes/web.php');
    expect(r.resolve('c:\\WORK\\shop\\routes\\web.php', 'C:/x')).toBe('C:/work/shop/routes/web.php');
    expect(r.resolve('/var/www/html/app/Models/User.php', 'C:/work/shop')).toBe('C:/work/shop/app/Models/User.php');
  });

  it('refuses unknown files and ambiguous names', () => {
    expect(r.resolve('app/Models/Order.php', 'C:/work/shop')).toBeNull();
    expect(r.resolve('User.php', 'C:/elsewhere')).toBeNull();
    expect(r.resolve('UserController.php', 'C:/elsewhere')).toBe('C:/work/shop/app/Http/Controllers/UserController.php');
  });
});

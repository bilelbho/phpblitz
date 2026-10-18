import { describe, expect, it } from 'vitest';
import { GENERATORS, defaultValues, validate } from './projectGenerators';

const byId = (id: string) => GENERATORS.find((g) => g.id === id)!;

describe('project generators', () => {
  it.each(GENERATORS.map((g) => [g.id, g] as const))('%s: the defaults are valid and give complete steps', (_id, g) => {
    // Required fields have no default (the Composer package to create from).
    const values = { ...defaultValues(g), ...Object.fromEntries(g.options.filter((o) => o.kind === 'text' && o.required).map((o) => [o.id, 'vendor/package'])) };
    expect(validate(g, 'demo-app', values)).toBe('');
    const steps = g.steps('demo-app', values);
    expect(steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(steps)).not.toMatch(/undefined|\[object Object\]/);
  });

  it('rejects folder names that would break the command line', () => {
    const laravel = byId('laravel');
    expect(validate(laravel, '', defaultValues(laravel))).toMatch(/location/);
    expect(validate(laravel, 'my app', defaultValues(laravel))).toMatch(/no spaces/);
    expect(validate(laravel, 'a:b', defaultValues(laravel))).toMatch(/can't contain/);
  });

  it('turns Laravel options into composer commands', () => {
    const laravel = byId('laravel');
    const lines = laravel.steps('shop', { ...defaultValues(laravel), sanctum: true, telescope: true, sail: true, pest: true, install: false, git: false }).map((s) => (s.kind === 'run' ? s.line : s.title));
    expect(lines).toEqual([
      'composer create-project laravel/laravel shop --no-progress --no-interaction',
      'composer require laravel/sanctum laravel/telescope --no-progress --no-interaction',
      'composer require --dev laravel/sail --no-progress --no-interaction',
      'composer remove --dev phpunit/phpunit --no-progress --no-interaction',
      'composer require --dev pestphp/pest pestphp/pest-plugin-laravel --with-all-dependencies --no-progress --no-interaction',
      'php vendor/bin/pest --init',
    ]);
  });
});

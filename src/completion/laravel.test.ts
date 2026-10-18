import { describe, expect, it } from 'vitest';
import { arrayKeys, envKeys, routeNames, stringContext, viewName } from './laravel';

describe('arrayKeys', () => {
  it('lists nested keys in dot notation with previews', () => {
    const src = `<?php
return [
    'name' => env('APP_NAME', 'Laravel'),
    'debug' => (bool) env('APP_DEBUG', false),
    'mailers' => [
        'smtp' => ['host' => '127.0.0.1', 'port' => 587],
    ],
    'list' => ['a', 'b'],
];`;
    expect(arrayKeys(src, 'app.')).toEqual([
      { key: 'app.name', preview: "env('APP_NAME', 'Laravel')" },
      { key: 'app.debug', preview: "(bool) env('APP_DEBUG', false)" },
      { key: 'app.mailers', preview: '[…]' },
      { key: 'app.mailers.smtp', preview: '[…]' },
      { key: 'app.mailers.smtp.host', preview: "'127.0.0.1'" },
      { key: 'app.mailers.smtp.port', preview: '587' },
      { key: 'app.list', preview: '[…]' },
    ]);
  });

  it('ignores files without a returned array', () => {
    expect(arrayKeys('<?php echo 1;')).toEqual([]);
  });
});

describe('routeNames', () => {
  it('reads names, group prefixes and resources', () => {
    const src = `<?php
Route::get('/', HomeController::class)->name('home');
Route::name('admin.')->group(function () {
    Route::post('users/{user}', [UserController::class, 'update'])->name('users.update');
    Route::group(['as' => 'reports.'], function () {
        Route::get('daily', fn () => 1)->name('daily');
    });
});
Route::apiResource('posts', PostController::class)->only(['index', 'show']);
Route::resource('photos', PhotoController::class)->except(['destroy']);
`;
    expect(routeNames(src)).toEqual([
      { name: 'home', detail: 'GET /' },
      { name: 'admin.users.update', detail: 'POST /users/{user}' },
      { name: 'admin.reports.daily', detail: 'GET /daily' },
      { name: 'posts.index', detail: 'apiResource posts' },
      { name: 'posts.show', detail: 'apiResource posts' },
      ...['index', 'create', 'store', 'show', 'edit', 'update'].map((a) => ({ name: `photos.${a}`, detail: 'resource photos' })),
    ]);
  });
});

describe('small parsers', () => {
  it('reads .env keys', () => {
    expect(envKeys('# comment\nAPP_NAME=Blitz\nexport DB_HOST = 127.0.0.1\n\nbroken line')).toEqual([
      { key: 'APP_NAME', preview: 'Blitz' },
      { key: 'DB_HOST', preview: '127.0.0.1' },
    ]);
  });

  it('names views', () => {
    expect(viewName('C:/work/app/resources/views/users/show.blade.php', 'C:/work/app')).toBe('users.show');
    expect(viewName('C:/work/app/resources/views/mail.php', 'C:/work/app')).toBe('mail');
    expect(viewName('C:/work/app/app/Models/User.php', 'C:/work/app')).toBeNull();
  });

  it('knows which helper string the cursor is in', () => {
    expect(stringContext("return redirect()->route('admin.us")).toEqual({ kind: 'route', typed: 'admin.us' });
    expect(stringContext("config('app.")).toEqual({ kind: 'config', typed: 'app.' });
    expect(stringContext("@include('partials.")).toEqual({ kind: 'view', typed: 'partials.' });
    expect(stringContext("Mail::send($data, 'x'); view('a', 'em")).toBeNull();
    expect(stringContext("env('DB_")).toEqual({ kind: 'env', typed: 'DB_' });
    expect(stringContext("__('auth.")).toEqual({ kind: 'trans', typed: 'auth.' });
    expect(stringContext("echo 'plain")).toBeNull();
  });
});

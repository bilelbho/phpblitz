import type { Backend, Entry, GitInfo, Package, Problem, RunResult, TestResult } from './types';

const ROOT = '/acme-shop';

const FILES: Record<string, string> = {
  'app/Http/Controllers/Controller.php': String.raw`<?php

namespace App\Http\Controllers;

abstract class Controller
{
    //
}
`,
  'app/Http/Controllers/UserController.php': String.raw`<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\InvoiceService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class UserController extends Controller
{
    public function __construct(
        private readonly InvoiceService $invoices,
    ) {}

    /**
     * Creates an invoice for the customer from the request's amount.
     *
     * @param Request $request The request, with a numeric ${'`'}amount${'`'}
     * @param User    $user    The customer to bill
     *
     * @return JsonResponse The new invoice (201 Created)
     * @throws \Illuminate\Validation\ValidationException When the amount is missing or negative
     */
    public function invoice(Request $request, User $user): JsonResponse
    {
        $validated = $request->validate([
            'amount' => ['required', 'numeric', 'min:1'],
        ]);

        $orders = $user->

        $invoice = $this->invoices->create($user, $validated['amount']);

        return response()->json($invoice, 201);
    }

    /**
     * Show a customer with their latest orders.
     */
    public function show(User $user): JsonResponse
    {
        return response()->json([
            'user' => $user,
            'orders' => $user->orders()->latest()->take(10)->get(),
        ]);
    }
}
`,
  'app/Models/User.php': String.raw`<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class User extends Model
{
    use HasFactory;

    public string $name;

    public string $email;

    public ?string $company;

    protected $fillable = ['name', 'email', 'company'];

    protected $casts = [
        'email_verified_at' => 'datetime',
        'is_admin' => 'boolean',
    ];

    public function orders(): HasMany
    {
        return $this->hasMany(Order::class);
    }

    public function invoices(): HasMany
    {
        return $this->hasMany(Invoice::class);
    }

    public function isAdmin(): bool
    {
        return $this->is_admin === true;
    }
}
`,
  'app/Services/InvoiceService.php': String.raw`<?php

namespace App\Services;

use App\Models\Invoice;
use App\Models\User;
use Illuminate\Support\Facades\DB;

final class InvoiceService
{
    public function __construct(
        private readonly TaxCalculator $tax,
    ) {}

    public function create(User $user, float $amount): Invoice
    {
        return DB::transaction(function () use ($user, $amount) {
            $total = $amount + $this->tax->for($user, $amount);

            return $user->invoices()->create([
                'amount' => $amount,
                'total' => $total,
                'status' => 'pending',
            ]);
        });
    }
}
`,
  'routes/web.php': String.raw`<?php

use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

Route::get('/', fn () => view('welcome'));

Route::middleware('auth')->group(function () {
    Route::get('/users/{user}', [UserController::class, 'show']);
    Route::post('/users/{user}/invoice', [UserController::class, 'invoice']);
});
`,
  'tests/Feature/InvoiceTest.php': String.raw`<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class InvoiceTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_creates_an_invoice_including_tax(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->postJson("/users/{$user->id}/invoice", ['amount' => 100])
            ->assertCreated()
            ->assertJsonPath('status', 'pending');
    }
}
`,
  // Lines joined below: code fences need backticks, which a template literal can't hold as is.
  'README.md': [
    '# Acme Shop (Laravel)',
    '',
    'PHP 8.3 · Laravel 11 · SQLite. A small shop used as the PHPBlitz sample project.',
    '',
    '## Start',
    '',
    '```bash',
    'composer install',
    'php artisan migrate --seed',
    'php artisan serve',
    '```',
    '',
    '> Invoices are created by `InvoiceService`; see [the controller](app/Http/Controllers/UserController.php).',
    '',
    '## Code quality',
    '',
    '| Command | What it does |',
    '|---|---|',
    '| `composer test` | Run the PHPUnit tests |',
    '| `composer lint` | Check code style with Pint |',
    '',
    '- [x] Users and invoices',
    '- [ ] Payments',
    '',
    'More on [Laravel](https://laravel.com/docs).',
    '',
  ].join('\n'),
  'composer.json': String.raw`{
    "name": "acme/shop",
    "type": "project",
    "require": {
        "php": "^8.3",
        "laravel/framework": "^11.31",
        "spatie/laravel-permission": "^6.10",
        "guzzlehttp/guzzle": "^7.9"
    },
    "require-dev": {
        "phpunit/phpunit": "^11.4"
    },
    "autoload": {
        "psr-4": {
            "App\\": "app/"
        }
    },
    "autoload-dev": {
        "psr-4": {
            "Tests\\": "tests/"
        }
    }
}
`,
};

const EMPTY_DIRS = ['config', 'database', 'vendor'];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** History of the sample repository (newest first). */
const SAMPLE_COMMITS = [
  { hash: 'e5c1d20a9f6b4c3d2e1f0a9b8c7d6e5f4a3b2c1d', parents: ['c4d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1'], author: 'Lina Moreau', email: 'lina@example.com', date: '2026-10-12T16:20:00+02:00', subject: 'Add invoices endpoint', refs: 'HEAD -> main, origin/main', files: ['M app/Http/Controllers/UserController.php', 'A app/Services/InvoiceService.php', 'M routes/web.php'] },
  { hash: 'c4d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1', parents: ['a3b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0', 'b7a01f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a'], author: 'Omar Haddad', email: 'omar@example.com', date: '2026-10-10T11:05:00+02:00', subject: "Merge branch 'feature/composer'", refs: '', files: ['M composer.json'] },
  { hash: 'b7a01f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a', parents: ['9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e'], author: 'Omar Haddad', email: 'omar@example.com', date: '2026-10-09T18:40:00+02:00', subject: 'Add Composer setup', refs: 'feature/composer', files: ['A composer.json'] },
  { hash: 'a3b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0', parents: ['9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e'], author: 'Jane Cooper', email: 'jane@example.com', date: '2026-10-08T09:12:00+02:00', subject: 'Users controller and model', refs: '', files: ['A app/Http/Controllers/UserController.php', 'A app/Models/User.php'] },
  { hash: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e', parents: ['1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'], author: 'Jane Cooper', email: 'jane@example.com', date: '2026-10-07T15:30:00+02:00', subject: 'Laravel skeleton', refs: 'tag: v0.1', files: ['A app/Http/Controllers/Controller.php', 'A routes/web.php'] },
  { hash: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', parents: [], author: 'Jane Cooper', email: 'jane@example.com', date: '2026-10-07T14:00:00+02:00', subject: 'Initial commit', refs: '', files: ['A README.md'] },
];

/** The built-in "acme-shop" demo project. Nothing here touches the disk. */
export class SampleBackend implements Backend {
  readonly kind = 'sample' as const;
  readonly root = ROOT;
  readonly name = 'acme-shop';

  private files = new Map(Object.entries(FILES).map(([rel, src]) => [`${ROOT}/${rel}`, src]));
  private changes = new Map<string, 'M' | 'A' | 'U'>([
    [`${ROOT}/app/Http/Controllers/UserController.php`, 'M'],
    [`${ROOT}/app/Models/User.php`, 'M'],
    [`${ROOT}/tests/Feature/InvoiceTest.php`, 'A'],
    [`${ROOT}/routes/web.php`, 'M'],
    [`${ROOT}/README.md`, 'U'],
  ]);
  private pkgs: (Package & { latest: string })[] = [
    { name: 'laravel/framework', version: 'v11.31.0', latest: 'v11.34.2', kind: 'require' },
    { name: 'spatie/laravel-permission', version: '6.10.0', latest: '6.10.1', kind: 'require' },
    { name: 'guzzlehttp/guzzle', version: '7.9.2', latest: '7.9.2', kind: 'require' },
    { name: 'phpunit/phpunit', version: '11.4.3', latest: '11.4.3', kind: 'require-dev' },
  ];

  async listDir(path: string): Promise<Entry[]> {
    const known = path === ROOT || EMPTY_DIRS.some((d) => path === `${ROOT}/${d}`) || this.exists(path);
    if (!known) throw new Error(`${path} does not exist`);
    const prefix = path + '/';
    const seen = new Map<string, Entry>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const [first, ...rest] = file.slice(prefix.length).split('/');
      seen.set(first, { name: first, path: prefix + first, isDir: rest.length > 0 });
    }
    if (path === ROOT) {
      for (const d of EMPTY_DIRS) seen.set(d, { name: d, path: `${ROOT}/${d}`, isDir: true });
    }
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const first = d.slice(prefix.length).split('/')[0];
      if (!seen.has(first)) seen.set(first, { name: first, path: prefix + first, isDir: true });
    }
    return [...seen.values()].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  async listFiles() {
    return [...this.files.keys()];
  }

  async readFile(path: string) {
    const src = this.files.get(path);
    if (src === undefined) throw new Error(`File not found: ${path}`);
    return src;
  }

  async writeFile(path: string, content: string) {
    this.files.set(path, content);
    if (!this.changes.has(path)) this.changes.set(path, 'M');
  }

  private dirs = new Set<string>();

  async createFile(path: string, content: string) {
    if (this.files.has(path)) throw new Error(`${path.split('/').pop()} already exists`);
    this.files.set(path, content);
    this.changes.set(path, 'A');
  }

  /** Every stored path at or under `path` (a file, or a folder's files and empty folders). */
  private under(path: string) {
    const files = [...this.files.keys()].filter((f) => f === path || f.startsWith(path + '/'));
    const dirs = [...this.dirs].filter((d) => d === path || d.startsWith(path + '/'));
    return { files, dirs };
  }

  private exists(path: string) {
    const { files, dirs } = this.under(path);
    return files.length > 0 || dirs.length > 0;
  }

  async renamePath(from: string, to: string) {
    if (!this.exists(from)) throw new Error(`${from.split('/').pop()} no longer exists`);
    if (this.exists(to)) throw new Error(`${to.split('/').pop()} already exists`);
    if (to.startsWith(from + '/')) throw new Error("Can't move a folder into itself");
    const { files, dirs } = this.under(from);
    for (const f of files) {
      const text = this.files.get(f)!;
      this.files.delete(f);
      this.changes.delete(f);
      this.files.set(to + f.slice(from.length), text);
      this.changes.set(to + f.slice(from.length), 'A');
    }
    for (const d of dirs) {
      this.dirs.delete(d);
      this.dirs.add(to + d.slice(from.length));
    }
  }

  async copyPath(from: string, to: string) {
    if (this.exists(to)) throw new Error(`${to.split('/').pop()} already exists`);
    if (to.startsWith(from + '/')) throw new Error("Can't copy a folder into itself");
    const { files, dirs } = this.under(from);
    for (const f of files) {
      this.files.set(to + f.slice(from.length), this.files.get(f)!);
      this.changes.set(to + f.slice(from.length), 'A');
    }
    for (const d of dirs) this.dirs.add(to + d.slice(from.length));
  }

  async deletePaths(paths: string[]) {
    for (const p of paths) {
      const { files, dirs } = this.under(p);
      files.forEach((f) => {
        this.files.delete(f);
        this.changes.delete(f);
      });
      dirs.forEach((d) => this.dirs.delete(d));
    }
  }

  async createDir(path: string) {
    const exists = this.dirs.has(path) || [...this.files.keys()].some((f) => f.startsWith(path + '/'));
    if (exists) throw new Error(`${path.split('/').pop()} already exists`);
    this.dirs.add(path);
  }

  async gitInfo(): Promise<GitInfo> {
    return { branch: 'main', changes: [...this.changes].map(([path, status]) => ({ path, status })) };
  }

  private lastMessage = 'Add Composer setup';

  async lastCommitMessage() {
    return this.lastMessage;
  }

  /** A small made-up repository, so the Git tool window, diff and annotations can be tried. */
  async git(argv: string[]): Promise<RunResult> {
    const args = [...argv];
    while (args[0] === '-c') args.splice(0, 2);
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
    const [cmd] = args;
    const us = '\x1f';
    if (cmd === 'log' && args.some((a) => a.startsWith('--format=%B'))) return ok(SAMPLE_COMMITS.find((c) => c.hash.startsWith(args[args.length - 1]))?.subject ?? this.lastMessage);
    if (cmd === 'log') {
      if (args.includes('--not') || args.some((a) => a.includes('..HEAD'))) return ok('');
      return ok(SAMPLE_COMMITS.map((c) => [c.hash, c.hash.slice(0, 7), c.parents.join(' '), c.author, c.email, c.date, c.subject, c.refs].join(us) + '\x1e').join('\n'));
    }
    if (cmd === 'diff-tree') {
      const c = SAMPLE_COMMITS.find((x) => x.hash.startsWith(args[args.length - 1]));
      return ok((c?.files ?? []).map((f) => `${f[0]}\t${f.slice(2)}`).join('\n'));
    }
    if (cmd === 'show') {
      const [rev, rel] = args[1].split(':');
      const text = this.files.get(`${ROOT}/${rel}`);
      if (text === undefined) return { code: 128, stdout: '', stderr: `fatal: path '${rel}' does not exist in '${rev}'` };
      // HEAD and parents (`abc^`) show the older version, so diffs have something to show.
      return ok(rev === 'HEAD' || rev.endsWith('^') ? this.headVersion(`${ROOT}/${rel}`, text) ?? '' : text);
    }
    if (cmd === 'for-each-ref') {
      return ok(
        [
          ['refs/heads/main', 'e5c1d20', 'origin/main', '', '*'],
          ['refs/heads/feature/composer', 'b7a01f3', '', '', ''],
          ['refs/remotes/origin/main', 'e5c1d20', '', '', ''],
        ]
          .map((r) => r.join(us))
          .join('\n'),
      );
    }
    if (cmd === 'branch' && args[1] === '--show-current') return ok('main\n');
    if (cmd === 'rev-parse') return ok('origin/main\n');
    if (cmd === 'remote') return ok('origin\n');
    if (cmd === 'stash' && args[1] === 'list') return ok('');
    if (cmd === 'rebase') return ok('Successfully rebased and updated refs/heads/main.');
    if (cmd === 'status' && args.some((a) => a.startsWith('--ignored'))) return ok(['!! vendor/', '!! .env', '!! storage/logs/'].join('\n'));
    if (cmd === 'blame') {
      const text = this.files.get(`${ROOT}/${args[args.length - 1]}`) ?? '';
      const out: string[] = [];
      text.split('\n').forEach((line, i) => {
        const c = SAMPLE_COMMITS[i % 3 === 0 ? 0 : i % 3 === 1 ? 3 : 5];
        out.push(`${c.hash} ${i + 1} ${i + 1} 1`, `author ${c.author}`, `author-mail <${c.email}>`, `author-time ${Math.floor(Date.parse(c.date) / 1000)}`, `summary ${c.subject}`, `\t${line}`);
      });
      return ok(out.join('\n'));
    }
    return { code: 1, stdout: '', stderr: 'This is the sample project: Git commands that change the repository do not run here. Open a project folder to use Git.' };
  }

  /** What a changed sample file looked like in HEAD: a few lines differ, so change markers show. */
  private headVersion(path: string, text: string): string | null {
    const status = this.changes.get(path);
    if (status === 'A') return null;
    if (status !== 'M') return text;
    const lines = text.split('\n');
    const at = Math.floor(lines.length * 0.6);
    lines.splice(at, 2);
    const mod = Math.floor(lines.length * 0.3);
    lines[mod] = lines[mod] + ' // before';
    lines.splice(Math.floor(lines.length * 0.15), 0, '    // removed in the working copy');
    return lines.join('\n');
  }

  async gitCommit(paths: string[], message: string, push: boolean, options: { amend?: boolean; fixup?: string } = {}) {
    await delay(300);
    paths.forEach((p) => this.changes.delete(p));
    const subject = options.fixup ? `fixup! ${SAMPLE_COMMITS.find((c) => c.hash.startsWith(options.fixup!))?.subject ?? options.fixup}` : message;
    this.lastMessage = subject;
    const n = paths.length;
    return `[main 4f2c9a1] ${subject} (${options.amend ? 'amended, ' : ''}${n} ${n === 1 ? 'file' : 'files'} changed${push ? ', pushed to origin' : ''})`;
  }

  async packages(): Promise<Package[]> {
    return this.pkgs.map(({ name, version, kind }) => ({ name, version, kind }));
  }

  async checkOutdated() {
    await delay(400);
    const out: Record<string, string> = {};
    for (const p of this.pkgs) if (p.version !== p.latest) out[p.name] = p.latest;
    return out;
  }

  async updatePackage(name: string | null) {
    await delay(500);
    this.pkgs = this.pkgs.map((p) => (name === null || p.name === name ? { ...p, version: p.latest } : p));
  }

  /** Very small stand-in for `php -l`: flags a line that ends in a dangling `->`. */
  async lint(path: string, content: string): Promise<Problem[]> {
    if (!path.endsWith('.php')) return [];
    const problems: Problem[] = [];
    content.split('\n').forEach((line, i) => {
      if (/->\s*$/.test(line)) {
        problems.push({ path, line: i + 1, message: 'syntax error, unexpected end of expression, expecting identifier', severity: 'error' });
      }
    });
    return problems;
  }

  async runTests(): Promise<TestResult> {
    await delay(700);
    const tests = [
      { name: 'it creates an invoice including tax', ms: '38 ms', ok: true },
      { name: 'it rejects an amount below 1', ms: '12 ms', ok: true },
      { name: 'it requires authentication', ms: '9 ms', ok: true },
      { name: 'it returns 201 with the invoice', ms: '21 ms', ok: true },
      { name: 'it runs inside a database transaction', ms: '17 ms', ok: true },
    ];
    return { ok: true, summary: 'OK (5 tests, 9 assertions)', output: '', tests };
  }

  async shell(line: string): Promise<RunResult> {
    await delay(150);
    if (/route:list/.test(line)) {
      return {
        code: 0,
        stderr: '',
        stdout: [
          '  GET|HEAD   / ...................... Closure',
          '  GET|HEAD   users/{user} ........... UserController@show',
          '  POST       users/{user}/invoice ... UserController@invoice',
        ].join('\n'),
      };
    }
    return { code: 1, stdout: '', stderr: 'This is the sample project, so commands do not run. Open a real folder to use the terminal.' };
  }

  async phpVersion() {
    return '8.3 (sample)';
  }
}

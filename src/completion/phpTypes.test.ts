// Type inference for completion after `->` / `::`, against a small fake index: a Laravel-like
// model, repository and query builder.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../php', () => ({ structureOf: () => [] }));
vi.mock('../symbols', () => {
  type M = { kind: 'method' | 'property' | 'const'; name: string; detail: string; visibility: 'public' | 'protected' | 'private'; isStatic: boolean; line: number; ty?: string | null; elem?: string | null };
  const m = (kind: M['kind'], name: string, ty: string | null, extra: Partial<M> = {}): M => ({ kind, name, detail: '', visibility: 'public', isStatic: false, line: 1, ty, ...extra });
  const classes: Record<string, { name: string; extends?: string; mixins?: string[]; members: M[] }> = {
    'App\\Http\\Controllers\\UserController': { name: 'UserController', members: [m('property', 'repo', 'App\\Repositories\\UserRepository', { visibility: 'private' })] },
    'App\\Repositories\\UserRepository': { name: 'UserRepository', members: [m('method', 'find', 'App\\Models\\User'), m('method', 'all', null, { elem: 'App\\Models\\User' })] },
    'App\\Models\\User': {
      name: 'User',
      extends: 'Illuminate\\Database\\Eloquent\\Model',
      members: [m('property', 'team', 'App\\Models\\Team'), m('method', 'rename', 'static'), m('property', 'posts', 'Illuminate\\Support\\Collection', { elem: 'App\\Models\\Post' }), m('method', 'active', 'Illuminate\\Database\\Eloquent\\Builder', { isStatic: true })],
    },
    'Illuminate\\Database\\Eloquent\\Model': { name: 'Model', mixins: ['Illuminate\\Database\\Eloquent\\Builder'], members: [] },
    'Illuminate\\Database\\Eloquent\\Builder': { name: 'Builder', members: [m('method', 'where', 'static'), m('method', 'first', 'App\\Models\\User')] },
    'Illuminate\\Auth\\AuthManager': { name: 'AuthManager', members: [m('method', 'user', 'App\\Models\\User')] },
    'App\\Models\\Team': { name: 'Team', members: [] },
    'App\\Models\\Post': { name: 'Post', members: [] },
    'Illuminate\\Http\\Request': { name: 'Request', members: [] },
    RuntimeException: { name: 'RuntimeException', members: [] },
  };
  function resolveName(name: string, src: string): string {
    if (name.startsWith('\\')) return name.slice(1);
    const [first, ...rest] = name.split('\\');
    const use = src.match(new RegExp(String.raw`^use\s+([\w\\]*\\${first})\s*;`, 'm'));
    if (use) return [use[1], ...rest].join('\\');
    const ns = src.match(/^namespace\s+([\w\\]+)\s*;/m)?.[1];
    return ns ? `${ns}\\${name}` : name;
  }
  const symbols = {
    async classInfo(fqn: string) {
      const c = classes[fqn];
      if (!c) return null;
      // Own members, then parents and mixins (like the Rust index_class).
      const all: M[] = [];
      const queue = [fqn];
      const seen = new Set<string>();
      while (queue.length) {
        const k = queue.shift()!;
        if (seen.has(k) || !classes[k]) continue;
        seen.add(k);
        all.push(...classes[k].members);
        if (classes[k].extends) queue.push(classes[k].extends!);
        queue.push(...(classes[k].mixins ?? []));
      }
      return { name: c.name, fqn, kind: 'class', line: 1, path: '', extends: c.extends, members: c.members, allMembers: all };
    },
    async functionInfo(name: string) {
      return name === 'auth' ? { name: 'auth', fqn: 'auth', params: '', detail: '', ty: 'Illuminate\\Auth\\AuthManager' } : null;
    },
  };
  return { resolveName, symbols };
});

const { chainType, parseChain, writtenType } = await import('./phpTypes');

/** The class before the cursor marker `|` (which follows `->` or `::`). */
async function typeAt(src: string): Promise<string | null> {
  const offset = src.indexOf('|');
  const code = src.slice(0, offset) + src.slice(offset + 1);
  const before = code.slice(0, offset);
  const m = before.match(/(\??->|::)\s*(\w*)$/)!;
  const chain = parseChain(before.slice(0, before.length - m[0].length), m[1] === '::' ? '::' : '->');
  if (!chain) return null;
  return (await chainType(chain, code, offset)).cls;
}

const HEAD = `<?php
namespace App\\Http\\Controllers;

use App\\Models\\User;
use App\\Repositories\\UserRepository;
use Illuminate\\Http\\Request;
`;

describe('parseChain', () => {
  it('reads property and method steps', () => {
    expect(parseChain('$this->repo->find($id, [1, 2])')).toEqual({
      base: { kind: 'var', name: '$this' },
      steps: [
        { op: '->', name: 'repo', call: false },
        { op: '->', name: 'find', call: true },
      ],
    });
  });
  it('skips strings with parentheses inside', () => {
    expect(parseChain("User::where('a', ')')->first()")).toEqual({
      base: { kind: 'class', name: 'User' },
      steps: [
        { op: '::', name: 'where', call: true },
        { op: '->', name: 'first', call: true },
      ],
    });
  });
  it('handles new in parentheses, functions and multi-line chains', () => {
    expect(parseChain('return (new User())')).toEqual({ base: { kind: 'new', name: 'User' }, steps: [] });
    expect(parseChain('auth()->user()')).toEqual({ base: { kind: 'func', name: 'auth' }, steps: [{ op: '->', name: 'user', call: true }] });
    expect(parseChain('$q = $this->repo\n      ->query()\n      ')).toEqual({
      base: { kind: 'var', name: '$this' },
      steps: [
        { op: '->', name: 'repo', call: false },
        { op: '->', name: 'query', call: true },
      ],
    });
  });
  it('gives up on dynamic member names', () => {
    expect(parseChain('$a->$b')).toBeNull();
  });
});

describe('writtenType', () => {
  it('resolves nullable, unions, arrays and generics', () => {
    expect(writtenType('?User', HEAD)).toEqual({ cls: 'App\\Models\\User' });
    expect(writtenType('User|null', HEAD)).toEqual({ cls: 'App\\Models\\User' });
    expect(writtenType('User[]', HEAD)).toEqual({ cls: null, elem: 'App\\Models\\User' });
    expect(writtenType('\\Illuminate\\Support\\Collection<int, User>', HEAD)).toEqual({ cls: 'Illuminate\\Support\\Collection', elem: 'App\\Models\\User' });
    expect(writtenType('list<User>', HEAD)).toEqual({ cls: null, elem: 'App\\Models\\User' });
    expect(writtenType('int', HEAD)).toEqual({ cls: null });
  });
});

describe('chainType', () => {
  const controller = `${HEAD}
class UserController extends Controller
{
    public function __construct(private UserRepository $repo) {}

    public function show(Request $request, int $id)
    {
`;
  const cases: [string, string, string | null][] = [
    ['$this is the class', '$this->|', 'App\\Http\\Controllers\\UserController'],
    ['promoted property', '$this->repo->|', 'App\\Repositories\\UserRepository'],
    ['parameter type', '$request->|', 'Illuminate\\Http\\Request'],
    ['method return through a property', '$this->repo->find($id)->|', 'App\\Models\\User'],
    ['relation property on the result', '$this->repo->find($id)->team->|', 'App\\Models\\Team'],
    ['static return keeps the receiver', "$this->repo->find($id)->rename('x')->|", 'App\\Models\\User'],
    ['variable from a chain', '$user = $this->repo->find($id);\n        $user->|', 'App\\Models\\User'],
    ['closest assignment wins', '$x = new Request();\n        $x = $this->repo->find($id);\n        $x->|', 'App\\Models\\User'],
    ['@var', '/** @var User $u */\n        $u = $something;\n        $u->|', 'App\\Models\\User'],
    ['foreach over a collection', 'foreach ($this->repo->find($id)->posts as $post) {\n            $post->|', 'App\\Models\\Post'],
    ['foreach over a typed array', 'foreach ($this->repo->all() as $i => $u) {\n            $u->|', 'App\\Models\\User'],
    ['static call with a mixin', 'User::active()->first()->|', 'App\\Models\\User'],
    ['mixin method from the model', "User::where('a', 1)->first()->|", 'App\\Models\\User'],
    ['function return type', 'auth()->user()->|', 'App\\Models\\User'],
    ['new in parentheses', '(new User())->|', 'App\\Models\\User'],
    ['catch', 'try {} catch (\\RuntimeException $e) {\n            $e->|', 'RuntimeException'],
    ['unknown variable', '$nothing->|', null],
    ['static:: inside the class', 'static::|', 'App\\Http\\Controllers\\UserController'],
  ];
  it.each(cases)('%s', async (_name, code, want) => {
    expect(await typeAt(`${controller}        ${code}`)).toBe(want);
  });
});

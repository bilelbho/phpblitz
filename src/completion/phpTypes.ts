// What class a PHP expression is, for completion after `->` and `::` without a language server:
// `$this->repo->find($id)->team->`, `User::where(...)->first()->`, `auth()->user()->`,
// `foreach ($user->posts as $post) { $post->`.
//
// The chain before the cursor is read backwards into a base (a variable, a class, `new X`, a
// function call) and the member accesses after it; each step is looked up in the project index,
// which records the class each method returns and each property holds (docblocks included).

import { resolveName, symbols, type IndexClass, type IndexMember } from '../symbols';
import { structureOf } from '../php';

/** A class, fully qualified when known; `elem`: for collections, the class of their elements. */
export interface PhpType {
  cls: string | null;
  elem?: string | null;
}

export type Base =
  | { kind: 'var'; name: string }
  | { kind: 'class'; name: string }
  | { kind: 'new'; name: string }
  | { kind: 'func'; name: string };

export interface Step {
  /** `->` (or `?->`) or `::`. */
  op: '->' | '::';
  name: string;
  call: boolean;
}

export interface Chain {
  base: Base;
  steps: Step[];
}

const IDENT = /[A-Za-z_\x80-￿][\w\x80-￿]*$/;
/** Words that can stand before `(` without being a function call: `return (new X())->`. */
const KEYWORDS = /(?:^|[^\w$\\])(?:return|echo|print|yield|throw|clone|if|elseif|while|for|foreach|switch|match|and|or|xor|case|else|do|fn|use|in)$/i;

/** Index of the `(` matching the `)` at `close`, skipping strings; -1 if unbalanced. */
function openParen(text: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = text[i];
    if (c === "'" || c === '"') {
      // Back to the opening quote (escaped quotes kept inside).
      let j = i - 1;
      while (j >= 0 && !(text[j] === c && text[j - 1] !== '\\')) j--;
      i = j;
      continue;
    }
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The member chain ending at the end of `text` (the code before the cursor, without the final
 * `->` / `::` and the name being typed): `$this->repo->find($id)` → base `$this`, steps repo, find().
 */
export function parseChain(text: string, trailingOp: '->' | '::' | null = null): Chain | null {
  const steps: Step[] = [];
  let end = text.length;
  for (let guard = 0; guard < 32; guard++) {
    let s = text.slice(0, end).replace(/\s+$/, '');
    end = s.length;
    let call = false;
    if (s.endsWith(')')) {
      const open = openParen(s, s.length - 1);
      if (open < 0) return null;
      call = true;
      s = s.slice(0, open).replace(/\s+$/, '');
      // `(new Foo(...))`: the expression in parentheses.
      if ((!IDENT.test(s) && !/[$]\w*$/.test(s)) || KEYWORDS.test(s)) {
        const inner = text.slice(open + 1, end - 1).trim();
        const created = inner.match(/^new\s+(\\?[A-Za-z_][\w\\]*)/);
        if (created && (!s || /[^\w$\\]$/.test(s) || KEYWORDS.test(s))) return { base: { kind: 'new', name: created[1] }, steps: steps.reverse() };
        return null;
      }
    }
    const variable = s.match(/\$([A-Za-z_]\w*)$/);
    const ident = s.match(/\\?[A-Za-z_][\w\\]*$/);
    const word = variable ? `$${variable[1]}` : ident?.[0];
    if (!word) return null;
    const before = s.slice(0, s.length - word.length);
    const op = before.match(/(\?->|->|::)\s*$/);
    if (op) {
      if (variable && op[1] !== '::') return null; // `$a->$b`: dynamic
      steps.push({ op: op[1] === '::' ? '::' : '->', name: word.replace(/^\$/, ''), call });
      end = before.length - op[0].length;
      continue;
    }
    // The base of the chain.
    steps.reverse();
    if (variable) return call ? null : { base: { kind: 'var', name: word }, steps };
    if (call) {
      if (/\bnew\s*$/.test(before)) return { base: { kind: 'new', name: word }, steps };
      return { base: { kind: 'func', name: word }, steps };
    }
    // A bare class name: only as the start of `Class::member`.
    return (steps[0]?.op ?? trailingOp) === '::' ? { base: { kind: 'class', name: word }, steps } : null;
  }
  return null;
}

/** A type as written (`?User`, `User|null`, `\App\User[]`, `Collection<int, Post>`) → class and elements. */
export function writtenType(text: string, src: string): PhpType {
  const t = text.trim().replace(/^\?/, '');
  if (!t) return { cls: null };
  const generic = t.match(/^(\\?[\w\\]+)\s*<(.+)>$/);
  if (generic) {
    const args = generic[2].split(',');
    const last = writtenType(args[args.length - 1], src).cls;
    const outer = /^(array|list|iterable|non-empty-array|non-empty-list)$/i.test(generic[1]) ? null : resolveName(generic[1], src);
    return { cls: outer, elem: last };
  }
  const parts = t.split('|').map((p) => p.trim()).filter((p) => p && !/^(null|false|true|void|mixed)$/i.test(p));
  for (const p of parts) {
    if (p.endsWith('[]')) return { cls: null, elem: classOf(p.slice(0, -2), src) };
  }
  for (const p of parts) {
    const c = classOf(p, src);
    if (c) return { cls: c };
  }
  return { cls: null };
}

const SCALARS = /^(int|float|string|bool|array|object|callable|iterable|self|static|parent|resource|never|integer|double|boolean|class-string|positive-int|non-empty-string|list|scalar|numeric)$/i;

function classOf(name: string, src: string): string | null {
  const n = name.trim();
  if (!n || SCALARS.test(n) || !/^\\?[A-Za-z_][\w\\]*$/.test(n)) return null;
  return resolveName(n, src);
}

/** The class declared around `offset` in `src` (fully qualified). */
function currentClass(src: string, offset: number): string | null {
  const before = src.slice(0, offset);
  const m = [...before.matchAll(/\b(?:class|trait|enum|interface)\s+([A-Za-z_]\w*)/g)].pop() ?? null;
  const name = m?.[1] ?? structureOf(src).find((s) => s.depth === 0 && s.kind !== 'function')?.name;
  return name ? resolveName(name, src) : null;
}

const escape = (s: string) => s.replace(/[$\\^.*+?()[\]{}|]/g, '\\$&');

/**
 * The type of `$name` at `offset`: the closest assignment, `foreach`, `catch` or `@var` before it,
 * else its parameter type (`Type $name` in the signature, or `@param Type $name`).
 */
export async function variableType(src: string, offset: number, name: string, depth = 0): Promise<PhpType> {
  if (name === '$this') return { cls: currentClass(src, offset) };
  const before = src.slice(0, offset);
  const v = escape(name);
  type Candidate = { at: number; resolve: () => Promise<PhpType> };
  const found: Candidate[] = [];
  const each = (re: RegExp, resolve: (m: RegExpMatchArray) => Promise<PhpType>) => {
    for (const m of before.matchAll(re)) found.push({ at: m.index ?? 0, resolve: () => resolve(m) });
  };
  // /** @var User $user */ and /** @var User */ just before `$user = …`.
  each(new RegExp(String.raw`@var\s+([^\s*]+)\s+${v}\b`, 'g'), async (m) => writtenType(m[1], src));
  each(new RegExp(String.raw`@var\s+([^\s*$]+)\s*\*/\s*${v}\s*=`, 'g'), async (m) => writtenType(m[1], src));
  // $user = new User(…)
  each(new RegExp(String.raw`${v}\s*=\s*new\s+(\\?[A-Za-z_][\w\\]*)`, 'g'), async (m) => ({ cls: resolveName(m[1], src) }));
  // $user = <chain>;
  each(new RegExp(String.raw`${v}\s*=\s*(?!new\b)([^;=]+?)\s*;`, 'g'), async (m) => {
    if (depth > 2) return { cls: null };
    const chain = parseChain(m[1]);
    return chain ? chainType(chain, src, (m.index ?? 0) + 1, depth + 1) : { cls: null };
  });
  // foreach ($users as $user) / foreach ($users as $id => $user)
  each(new RegExp(String.raw`foreach\s*\(\s*(.+?)\s+as\s+(?:\$\w+\s*=>\s*)?&?${v}\s*\)`, 'g'), async (m) => {
    if (depth > 2) return { cls: null };
    const chain = parseChain(m[1]);
    if (!chain) return { cls: null };
    const t = await chainType(chain, src, m.index ?? 0, depth + 1);
    return { cls: t.elem ?? null };
  });
  // catch (NotFoundException $e)
  each(new RegExp(String.raw`catch\s*\(\s*([\\\w|\s]+?)\s+${v}\s*\)`, 'g'), async (m) => writtenType(m[1], src));
  if (found.length) {
    found.sort((a, b) => b.at - a.at);
    for (const c of found) {
      const t = await c.resolve();
      if (t.cls || t.elem) return t;
    }
  }
  // Parameters: `Type $name` in the closest signature, then `@param Type $name`.
  const params = [...before.matchAll(new RegExp(String.raw`[(,]\s*(?:(?:public|protected|private|readonly)\s+)*([?\\\w|]+)\s+&?(?:\.\.\.)?${v}\b`, 'g'))].pop();
  if (params) {
    const t = writtenType(params[1], src);
    if (t.cls) return t;
  }
  const doc = [...before.matchAll(new RegExp(String.raw`@param\s+([^\s*]+)\s+${v}\b`, 'g'))].pop();
  return doc ? writtenType(doc[1], src) : { cls: null };
}

/** The member `name` of a class (methods for calls, properties otherwise), inherited ones included. */
function memberOf(info: IndexClass, step: Step): IndexMember | undefined {
  const lower = step.name.toLowerCase();
  const wanted = step.call ? 'method' : step.op === '::' ? null : 'property';
  return info.allMembers.find((m) => (wanted ? m.kind === wanted : m.kind !== 'method') && (m.kind === 'method' ? m.name.toLowerCase() === lower : m.name === step.name));
}

/** The type a member gives: its recorded class (or the receiver for `static`), else its written type. */
function memberType(member: IndexMember, receiver: string): PhpType {
  if (member.ty === 'static') return { cls: receiver };
  if (member.ty || member.elem) return { cls: member.ty ?? null, elem: member.elem ?? null };
  // The browser index (sample project) records written types only.
  const written = member.detail.replace(/^\?/, '').split('|')[0];
  if (/^(static|self|\$this)$/.test(written)) return { cls: receiver };
  if (written.endsWith('[]')) return { cls: null, elem: written.slice(0, -2) };
  return SCALARS.test(written) || !written ? { cls: null } : { cls: written };
}

/** The type of a whole chain: its base, then each member access in turn. */
export async function chainType(chain: Chain, src: string, offset: number, depth = 0): Promise<PhpType> {
  let type: PhpType = { cls: null };
  const { base } = chain;
  if (base.kind === 'var') type = await variableType(src, offset, base.name, depth);
  else if (base.kind === 'new') type = { cls: resolveName(base.name, src) };
  else if (base.kind === 'class') {
    const lower = base.name.toLowerCase();
    if (lower === 'self' || lower === 'static') type = { cls: currentClass(src, offset) };
    else if (lower === 'parent') {
      const own = currentClass(src, offset);
      const info = own ? await symbols.classInfo(own) : null;
      type = { cls: info?.extends ?? null };
    } else type = { cls: resolveName(base.name, src) };
  } else {
    const fn = await symbols.functionInfo(base.name, src);
    type = { cls: fn?.ty ?? null, elem: fn?.elem ?? null };
  }
  for (const step of chain.steps) {
    if (!type.cls) return { cls: null };
    const info = await symbols.classInfo(type.cls);
    const member = info && memberOf(info, step);
    if (!member) return { cls: null };
    type = memberType(member, info!.fqn || type.cls);
  }
  return type;
}

/** The class before `->` / `::` at the end of `text` (the line or code up to the operator). */
export async function receiverType(textBeforeOperator: string, src: string, offset: number): Promise<string | null> {
  const chain = parseChain(textBeforeOperator);
  if (!chain) return null;
  return (await chainType(chain, src, offset)).cls;
}

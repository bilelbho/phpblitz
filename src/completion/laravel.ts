// Laravel completion inside strings: route names in route('…'), config keys in config('…'), views
// in view('…') and Blade's @include / @extends, .env keys in env('…'), and translation keys in
// __('…') / trans('…') / @lang. Read from the project's files (routes/, config/, resources/views,
// .env, lang/), parsed once and again only when a file changes.

import * as monaco from 'monaco-editor';

/** The open project, as the workspace gives it (see setLaravelProject). */
interface Project {
  root: string;
  files: string[];
  read: (path: string) => Promise<string>;
}

let project: Project | null = null;
const cache = new Map<string, Promise<unknown>>();

export function setLaravelProject(next: Project | null) {
  if (next?.root !== project?.root) cache.clear();
  project = next;
}

/** Files changed on disk or saved: their parsed data is read again next time. */
export function invalidateLaravelFiles(paths: string[]) {
  for (const p of paths) cache.delete(p);
  // The file list changed too (a view or config file added or removed).
  cache.delete('list');
}

function cached<T>(path: string, parse: (text: string) => T): Promise<T> {
  let hit = cache.get(path) as Promise<T> | undefined;
  if (!hit) {
    hit = (project ? project.read(path) : Promise.resolve('')).then(parse, () => parse(''));
    cache.set(path, hit);
  }
  return hit;
}

// ── Parsers (pure, tested on their own) ────────────────────────────────────

type Token = { t: 'str'; v: string; at: number } | { t: 'sym'; v: string; at: number } | { t: 'word'; v: string; at: number };

/** PHP code as strings, words and punctuation (comments dropped). */
function tokens(src: string): Token[] {
  const out: Token[] = [];
  const re = /\/\/[^\n]*|#(?!\[)[^\n]*|\/\*[\s\S]*?\*\/|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(=>|->|::|[[\](){};,=])|([A-Za-z_\\][\w\\]*)/g;
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    if (m[1] !== undefined) out.push({ t: 'str', v: m[1].replace(/\\(['\\])/g, '$1'), at });
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2], at });
    else if (m[3]) out.push({ t: 'sym', v: m[3], at });
    else if (m[4]) out.push({ t: 'word', v: m[4], at });
  }
  return out;
}

export interface Key {
  key: string;
  /** The value as written (scalars), or "[…]" for nested arrays. */
  preview: string;
}

/** The keys of a PHP file returning an array (config/*.php, lang/xx/*.php), in dot notation. */
export function arrayKeys(src: string, prefix = ''): Key[] {
  const start = src.search(/\breturn\s*\[/);
  if (start < 0) return [];
  const body = src.slice(start);
  const toks = tokens(body);
  const out: Key[] = [];
  const path: (string | null)[] = [];
  let depth = 0;
  let parens = 0;
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    if (k.t === 'sym' && k.v === '(') parens++;
    else if (k.t === 'sym' && k.v === ')') parens--;
    if (parens > 0) continue;
    if (k.t === 'sym' && k.v === '[') {
      depth++;
      if (path.length < depth) path.push(null);
    } else if (k.t === 'sym' && k.v === ']') {
      depth--;
      path.length = Math.max(0, depth);
      if (depth === 0) break;
    } else if (k.t === 'str' && toks[i + 1]?.t === 'sym' && toks[i + 1].v === '=>' && depth > 0) {
      const keyPath = [...path.slice(0, depth - 1).filter((p): p is string => !!p), k.v];
      const valueAt = toks[i + 2];
      const nested = valueAt?.t === 'sym' && valueAt.v === '[';
      let preview = '[…]';
      if (!nested && valueAt) {
        // The value's text up to the next `,` or `]` at this level.
        let end = body.length;
        let p = 0;
        for (let j = i + 2; j < toks.length; j++) {
          const t = toks[j];
          if (t.t === 'sym' && (t.v === '(' || t.v === '[')) p++;
          else if (t.t === 'sym' && (t.v === ')' || t.v === ']')) {
            if (p === 0) {
              end = t.at;
              break;
            }
            p--;
          } else if (t.t === 'sym' && t.v === ',' && p === 0) {
            end = t.at;
            break;
          }
        }
        preview = body.slice(valueAt.at, end).replace(/\s+/g, ' ').trim();
        if (preview.length > 60) preview = `${preview.slice(0, 57)}…`;
      }
      out.push({ key: prefix + keyPath.join('.'), preview });
      if (nested) path[depth - 1] = k.v;
    }
  }
  return out;
}

export interface RouteName {
  name: string;
  /** "GET /users/{user}", when the route's method and URI are in the same statement. */
  detail: string;
}

const RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];

/**
 * Route names in a routes file: `->name('…')`, prefixes from `Route::name('admin.')->group(…)` and
 * `Route::group(['as' => 'admin.'], …)`, and the names `Route::resource` / `apiResource` create.
 */
export function routeNames(src: string): RouteName[] {
  const toks = tokens(src);
  const out: RouteName[] = [];
  const prefixes: { prefix: string; depth: number }[] = [];
  let depth = 0;
  // The current statement: names and prefixes it declares, its verb and URI.
  let stmt: { names: string[]; verb?: string; uri?: string; groupPrefix: string | null; resource?: { name: string; api: boolean; only?: string[]; except?: string[] } } = { names: [], groupPrefix: null };
  let pending: string | null = null;
  const current = () => prefixes.map((p) => p.prefix).join('');
  const flush = () => {
    const base = current();
    if (stmt.groupPrefix === null) {
      for (const n of stmt.names) out.push({ name: base + n, detail: stmt.verb && stmt.uri !== undefined ? `${stmt.verb} /${stmt.uri.replace(/^\//, '')}` : '' });
    }
    if (stmt.resource) {
      const { name, api, only, except } = stmt.resource;
      for (const a of RESOURCE_ACTIONS) {
        if (api && (a === 'create' || a === 'edit')) continue;
        if (only && !only.includes(a)) continue;
        if (except?.includes(a)) continue;
        out.push({ name: `${base}${name}.${a}`, detail: `${api ? 'apiResource' : 'resource'} ${name}` });
      }
    }
    stmt = { names: [], groupPrefix: null };
  };
  const listAfter = (i: number): string[] => {
    const vals: string[] = [];
    for (let j = i; j < toks.length && !(toks[j].t === 'sym' && toks[j].v === ')'); j++) if (toks[j].t === 'str') vals.push(toks[j].v);
    return vals;
  };
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    const next = toks[i + 1];
    const arg = toks[i + 2];
    if (k.t === 'sym' && k.v === '{') {
      depth++;
      if (pending !== null) {
        prefixes.push({ prefix: pending, depth });
        pending = null;
      }
      stmt = { names: [], groupPrefix: null };
    } else if (k.t === 'sym' && k.v === '}') {
      if (prefixes.length && prefixes[prefixes.length - 1].depth === depth) prefixes.pop();
      depth--;
      stmt = { names: [], groupPrefix: null };
    } else if (k.t === 'sym' && k.v === ';') {
      flush();
    } else if (k.t === 'word' && next?.t === 'sym' && next.v === '(') {
      const word = k.v.toLowerCase();
      if (word === 'name' && arg?.t === 'str') stmt.names.push(arg.v);
      else if (/^(get|post|put|patch|delete|options|any)$/.test(word) && arg?.t === 'str' && !stmt.verb) {
        stmt.verb = word.toUpperCase();
        stmt.uri = arg.v;
      } else if ((word === 'resource' || word === 'apiresource') && arg?.t === 'str') stmt.resource = { name: arg.v, api: word === 'apiresource' };
      else if (word === 'only' && stmt.resource) stmt.resource.only = listAfter(i + 2);
      else if (word === 'except' && stmt.resource) stmt.resource.except = listAfter(i + 2);
      else if (word === 'group') {
        // `->name('admin.')->group(` / `Route::group(['as' => 'admin.'], function () {`.
        let prefix = stmt.names.pop() ?? '';
        for (let j = i + 2; j < toks.length && !(toks[j].t === 'word' && /^(function|fn)$/.test(toks[j].v)); j++) {
          if (toks[j].t === 'str' && toks[j].v === 'as' && toks[j + 1]?.v === '=>' && toks[j + 2]?.t === 'str') prefix += toks[j + 2].v;
        }
        stmt.groupPrefix = prefix;
        pending = prefix;
      }
    }
  }
  return out;
}

/** KEY=value lines of a .env file. */
export function envKeys(src: string): Key[] {
  const out: Key[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (m) out.push({ key: m[1], preview: m[2].trim() });
  }
  return out;
}

/** `resources/views/users/show.blade.php` → `users.show`. */
export function viewName(path: string, root: string): string | null {
  const m = path.match(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/resources/views/(.+?)(\\.blade)?\\.php$`));
  return m ? m[1].replace(/\//g, '.') : null;
}

// ── What the cursor is in ──────────────────────────────────────────────────

export type StringContext = 'route' | 'config' | 'view' | 'env' | 'trans';

/** Which helper's string the cursor is in, from the line up to it; with the text typed so far. */
export function stringContext(before: string): { kind: StringContext; typed: string } | null {
  const tests: [StringContext, RegExp][] = [
    ['route', /(?:\b(?:route|to_route|signedRoute|temporarySignedRoute|routeIs|redirectToRoute)|->route|Route::has|URL::route|Redirect::route)\(\s*['"]([^'"]*)$/],
    ['config', /(?:\bconfig|Config::(?:get|set|has|string|integer|boolean|array))\(\s*['"]([^'"]*)$/],
    ['view', /(?:\bview|View::(?:make|exists|first)|->view|@(?:include|includeIf|includeWhen|includeUnless|includeFirst|extends|each|component|livewire))\(\s*(?:[^'"(),]+,\s*)?['"]([^'"]*)$/],
    ['env', /\benv\(\s*['"]([^'"]*)$/],
    ['trans', /(?:\b(?:__|trans|trans_choice)|Lang::(?:get|has|choice)|@(?:lang|choice))\(\s*['"]([^'"]*)$/],
  ];
  for (const [kind, re] of tests) {
    const m = before.match(re);
    if (m) return { kind, typed: m[1] };
  }
  return null;
}

// ── Project data ───────────────────────────────────────────────────────────

const isLaravel = (p: Project) => p.files.includes(`${p.root}/artisan`);

async function routes(p: Project): Promise<RouteName[]> {
  const files = p.files.filter((f) => f.startsWith(`${p.root}/routes/`) && f.endsWith('.php'));
  return (await Promise.all(files.map((f) => cached(f, routeNames)))).flat();
}

async function configKeys(p: Project): Promise<Key[]> {
  const files = p.files.filter((f) => /\/config\/[^/]+\.php$/.test(f) && f.startsWith(`${p.root}/config/`));
  const lists = await Promise.all(files.map((f) => cached(f, (text) => arrayKeys(text, `${f.split('/').pop()!.replace(/\.php$/, '')}.`))));
  // The file itself is a key too: config('app').
  return [...files.map((f) => ({ key: f.split('/').pop()!.replace(/\.php$/, ''), preview: '[…]' })), ...lists.flat()];
}

async function translationKeys(p: Project): Promise<Key[]> {
  // lang/ (Laravel 9+) or resources/lang; English if there, else the first locale.
  const langFiles = p.files.filter((f) => f.startsWith(`${p.root}/lang/`) || f.startsWith(`${p.root}/resources/lang/`));
  const locales = [...new Set(langFiles.map((f) => f.match(/\/lang\/([^/.]+)[/.]/)?.[1]).filter(Boolean))] as string[];
  const locale = locales.includes('en') ? 'en' : locales[0];
  if (!locale) return [];
  const php = langFiles.filter((f) => new RegExp(`/lang/${locale}/[^/]+\\.php$`).test(f));
  const json = langFiles.filter((f) => f.endsWith(`/lang/${locale}.json`));
  const lists = await Promise.all([
    ...php.map((f) => cached(f, (text) => arrayKeys(text, `${f.split('/').pop()!.replace(/\.php$/, '')}.`))),
    ...json.map((f) =>
      cached(f, (text) => {
        try {
          return Object.entries(JSON.parse(text) as Record<string, unknown>).map(([key, v]) => ({ key, preview: String(v) }));
        } catch {
          return [];
        }
      }),
    ),
  ]);
  return lists.flat();
}

/** Values that look secret aren't shown in the completion list. */
const SECRET = /KEY|SECRET|PASSWORD|PASS$|TOKEN|PRIVATE|DSN/i;

async function items(kind: StringContext, p: Project): Promise<{ label: string; detail: string; kind: monaco.languages.CompletionItemKind }[]> {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'route':
      return (await routes(p)).map((r) => ({ label: r.name, detail: r.detail, kind: K.Reference }));
    case 'config':
      return (await configKeys(p)).map((c) => ({ label: c.key, detail: c.preview, kind: K.Property }));
    case 'view':
      return p.files.map((f) => viewName(f, p.root)).filter((v): v is string => !!v).map((v) => ({ label: v, detail: 'view', kind: K.File }));
    case 'env': {
      const env = p.files.find((f) => f === `${p.root}/.env`) ?? p.files.find((f) => f === `${p.root}/.env.example`);
      if (!env) return [];
      return (await cached(env, envKeys)).map((e) => ({ label: e.key, detail: SECRET.test(e.key) ? '••••' : e.preview, kind: K.Variable }));
    }
    case 'trans':
      return (await translationKeys(p)).map((t) => ({ label: t.key, detail: t.preview, kind: K.Text }));
  }
}

const provider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ["'", '"', '.', '-', '_', '/'],
  async provideCompletionItems(model, position) {
    const p = project;
    if (!p) return { suggestions: [] };
    const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const ctx = stringContext(before);
    if (!ctx) return { suggestions: [] };
    // env() works in any project; the rest needs Laravel.
    if (ctx.kind !== 'env' && !isLaravel(p)) return { suggestions: [] };
    const range = new monaco.Range(position.lineNumber, position.column - ctx.typed.length, position.lineNumber, position.column);
    const list = await items(ctx.kind, p);
    return {
      suggestions: list.map((it) => ({ label: { label: it.label, description: it.detail || undefined }, kind: it.kind, insertText: it.label, filterText: it.label, range })),
    };
  },
};

// PHP files, and Blade templates (opened as HTML) for @include, @extends, route() and __() in them.
monaco.languages.registerCompletionItemProvider('php', provider);
monaco.languages.registerCompletionItemProvider('html', provider);

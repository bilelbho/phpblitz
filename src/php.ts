// Regex-based PHP understanding. This is a stand-in until the Rust analysis
// engine (parser + type inference) exists: it is fast and good enough for
// structure, completion of members and route detection on typical code.

export type SymbolKind = 'class' | 'interface' | 'trait' | 'enum' | 'method' | 'property' | 'const' | 'function' | 'use';
export type Visibility = 'public' | 'protected' | 'private';

export interface PhpSymbol {
  kind: SymbolKind;
  name: string;
  /** Return type, property type, or "extends X" for classes. */
  detail: string;
  /** Parameter list for methods, without parentheses. */
  params?: string;
  line: number;
  depth: number;
  visibility: Visibility;
  isStatic?: boolean;
}

export interface ClassInfo {
  name: string;
  fqn: string;
  kind: 'class' | 'interface' | 'trait' | 'enum';
  path: string;
  line: number;
  extendsName?: string;
  members: PhpSymbol[];
}

const TYPE = String.raw`[\w\\?|]+`;

export function structureOf(src: string): PhpSymbol[] {
  const out: PhpSymbol[] = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    let m = line.match(/^\s*(?:(?:final|abstract|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)(?:\s+extends\s+([\w\\]+))?/);
    if (m) {
      out.push({ kind: m[1] as SymbolKind, name: m[2], detail: m[3] ? `extends ${m[3]}` : '', line: n, depth: 0, visibility: 'public' });
      return;
    }
    m = line.match(new RegExp(String.raw`^\s*(?:(?:final|abstract)\s+)*(public|protected|private)?\s*(static\s+)?function\s+(\w+)\s*\(([^)]*)(\))?(?:\s*:\s*(${TYPE}))?`));
    if (m) {
      // Parameters that continue on the next lines are shown as "…".
      const params = m[5] ? m[4].trim() : '…';
      let returnType = m[6] ?? '';
      if (!m[5]) {
        for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
          const close = lines[j].match(new RegExp(String.raw`\)\s*(?::\s*(${TYPE}))?`));
          if (close) {
            returnType = close[1] ?? '';
            break;
          }
        }
      }
      const inClass = out.some((s) => s.depth === 0 && s.kind !== 'function');
      out.push({
        kind: inClass ? 'method' : 'function',
        name: m[3],
        params,
        detail: returnType,
        line: n,
        depth: inClass ? 1 : 0,
        visibility: (m[1] as Visibility) ?? 'public',
        isStatic: !!m[2],
      });
      return;
    }
    m = line.match(new RegExp(String.raw`^\s*(public|protected|private)\s+(static\s+)?(?:readonly\s+)?(?:(${TYPE})\s+)?\$(\w+)`));
    if (m) {
      out.push({ kind: 'property', name: m[4], detail: m[3] ?? '', line: n, depth: 1, visibility: m[1] as Visibility, isStatic: !!m[2] });
      return;
    }
    m = line.match(/^\s*(?:(public|protected|private)\s+)?const\s+(?:\w+\s+)?(\w+)\s*=/);
    if (m) {
      out.push({ kind: 'const', name: m[2], detail: '', line: n, depth: 1, visibility: (m[1] as Visibility) ?? 'public', isStatic: true });
      return;
    }
    m = line.match(/^\s{4}use\s+([\w\\]+)(?:\s*,\s*[\w\\]+)*\s*;/);
    if (m) out.push({ kind: 'use', name: m[1], detail: 'trait', line: n, depth: 1, visibility: 'public' });
  });
  return out;
}

/** Imports (`use A\B\C;` and `use A\B\C as D;`) declared at the top of a file. */
export function importsOf(src: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of src.matchAll(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
    const fqn = m[1];
    map.set(m[2] ?? fqn.split('\\').pop()!, fqn);
  }
  return map;
}

export function classOf(path: string, src: string): ClassInfo | null {
  const symbols = structureOf(src);
  const cls = symbols.find((s) => s.depth === 0 && s.kind !== 'function');
  if (!cls) return null;
  const ns = src.match(/^namespace\s+([\w\\]+)\s*;/m)?.[1];
  return {
    name: cls.name,
    fqn: ns ? `${ns}\\${cls.name}` : cls.name,
    kind: cls.kind as ClassInfo['kind'],
    path,
    line: cls.line,
    extendsName: cls.detail.startsWith('extends ') ? cls.detail.slice(8).split('\\').pop() : undefined,
    members: symbols.filter((s) => s.depth === 1),
  };
}

/**
 * Member names used in a file: `->name`, `::name`, `::$name` and Laravel
 * route actions `[Controller::class, 'name']`. Counted by name only, so two
 * classes with a method of the same name share a count.
 */
export function memberReferences(src: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const m of src.matchAll(/(?:->|::)\$?([A-Za-z_]\w*)/g)) if (m[1] !== 'class') add(m[1]);
  for (const m of src.matchAll(/::class\s*,\s*['"](\w+)['"]/g)) add(m[1]);
  return counts;
}

/** Project-wide class index, keyed by short class name (several files may share one). */
export class PhpIndex {
  private byName = new Map<string, ClassInfo[]>();
  private byPath = new Map<string, ClassInfo>();
  private refsByPath = new Map<string, Map<string, number>>();
  private refTotals = new Map<string, number>();

  get size() {
    return this.byPath.size;
  }

  clear() {
    this.byName.clear();
    this.byPath.clear();
    this.refsByPath.clear();
    this.refTotals.clear();
  }

  update(path: string, src: string) {
    this.remove(path);
    const refs = memberReferences(src);
    this.refsByPath.set(path, refs);
    refs.forEach((n, name) => this.refTotals.set(name, (this.refTotals.get(name) ?? 0) + n));
    const info = classOf(path, src);
    if (!info) return;
    this.byPath.set(path, info);
    this.byName.set(info.name, [...(this.byName.get(info.name) ?? []), info]);
  }

  remove(path: string) {
    this.refsByPath.get(path)?.forEach((n, name) => {
      const left = (this.refTotals.get(name) ?? 0) - n;
      if (left > 0) this.refTotals.set(name, left);
      else this.refTotals.delete(name);
    });
    this.refsByPath.delete(path);
    const old = this.byPath.get(path);
    if (!old) return;
    this.byPath.delete(path);
    const rest = (this.byName.get(old.name) ?? []).filter((c) => c.path !== path);
    if (rest.length) this.byName.set(old.name, rest);
    else this.byName.delete(old.name);
  }

  /** How many times a member name is used across the indexed project. */
  /** What a PHP file declares (class, interface, trait, enum), for its icon. */
  kindOf(path: string): ClassInfo['kind'] | undefined {
    return this.byPath.get(path)?.kind;
  }

  usages(name: string): number {
    return this.refTotals.get(name) ?? 0;
  }

  find(name: string): ClassInfo | undefined {
    return this.byName.get(name.split('\\').pop() ?? name)?.[0];
  }

  all(): ClassInfo[] {
    return [...this.byPath.values()];
  }

  /** Members of a class including the ones it inherits from indexed parents. */
  membersOf(name: string): PhpSymbol[] {
    const out: PhpSymbol[] = [];
    const seen = new Set<string>();
    let cls = this.find(name);
    for (let depth = 0; cls && depth < 8; depth++) {
      for (const m of cls.members) {
        if (m.kind === 'use') continue;
        const key = m.kind + m.name;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(m);
        }
      }
      cls = cls.extendsName ? this.find(cls.extendsName) : undefined;
    }
    return out;
  }
}

export const phpIndex = new PhpIndex();

/** Parameter list as Structure shows it: types only, `$name` when untyped. */
export function paramTypes(params: string | undefined): string {
  if (!params) return '';
  if (params === '…') return '…';
  return params
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(?:(?:public|protected|private|readonly)\s+)*(?:([\w\\?|]+)\s+)?(?:&|\.\.\.)?\$(\w+)/);
      if (!m) return p;
      return m[1] ? m[1].split('\\').pop()! : `$${m[2]}`;
    })
    .join(', ');
}

/**
 * Best-effort type of `$var` (or `$this->prop`) at a point in a file:
 * typed parameters, typed/promoted properties, `new X` and `@var X` docblocks.
 */
export function inferType(src: string, expr: string): string | null {
  if (expr === '$this') {
    return structureOf(src).find((s) => s.depth === 0 && s.kind !== 'function')?.name ?? null;
  }
  const prop = expr.match(/^\$this->(\w+)$/);
  if (prop) {
    const p = structureOf(src).find((s) => s.kind === 'property' && s.name === prop[1]);
    return p?.detail ? clean(p.detail) : null;
  }
  const v = expr.slice(1).replace(/[^\w]/g, '');
  if (!v) return null;
  const patterns = [
    new RegExp(String.raw`([A-Z][\w\\]*)\s+\$${v}\b`),
    new RegExp(String.raw`\$${v}\s*=\s*new\s+([A-Z][\w\\]*)`),
    new RegExp(String.raw`@var\s+([A-Z][\w\\]*)\s+\$${v}\b`),
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) return clean(m[1]);
  }
  return null;
}

function clean(type: string) {
  return type.replace(/^\?/, '').split('|')[0].split('\\').pop() ?? type;
}

export interface Route {
  method: string;
  uri: string;
  handler: string;
  path: string;
  line: number;
  controller?: string;
  action?: string;
}

/** Laravel routes declared as Route::get('/uri', ...) in routes/*.php. */
export function routesOf(path: string, src: string): Route[] {
  const out: Route[] = [];
  src.split('\n').forEach((line, i) => {
    const m = line.match(/Route::(get|post|put|patch|delete|options|any|match)\(\s*['"]([^'"]*)['"]\s*,\s*(.+?)\)?\s*(?:->.*)?;?\s*$/i);
    if (!m) return;
    const action = m[3].match(/\[\s*([\w\\]+)::class\s*,\s*['"](\w+)['"]\s*\]/);
    const invokable = m[3].match(/^([\w\\]+)::class/);
    const controller = action?.[1] ?? invokable?.[1];
    const method = action?.[2] ?? (invokable ? '__invoke' : undefined);
    out.push({
      method: m[1].toUpperCase(),
      uri: m[2].startsWith('/') ? m[2] : `/${m[2]}`,
      handler: controller ? `${controller.split('\\').pop()}@${method}` : 'Closure',
      path,
      line: i + 1,
      controller: controller?.split('\\').pop(),
      action: method,
    });
  });
  return out;
}

export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (path.endsWith('.blade.php')) return 'html';
  const map: Record<string, string> = {
    php: 'php', json: 'json', jsonc: 'json', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', vue: 'html', svelte: 'html', css: 'css', scss: 'scss', less: 'less',
    html: 'html', xml: 'xml', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'shell', env: 'dotenv', ini: 'ini',
  };
  if (path.split('/').pop()?.startsWith('.env')) return 'dotenv';
  return map[ext] ?? 'plaintext';
}

// The project's symbols for the UI (Search Everywhere, completion, "N usages", file icons, routes).
// On the desktop they come from the Rust index (index.rs): Mago-parsed, project and vendor, cached on
// disk. For the sample project (and the browser preview) the small JS index in php.ts answers.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { importsOf, phpIndex, type PhpSymbol, type Visibility } from './php';

export type ClassKind = 'class' | 'interface' | 'trait' | 'enum';

export interface IndexMember {
  kind: 'method' | 'property' | 'const';
  name: string;
  detail: string;
  params?: string;
  line: number;
  visibility: 'public' | 'protected' | 'private';
  isStatic: boolean;
  /** The class a method returns or a property holds, fully qualified, or "static" (desktop index). */
  ty?: string | null;
  /** For collections (`User[]`, `Collection<int, User>`): the element class. */
  elem?: string | null;
}

export interface IndexFunction {
  name: string;
  fqn: string;
  params: string;
  detail: string;
  ty?: string | null;
  elem?: string | null;
}

export interface IndexClass {
  name: string;
  fqn: string;
  kind: ClassKind;
  line: number;
  path: string;
  extends?: string;
  members: IndexMember[];
  /** Own and inherited members (parents, traits, interfaces). */
  allMembers: IndexMember[];
}

export interface SearchHit {
  kind: ClassKind | 'method' | 'function';
  name: string;
  detail: string;
  path: string;
  line: number;
  vendor: boolean;
}

export interface IndexStats {
  files: number;
  classes: number;
  functions: number;
  parsed: number;
  ms: number;
}

const fromJsMember = (s: PhpSymbol): IndexMember => ({
  kind: s.kind === 'method' ? 'method' : s.kind === 'const' ? 'const' : 'property',
  name: s.name,
  detail: s.detail,
  params: s.params,
  line: s.line,
  visibility: s.visibility,
  isStatic: !!s.isStatic,
});

class Symbols {
  /** Answers come from Rust (desktop, a project on disk). */
  rust = false;
  /** Indexing in progress, with its progress. */
  progress: { done: number; total: number } | null = null;
  private kinds = new Map<string, ClassKind>();
  private listeners = new Set<() => void>();
  private version = 0;
  private unlisten: Promise<() => void> | null = null;
  private usageQueue = new Map<string, ((n: number) => void)[]>();
  private usageTimer = 0;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** Indexes a project on disk with the Rust index (cache first, then what changed). */
  async open(root: string, excludes: string[]): Promise<IndexStats> {
    this.rust = true;
    this.kinds.clear();
    this.progress = { done: 0, total: 0 };
    this.changed();
    this.unlisten ??= listen<{ done: number; total: number }>('index-progress', (e) => {
      if (!this.rust) return;
      this.progress = e.payload.done >= e.payload.total && e.payload.total > 0 ? null : e.payload;
      this.changed();
    });
    try {
      const stats = await invoke<IndexStats>('index_open', { root, excludes });
      const kinds = await invoke<[string, ClassKind][]>('index_kinds');
      this.kinds = new Map(kinds);
      return stats;
    } finally {
      this.progress = null;
      this.changed();
    }
  }

  /** The sample project (or the browser): the JS index. */
  useJs() {
    this.rust = false;
    this.kinds.clear();
    this.progress = null;
    this.changed();
  }

  /** Saves the Rust index cache (project closing). */
  save() {
    if (this.rust) void invoke('index_save').catch(() => {});
  }

  /** Files changed or deleted on disk. */
  async update(changed: string[], removed: string[]) {
    if (!this.rust || (!changed.length && !removed.length)) return;
    const kinds = await invoke<[string, ClassKind | null][]>('index_update', { changed, removed }).catch(() => []);
    for (const p of removed) this.kinds.delete(p);
    for (const [p, k] of kinds) k ? this.kinds.set(p, k) : this.kinds.delete(p);
    this.changed();
  }

  /**
   * The Structure of an indexed file (classes, members, functions), exact from the index; null
   * when the index doesn't have it (browser sample, a file not indexed yet). `text` places the
   * trait `use` lines, which the index lists without their lines.
   */
  async structure(path: string, text: string): Promise<PhpSymbol[] | null> {
    if (!this.rust) return null;
    const file = await invoke<IndexedStructure | null>('index_file_structure', { path }).catch(() => null);
    return file ? structureFromIndex(file, text) : null;
  }

  /** An open file's current (unsaved) text. */
  async updateText(path: string, text: string) {
    if (!this.rust) {
      phpIndex.update(path, text);
      return;
    }
    const kind = await invoke<ClassKind | null>('index_update_text', { path, text }).catch(() => undefined);
    if (kind === undefined) return;
    if ((this.kinds.get(path) ?? null) !== kind) {
      kind ? this.kinds.set(path, kind) : this.kinds.delete(path);
      this.changed();
    }
  }

  /** What a file declares (for its icon). */
  kindOf(path: string): ClassKind | undefined {
    return this.rust ? this.kinds.get(path) : phpIndex.kindOf(path);
  }

  /** Classes, methods and functions matching a query, best first. */
  async search(query: string, limit = 80): Promise<SearchHit[]> {
    if (this.rust) return invoke<SearchHit[]>('index_search', { query, limit }).catch(() => []);
    const q = query.trim().toLowerCase();
    const out: [number, SearchHit][] = [];
    for (const c of phpIndex.all()) {
      const n = c.name.toLowerCase();
      const s = !q ? 3 : n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : -1;
      if (s >= 0) out.push([s, { kind: c.kind, name: c.name, detail: c.fqn, path: c.path, line: c.line, vendor: false }]);
      if (!q) continue;
      for (const m of c.members) {
        if (m.kind !== 'method' || m.visibility !== 'public' || !m.name.toLowerCase().includes(q)) continue;
        out.push([m.name.toLowerCase().startsWith(q) ? 4 : 5, { kind: 'method', name: `${c.name}::${m.name}()`, detail: m.detail, path: c.path, line: m.line, vendor: false }]);
      }
    }
    return out
      .sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length)
      .slice(0, limit)
      .map(([, h]) => h);
  }

  /**
   * A class with its members (inherited ones too). `name` as written in `src`: resolved through
   * its `use` imports and namespace, else looked up by short name.
   */
  async classInfo(name: string, src?: string): Promise<IndexClass | null> {
    const fqn = src ? resolveName(name, src) : name;
    if (this.rust) return invoke<IndexClass | null>('index_class', { name: fqn }).catch(() => null);
    const c = phpIndex.find(name);
    if (!c) return null;
    return { name: c.name, fqn: c.fqn, kind: c.kind, line: c.line, path: c.path, extends: c.extendsName, members: c.members.map(fromJsMember), allMembers: phpIndex.membersOf(name).map(fromJsMember) };
  }

  /** A function called as `name()` in `src` (its namespace, else the global one), for its return type. */
  async functionInfo(name: string, src?: string): Promise<IndexFunction | null> {
    if (!this.rust) return null;
    const namespace = src?.match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1] ?? null;
    return invoke<IndexFunction | null>('index_function', { name, namespace }).catch(() => null);
  }

  /** "N usages" (by name), batched into one request per frame. */
  usages(name: string): Promise<number> {
    if (!this.rust) return Promise.resolve(phpIndex.usages(name));
    return new Promise((resolve) => {
      this.usageQueue.set(name, [...(this.usageQueue.get(name) ?? []), resolve]);
      window.clearTimeout(this.usageTimer);
      this.usageTimer = window.setTimeout(() => {
        const queue = this.usageQueue;
        this.usageQueue = new Map();
        const names = [...queue.keys()];
        invoke<number[]>('index_usages', { names })
          .then((counts) => names.forEach((n, i) => queue.get(n)!.forEach((r) => r(counts[i] ?? 0))))
          .catch(() => names.forEach((n) => queue.get(n)!.forEach((r) => r(0))));
      }, 16);
    });
  }
}

/** `User` in a file with `use App\Models\User;` → `App\Models\User`; else the file's namespace. */
export function resolveName(name: string, src: string): string {
  if (name.startsWith('\\')) return name.slice(1);
  const [first, ...rest] = name.split('\\');
  const imported = importsOf(src).get(first);
  if (imported) return [imported, ...rest].join('\\');
  if (name.includes('\\')) return name;
  const ns = src.match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1];
  return ns ? `${ns}\\${name}` : name;
}

export const symbols = new Symbols();

/** Re-renders when the index changes (file icons, indexing progress). */
export function useSymbols() {
  useSyncExternalStore(symbols.subscribe, symbols.getSnapshot);
  return symbols;
}

if (import.meta.hot) import.meta.hot.dispose(() => location.reload());

interface IndexedMember {
  kind: 'method' | 'property' | 'const';
  name: string;
  detail: string;
  params?: string | null;
  line: number;
  visibility: Visibility;
  isStatic: boolean;
}

interface IndexedStructure {
  classes: { name: string; kind: 'class' | 'interface' | 'trait' | 'enum'; line: number; endLine: number; extends?: string | null; traits: string[]; members: IndexedMember[] }[];
  functions: { name: string; line: number; params: string; detail: string }[];
}

/** The Structure panel's rows from the index, in file order, like structureOf's. */
export function structureFromIndex(file: IndexedStructure, text: string): PhpSymbol[] {
  const out: PhpSymbol[] = [];
  const lines = text.split('\n');
  for (const c of file.classes) {
    out.push({ kind: c.kind, name: c.name, detail: c.extends ? `extends ${c.extends.split('\\').pop()}` : '', line: c.line, depth: 0, visibility: 'public' });
    for (const m of c.members) {
      out.push({ kind: m.kind, name: m.name, detail: m.detail, params: m.kind === 'method' ? (m.params ?? '') : undefined, line: m.line, depth: 1, visibility: m.visibility, isStatic: m.isStatic || m.kind === 'const' });
    }
    // Trait imports inside the class body.
    if (c.traits.length) {
      for (let n = c.line; n <= Math.min(c.endLine || c.line, lines.length); n++) {
        const m = lines[n - 1].match(/^\s*use\s+([\w\\]+)(?:\s*,\s*[\w\\]+)*\s*[;{]/);
        if (m) out.push({ kind: 'use', name: m[1], detail: 'trait', line: n, depth: 1, visibility: 'public' });
      }
    }
  }
  for (const f of file.functions) out.push({ kind: 'function', name: f.name, detail: f.detail, params: f.params, line: f.line, depth: 0, visibility: 'public' });
  return out.sort((a, b) => a.line - b.line || a.depth - b.depth);
}

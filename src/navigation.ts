// Go to Definition (Ctrl+click, Ctrl+B) and Find Usages (Alt+F7) without a language server, from
// the Rust symbol index: what is under the caret is worked out here (a class, a member on some
// receiver, a function, or a declaration), then the index finds where it lives or where it is used.

import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { inferType, structureOf } from './php';
import { isLspActive } from './lsp/monacoBridge';
import { uriToPath } from './lsp/client';
import { resolveName, symbols } from './symbols';

export type Target =
  | { kind: 'class'; name: string }
  | { kind: 'member'; class: string; name: string; memberKind?: 'method' | 'property' | 'const' }
  | { kind: 'function'; name: string; namespace?: string };

export interface Location {
  path: string;
  line: number;
  name: string;
}

export interface UsageHit {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  dynamic: boolean;
  /** Properties: 'read' or 'write'. */
  access: '' | 'read' | 'write';
}

const namespaceOf = (src: string) => src.match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1];

/** The class declared around a line, as an FQN. */
function classAround(src: string, line: number): { fqn: string; extendsName?: string } | null {
  const classes = structureOf(src).filter((s) => s.depth === 0 && ['class', 'interface', 'trait', 'enum'].includes(s.kind) && s.line <= line);
  const c = classes[classes.length - 1];
  if (!c) return null;
  const ns = namespaceOf(src);
  const ext = c.detail.match(/^extends\s+([\w\\]+)/)?.[1];
  return { fqn: ns ? `${ns}\\${c.name}` : c.name, extendsName: ext ? resolveName(ext, src) : undefined };
}

/** What is at a position: a class, a member, a function, or the declaration of one of them. */
export function targetAt(model: monaco.editor.ITextModel, position: monaco.IPosition): Target | null {
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const src = model.getValue();
  const text = model.getLineContent(position.lineNumber);
  const before = text.slice(0, word.startColumn - 1);
  const after = text.slice(word.endColumn - 1);
  const name = word.word.replace(/^\$/, '');
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const isCall = /^\s*\(/.test(after);
  const own = () => classAround(src, position.lineNumber);

  // Declarations: class X, function x(, $property, const X.
  if (/\b(class|interface|trait|enum)\s+$/i.test(before)) return { kind: 'class', name: resolveName(name, src) };
  if (/\bfunction\s+&?\s*$/i.test(before)) {
    const inClass = structureOf(src).some((s) => s.depth > 0 && s.kind === 'method' && s.name === name && s.line === position.lineNumber);
    const c = own();
    if (inClass && c) return { kind: 'member', class: c.fqn, name, memberKind: 'method' };
    const ns = namespaceOf(src);
    return { kind: 'function', name: ns ? `${ns}\\${name}` : name };
  }
  // A property declaration: `private ?User $user`, `public static int $count`.
  const variable = word.word.startsWith('$') || before.endsWith('$');
  if (variable && !/\bfunction\b/.test(before) && /^\s*(?:(?:public|protected|private|var|static|readonly)\b\s*)+[^=;(]*$/.test(before)) {
    const c = own();
    if (c) return { kind: 'member', class: c.fqn, name, memberKind: 'property' };
  }
  if (/\bconst\s+(?:\w+\s+)?$/i.test(before)) {
    const c = own();
    if (c) return { kind: 'member', class: c.fqn, name, memberKind: 'const' };
  }

  // Members: $this->x, $var->x(), self::x, Class::X, parent::x().
  const access = before.match(/(\$this(?:->\w+)?|\$\w+|\b(?:self|static|parent)|\\?[A-Za-z_][\w\\]*)\s*(\?->|->|::)\s*(\$?)$/i);
  if (access) {
    const [, receiver, op, dollar] = access;
    const memberKind: 'method' | 'property' | 'const' = isCall ? 'method' : op === '::' ? (dollar ? 'property' : 'const') : 'property';
    let cls: string | null = null;
    const r = receiver.toLowerCase();
    if (r === '$this' || r === 'self' || r === 'static') cls = own()?.fqn ?? null;
    else if (r === 'parent') cls = own()?.extendsName ?? null;
    else if (receiver.startsWith('$')) {
      const t = inferType(src, receiver);
      cls = t ? resolveName(t, src) : null;
    } else cls = resolveName(receiver, src);
    return cls ? { kind: 'member', class: cls, name, memberKind } : null;
  }

  // A function call: foo(), Ns\foo().
  const qualified = (before.match(/\\?(?:[A-Za-z_]\w*\\)*$/)?.[0] ?? '') + name;
  if (isCall && !/\b(new|function)\s+$/i.test(before) && !/^[A-Z]/.test(name)) {
    return { kind: 'function', name: qualified.replace(/^\\/, ''), namespace: qualified.includes('\\') ? undefined : namespaceOf(src) };
  }

  // A class: use statements, type hints, new X, extends / implements, X::class.
  const useLine = text.match(/^\s*use\s+([\w\\]+)/);
  if (useLine && useLine[1].includes(name)) {
    const full = useLine[1];
    return { kind: 'class', name: full.slice(0, full.indexOf(name) + name.length) };
  }
  if (/^[A-Z]/.test(name) || /\b(new|extends|implements|instanceof)\s+\\?[\w\\]*$/i.test(before)) return { kind: 'class', name: resolveName(qualified, src) };
  return null;
}

export const locate = (target: Target) => invoke<Location | null>('index_locate', { target }).catch(() => null);

export function findUsages(target: Target, overrides: Record<string, string>, includeVendor = false) {
  return invoke<{ name: string; kind: string; title: string; container: string; declaredIn: string; items: UsageHit[]; files: number }>('index_find_usages', { target, overrides, includeVendor });
}

// ── Monaco: Ctrl+click / Ctrl+B ─────────────────────────────────

let opener: ((path: string, line: number, column: number) => void) | null = null;
/** How to open another file at a line (set by the workspace). */
export function setDefinitionOpener(fn: typeof opener) {
  opener = fn;
}

monaco.languages.registerDefinitionProvider('php', {
  async provideDefinition(model, position) {
    // A language server answers through its own provider.
    if (isLspActive() || !symbols.rust) return null;
    const target = targetAt(model, position);
    if (!target) return null;
    const loc = await locate(target);
    if (!loc) return null;
    return { uri: monaco.Uri.file(loc.path), range: new monaco.Range(loc.line, 1, loc.line, 1) };
  },
});

// Definitions in other files open in a PHPBlitz tab (the language server's opener only works while it runs).
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    if (!opener || isLspActive()) return false;
    const pos = selectionOrPosition
      ? 'startLineNumber' in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, col: selectionOrPosition.startColumn }
        : { line: selectionOrPosition.lineNumber, col: selectionOrPosition.column }
      : { line: 1, col: 1 };
    // Monaco writes the drive in lower case (file:///c%3A/...); PHPBlitz paths keep C:.
    opener(uriToPath(resource.toString()), pos.line, pos.col);
    return true;
  },
});

// Providers are registered once per page: reload fully instead of registering them twice.
import.meta.hot?.dispose(() => location.reload());

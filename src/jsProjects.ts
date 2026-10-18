// JavaScript and TypeScript inside the PHP project: every folder with a package.json, tsconfig.json
// or jsconfig.json (a Laravel front end in resources/js, a Vue or React app, a Node tool) is a JS
// project. Monaco's TypeScript service gives completion, errors, hover, Go to Declaration, Find
// Usages and Rename in .js/.jsx/.ts/.tsx files; it runs in a web worker, so it only knows the files
// it is given. This module gives it the projects' sources, the types of their npm packages (from
// node_modules, read by src-tauri/src/js.rs) and the compiler options from their tsconfig files.
//
// It loads when the first JS or TS file opens, so PHP-only work never pays for it.

import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import type { Backend, Problem } from './backend/types';
import { isTauri } from './platform';
import { perf } from './perf';
import type { Usage } from './lsp/monacoBridge';
import { uriToPath } from './lsp/client';
import type { NameEdit, RenamePlan } from './rename';

const ts = monaco.languages.typescript;

export interface JsProject {
  /** The folder, without a trailing slash. */
  root: string;
  name: string;
  /** package.json content, when there is one. */
  manifest: Manifest | null;
  /** The tsconfig.json or jsconfig.json that applies. */
  config: string | null;
}

interface Manifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Context {
  backend: Backend;
  files: string[];
  notify: (n: { title: string; body: string; tone: 'info' | 'warning' }) => void;
}

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SCRIPT_LANGUAGES = new Set(['javascript', 'typescript']);
/** Build output, caches and other generated folders: not the project's own code. */
const GENERATED = /\/(?:node_modules|vendor|dist|build|out|coverage|storage|bootstrap\/cache|\.next|\.nuxt|\.output|\.svelte-kit|\.turbo|\.cache|public\/(?:build|vendor|hot))\//;
const MAX_SOURCES = 5_000;

export const isScriptFile = (path: string) => SCRIPT.test(path);
export const isScriptModel = (model: monaco.editor.ITextModel) => SCRIPT_LANGUAGES.has(model.getLanguageId());

let context: Context | null = null;
let loading: Promise<void> | null = null;
let projects: JsProject[] = [];
const listeners = new Set<() => void>();

/** The open project's files; null when it closes. Loading waits for the first JS or TS file. */
export function setScriptContext(next: Context | null) {
  const changed = next?.backend !== context?.backend;
  context = next;
  if (changed) {
    loading = null;
    projects = [];
    ts.typescriptDefaults.setExtraLibs([]);
    ts.javascriptDefaults.setExtraLibs([]);
    emit();
  }
  // The file list arrives after the first tabs may already have opened.
  if (next && !loading && monaco.editor.getModels().some(isScriptModel)) void ensureLoaded();
}

monaco.editor.onDidCreateModel((model) => {
  if (context && !loading && isScriptModel(model)) void ensureLoaded();
});

/** The JS projects found, for the npm tool window. */
export function jsProjects(): JsProject[] {
  return projects;
}

export function onJsProjectsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn());
}

/** Folders with a package.json, tsconfig.json or jsconfig.json, outermost first. */
export function findJsProjects(files: string[]): { root: string; manifest: string | null; configs: string[] }[] {
  const byRoot = new Map<string, { root: string; manifest: string | null; configs: string[] }>();
  for (const path of files) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const isManifest = name === 'package.json';
    if (!isManifest && !/^[tj]sconfig(?:\.[\w-]+)?\.json$/.test(name)) continue;
    const root = path.slice(0, path.lastIndexOf('/'));
    if (GENERATED.test(root + '/')) continue;
    const entry = byRoot.get(root) ?? { root, manifest: null, configs: [] };
    if (isManifest) entry.manifest = path;
    else entry.configs.push(path);
    byRoot.set(root, entry);
  }
  // A folder with only tsconfig.app.json or the like isn't a project of its own.
  return [...byRoot.values()]
    .filter((p) => p.manifest || p.configs.some((c) => /\/[tj]sconfig\.json$/.test(c)))
    .sort((a, b) => a.root.length - b.root.length || a.root.localeCompare(b.root));
}

// ── Configuration ──────────────────────────────────────────────

/** JSON with comments and trailing commas, as tsconfig files are written. */
export function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

/** Joins and resolves `.` and `..`; `rel` may be absolute. */
export function resolvePath(base: string, rel: string): string {
  if (/^(?:[A-Za-z]:)?\//.test(rel)) return rel;
  const parts = base.split('/');
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}

interface RawOptions {
  [key: string]: unknown;
  paths?: Record<string, string[]>;
  baseUrl?: string;
}

/** compilerOptions of a tsconfig, `extends` and the app config of a solution file applied. */
async function readConfig(path: string, read: (p: string) => Promise<string>, depth = 0): Promise<{ options: RawOptions; pathsBase: string }> {
  const empty = { options: {}, pathsBase: dirOf(path) };
  if (depth > 5) return empty;
  let json: any;
  try {
    json = parseJsonc(await read(path));
  } catch {
    return empty;
  }
  const dir = dirOf(path);
  let base = empty;
  for (const parent of ([] as string[]).concat(json.extends ?? [])) {
    const file = parent.startsWith('.') || parent.startsWith('/') ? resolvePath(dir, parent) : `${nodeModulesOf(dir)}/${parent}`;
    const next = await readConfig(file.endsWith('.json') ? file : `${file}.json`, read, depth + 1);
    base = { options: { ...base.options, ...next.options }, pathsBase: next.options.paths ? next.pathsBase : base.pathsBase };
  }
  // Vite's tsconfig.json only lists references (tsconfig.app.json, tsconfig.node.json): the app's
  // options are the ones that matter in the editor.
  if (Array.isArray(json.references) && !json.compilerOptions) {
    const app = json.references.map((r: { path: string }) => resolvePath(dir, r.path)).find((p: string) => !/node/.test(p));
    if (app) return readConfig(app.endsWith('.json') ? app : `${app}/tsconfig.json`, read, depth + 1);
  }
  const own: RawOptions = json.compilerOptions ?? {};
  const options = { ...base.options, ...own };
  // Paths are relative to baseUrl, or else to the config file that declares them.
  const pathsBase = own.baseUrl ? resolvePath(dir, own.baseUrl) : own.paths ? dir : base.pathsBase;
  return { options, pathsBase };
}

/** Packages installed next to the project, or the nearest parent folder (hoisted workspaces). */
function nodeModulesOf(dir: string): string {
  return `${dir}/node_modules`;
}

const JSX: Record<string, number> = { preserve: 1, react: 2, 'react-native': 3, 'react-jsx': 4, 'react-jsxdev': 5 };

/** The worker's module names are URIs: `file:///c%3A/...`. A trailing `*` stays a wildcard. */
function uriPattern(path: string): string {
  const star = path.indexOf('*');
  if (star < 0) return monaco.Uri.file(path).toString();
  const head = path.slice(0, star);
  const uri = monaco.Uri.file(head || '/').toString();
  return (head.endsWith('/') && !uri.endsWith('/') ? uri + '/' : uri) + path.slice(star);
}

/** Path aliases from a Vite config: `'@': path.resolve(__dirname, './src')`, `'~': '/resources/js'`. */
export function viteAliases(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*['"]?(@[\w-]*|~|#[\w-]*)['"]?\s*:(.*)$/.exec(line);
    if (!m) continue;
    const strings = [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1]);
    const target = strings.pop();
    if (target && /^[./]/.test(target)) out[m[1]] = target.replace(/^\.?\//, '').replace(/\/$/, '');
  }
  return out;
}

const depsOf = (m: Manifest | null) => ({ ...m?.peerDependencies, ...m?.devDependencies, ...m?.dependencies });

// ── Loading ────────────────────────────────────────────────────

function ensureLoaded(): Promise<void> {
  const ctx = context;
  if (!ctx) return Promise.resolve();
  loading ??= perf.time('JS/TS projects', load(ctx), () => describe()).catch((e) => {
    console.warn('JS/TS support', e);
  });
  return loading;
}

let summary = '';
const describe = () => summary;

async function load(ctx: Context): Promise<void> {
  const { backend, files } = ctx;
  const read = (p: string) => backend.readFile(p);
  const found = findJsProjects(files);

  const loaded: JsProject[] = [];
  const paths: Record<string, string[]> = {};
  let options: RawOptions = {};
  let jsx: number | undefined;
  let jsxImportSource: string | undefined;
  const allDeps = new Set<string>();
  for (const p of found) {
    let manifest: Manifest | null = null;
    if (p.manifest) manifest = await read(p.manifest).then((t) => JSON.parse(t) as Manifest, () => null);
    const config = p.configs.find((c) => /\/tsconfig\.json$/.test(c)) ?? p.configs.find((c) => /\/jsconfig\.json$/.test(c)) ?? null;
    loaded.push({ root: p.root, name: manifest?.name || p.root.slice(p.root.lastIndexOf('/') + 1) || p.root, manifest, config });
    const deps = depsOf(manifest);
    Object.keys(deps).forEach((d) => allDeps.add(d));

    let own: RawOptions = {};
    if (config) {
      const { options: o, pathsBase } = await readConfig(config, read);
      own = o;
      for (const [alias, targets] of Object.entries(o.paths ?? {})) {
        (paths[alias] ??= []).push(...targets.map((t) => uriPattern(resolvePath(pathsBase, t))));
      }
    }
    // The first project with a config sets the language options (strictness, decorators…).
    if (config && !Object.keys(options).length) options = own;
    if (jsx === undefined && typeof own.jsx === 'string') jsx = JSX[own.jsx.toLowerCase()];
    if (!jsxImportSource && typeof own.jsxImportSource === 'string') jsxImportSource = own.jsxImportSource;

    // Bundler aliases the tsconfig doesn't repeat: Laravel's `@` for resources/js, a Vite config's.
    const viteConfig = files.find((f) => dirOf(f) === p.root && /\/vite\.config\.[cm]?[jt]s$/.test(f));
    const aliases: Record<string, string> = viteConfig ? viteAliases(await read(viteConfig).catch(() => '')) : {};
    if ('laravel-vite-plugin' in deps && !aliases['@']) aliases['@'] = 'resources/js';
    for (const [alias, target] of Object.entries(aliases)) {
      if (paths[`${alias}/*`]) continue;
      paths[`${alias}/*`] = [uriPattern(`${resolvePath(p.root, target)}/*`)];
    }
  }
  if (jsx === undefined) jsx = allDeps.has('react') || allDeps.has('preact') ? JSX['react-jsx'] : JSX.preserve;
  if (!jsxImportSource && allDeps.has('preact') && !allDeps.has('react')) jsxImportSource = 'preact';
  if (!jsxImportSource && allDeps.has('solid-js')) jsxImportSource = 'solid-js';

  // The projects' own code, the PHP project's scripts outside them included.
  const sources = files.filter((f) => SCRIPT.test(f) && !GENERATED.test(f) && !/\.min\.js$/.test(f)).slice(0, MAX_SOURCES);
  const sourceFiles: { path: string; content: string }[] =
    isTauri && backend.kind === 'disk'
      ? await invoke<{ path: string; content: string }[]>('js_read_sources', { paths: sources })
      : await Promise.all(sources.map(async (path) => ({ path, content: await read(path).catch(() => '') })));

  // Types of the npm packages, for the projects that have a package.json.
  const typeFiles: { path: string; content: string }[] = [];
  const missing = new Set<string>();
  let truncated = false;
  if (isTauri && backend.kind === 'disk') {
    for (const p of loaded.filter((p) => p.manifest)) {
      const found = await invoke<{ files: { path: string; content: string }[]; missing: string[]; hasNodeModules: boolean; truncated: boolean }>('js_type_files', { root: p.root });
      typeFiles.push(...found.files);
      found.missing.forEach((m) => missing.add(m));
      truncated ||= found.truncated;
    }
  }
  if (context !== ctx) return;

  const libs = new Map<string, string>();
  for (const f of [...typeFiles, ...sourceFiles]) libs.set(monaco.Uri.file(f.path).toString(), f.content);
  // Imports the TypeScript service can't read: components and assets, typed loosely.
  const shims: string[] = [];
  if (allDeps.has('vue')) shims.push("declare module '*.vue' { import type { DefineComponent } from 'vue'; const component: DefineComponent<{}, {}, any>; export default component; }");
  if (allDeps.has('svelte')) shims.push("declare module '*.svelte' { const component: any; export default component; }");
  // Vite's client types declare the assets themselves.
  if (!typeFiles.some((f) => f.path.endsWith('/vite/client.d.ts'))) {
    for (const ext of ['css', 'scss', 'sass', 'less', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'woff', 'woff2']) shims.push(`declare module '*.${ext}' { const value: any; export default value; }`);
  }
  shims.push("declare module '*?raw' { const text: string; export default text; }", "declare module '*?url' { const url: string; export default url; }");
  libs.set('file:///phpblitz/shims.d.ts', shims.join('\n'));
  const extraLibs = [...libs].map(([filePath, content]) => ({ filePath, content }));

  const pick = (key: string) => (options[key] === undefined ? {} : { [key]: options[key] });
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: 100 as monaco.languages.typescript.ModuleResolutionKind, // "bundler": package.json "exports" too
    allowJs: true,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    jsx,
    ...(jsxImportSource ? { jsxImportSource } : {}),
    ...(Object.keys(paths).length ? { paths } : {}),
    ...['strict', 'noImplicitAny', 'strictNullChecks', 'noImplicitThis', 'experimentalDecorators', 'emitDecoratorMetadata', 'useDefineForClassFields', 'checkJs', 'noUnusedLocals', 'noUnusedParameters', 'noFallthroughCasesInSwitch', 'exactOptionalPropertyTypes', 'noUncheckedIndexedAccess'].reduce((o, k) => ({ ...o, ...pick(k) }), {}),
  };
  // Without node_modules every package import would be an error: hold those back until npm install.
  const noPackages = loaded.some((p) => p.manifest && Object.keys(depsOf(p.manifest)).length) && (!(isTauri && backend.kind === 'disk') || missing.size > 0);
  const diagnostics: monaco.languages.typescript.DiagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // 2307/2792: cannot find module; 7016: untyped package; 2875/7026: JSX runtime types missing.
    diagnosticCodesToIgnore: noPackages ? [2307, 2792, 7016, 2875, 7026] : [7016],
  };
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
    defaults.setDiagnosticsOptions(diagnostics);
    defaults.setExtraLibs(extraLibs);
    defaults.setEagerModelSync(true);
  }

  projects = loaded;
  emit();
  const mb = (extraLibs.reduce((n, l) => n + l.content.length, 0) / 1048576).toFixed(1);
  summary = `${loaded.length} project${loaded.length === 1 ? '' : 's'}, ${sourceFiles.length.toLocaleString()} source files, ${typeFiles.filter((f) => !f.path.endsWith('package.json')).length.toLocaleString()} type files (${mb} MB)`;
  if (missing.size) {
    const list = [...missing].slice(0, 5).join(', ') + (missing.size > 5 ? ` and ${missing.size - 5} more` : '');
    ctx.notify({ title: 'npm packages are not installed', body: `Completion for ${list} needs them: run npm install (or your package manager) in the project.`, tone: 'warning' });
  } else if (truncated) {
    ctx.notify({ title: 'Some package types were left out', body: 'node_modules holds more type definitions than the editor loads: completion may miss a few packages.', tone: 'info' });
  }
}

/** A file was saved, changed on disk or deleted (`text` null): the TypeScript service sees it. */
const pending = new Map<string, string | null>();
let flushTimer = 0;
export function scriptFileChanged(path: string, text: string | null) {
  if (!loading || !SCRIPT.test(path) || GENERATED.test(path)) return;
  pending.set(path, text);
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, 400);
}

function flush() {
  if (!pending.size) return;
  const libs = new Map(Object.entries(ts.typescriptDefaults.getExtraLibs()).map(([k, v]) => [k, v.content]));
  for (const [path, text] of pending) {
    const key = monaco.Uri.file(path).toString();
    if (text === null) libs.delete(key);
    else libs.set(key, text);
  }
  pending.clear();
  const extraLibs = [...libs].map(([filePath, content]) => ({ filePath, content }));
  ts.typescriptDefaults.setExtraLibs(extraLibs);
  ts.javascriptDefaults.setExtraLibs(extraLibs);
}

/** Reads a changed file from disk (the watcher only says it changed). */
export async function scriptFilesChanged(changes: { path: string; exists: boolean; isDir: boolean }[], read: (p: string) => Promise<string>) {
  if (!loading) return;
  for (const c of changes) {
    if (c.isDir || !SCRIPT.test(c.path)) continue;
    scriptFileChanged(c.path, c.exists ? await read(c.path).catch(() => null) : null);
  }
}

// ── Editor features on top of the TypeScript service ───────────

async function workerFor(model: monaco.editor.ITextModel) {
  const get = model.getLanguageId() === 'typescript' ? ts.getTypeScriptWorker : ts.getJavaScriptWorker;
  const worker = await get();
  return worker(model.uri);
}

/** The worker names files by URI string; this is the path PHPBlitz opens. */
export const uriToFilePath = uriToPath;

function textOf(fileName: string): string | null {
  const model = monaco.editor.getModel(monaco.Uri.parse(fileName));
  if (model) return model.getValue();
  return ts.typescriptDefaults.getExtraLibs()[fileName]?.content ?? null;
}

/** Offset → 1-based line and UTF-16 column. */
function positionIn(text: string, offset: number): { line: number; column: number; lineText: string } {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  const end = text.indexOf('\n', start);
  return { line, column: offset - start + 1, lineText: text.slice(start, end < 0 ? undefined : end).replace(/\r$/, '') };
}

interface DisplayPart {
  text: string;
}
const joinParts = (parts?: DisplayPart[]) => (parts ?? []).map((p) => p.text).join('');

/** The documentation popup's Markdown: the signature, its doc comment and @tags. */
export async function scriptHover(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<string | null> {
  const worker = await workerFor(model);
  const info = (await worker.getQuickInfoAtPosition(model.uri.toString(), model.getOffsetAt(position))) as
    | { displayParts?: DisplayPart[]; documentation?: DisplayPart[]; tags?: { name: string; text?: DisplayPart[] }[] }
    | undefined;
  if (!info) return null;
  const lang = model.getLanguageId() === 'typescript' ? 'typescript' : 'javascript';
  const out = ['```' + lang + '\n' + joinParts(info.displayParts) + '\n```'];
  const doc = joinParts(info.documentation);
  if (doc) out.push(doc);
  const tags = (info.tags ?? []).map((t) => {
    const text = joinParts(t.text);
    return `*@${t.name}*${text ? ` — ${text}` : ''}`;
  });
  if (tags.length) out.push(tags.join('  \n'));
  return out.join('\n\n');
}

interface Reference {
  fileName: string;
  textSpan: { start: number; length: number };
  isWriteAccess?: boolean;
}

/** `file:offset` of the declarations of the symbol at an offset. */
async function definitionsAt(worker: Awaited<ReturnType<typeof workerFor>>, fileName: string, offset: number): Promise<Set<string> & { kind?: string }> {
  const found = ((await worker.getDefinitionAtPosition(fileName, offset)) ?? []) as (Reference & { kind?: string })[];
  return Object.assign(new Set(found.map((d) => `${d.fileName}:${d.textSpan.start}`)), { kind: found[0]?.kind });
}

/** Find Usages: every reference but the declarations, in the project (not node_modules). */
export async function scriptUsages(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<{ name: string; usages: Usage[] }> {
  const worker = await workerFor(model);
  const offset = model.getOffsetAt(position);
  const name = model.getWordAtPosition(position)?.word ?? '';
  const fileName = model.uri.toString();
  const references = ((await worker.getReferencesAtPosition(fileName, offset)) ?? []) as Reference[];
  const skip = await definitionsAt(worker, fileName, offset);
  const usages: Usage[] = [];
  for (const r of references) {
    const key = `${r.fileName}:${r.textSpan.start}`;
    if (skip.has(key) || /\/node_modules\//.test(r.fileName)) continue;
    skip.add(key);
    const text = textOf(r.fileName);
    if (text === null) continue;
    const at = positionIn(text, r.textSpan.start);
    usages.push({
      path: uriToFilePath(r.fileName),
      line: at.line,
      column: at.column,
      endColumn: at.column + r.textSpan.length,
      preview: at.lineText.trim(),
      // An import names the symbol; it doesn't write it.
      access: /^\s*(?:import|export)\b/.test(at.lineText) ? '' : r.isWriteAccess ? 'write' : 'read',
    });
  }
  return { name, usages };
}

/** Rename (Shift+F6): where the name is declared and used, as the rename dialog's plan. */
export async function scriptRenamePlan(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<RenamePlan> {
  const worker = await workerFor(model);
  const fileName = model.uri.toString();
  const offset = model.getOffsetAt(position);
  const info = (await worker.getRenameInfo(fileName, offset, { allowRenameOfImportPath: false })) as
    | { canRename: true; displayName: string; kind: string }
    | { canRename: false; localizedErrorMessage: string };
  const word = model.getWordAtPosition(position)?.word ?? '';
  if (!info.canRename) return { kind: 'symbol', oldName: word, declarations: [], usages: [], dynamic: [], script: true, error: info.localizedErrorMessage };
  const locations = ((await worker.findRenameLocations(fileName, offset, false, false, false)) ?? []) as Reference[];
  const definitions = await definitionsAt(worker, fileName, offset);
  const declarations: NameEdit[] = [];
  const usages: NameEdit[] = [];
  for (const l of locations) {
    if (/\/node_modules\//.test(l.fileName)) {
      return { kind: info.kind, oldName: info.displayName, declarations: [], usages: [], dynamic: [], script: true, error: 'It is declared in a package in node_modules.' };
    }
    const text = textOf(l.fileName);
    if (text === null) continue;
    const at = positionIn(text, l.textSpan.start);
    const edit = { path: uriToFilePath(l.fileName), line: at.line, column: at.column, endColumn: at.column + l.textSpan.length };
    (definitions.has(`${l.fileName}:${l.textSpan.start}`) ? declarations : usages).push(edit);
  }
  // On an import, say what the import names (a function, a class…).
  const kind = info.kind === 'alias' && definitions.kind ? definitions.kind : info.kind;
  return { kind: KIND_NAMES[kind] ?? kind, oldName: info.displayName, declarations, usages, dynamic: [], script: true };
}

const KIND_NAMES: Record<string, string> = {
  'local var': 'variable',
  var: 'variable',
  let: 'variable',
  const: 'constant',
  'local function': 'function',
  parameter: 'parameter',
  method: 'method',
  property: 'property',
  class: 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  alias: 'import',
};

/** A TypeScript service marker as a Problems entry. */
export function scriptProblem(path: string, m: monaco.editor.IMarker): Problem {
  return {
    path,
    line: m.startLineNumber,
    column: m.startColumn,
    endLine: m.endLineNumber,
    endColumn: m.endColumn,
    message: m.message,
    severity: m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info',
    code: m.code === undefined ? undefined : `TS${typeof m.code === 'string' ? m.code : m.code.value}`,
    source: SCRIPT_SOURCE,
  };
}

/** Problems from the TypeScript service; the editor shows its markers already. */
export const SCRIPT_SOURCE = 'TypeScript';

interface CodeFix {
  description: string;
  changes: { fileName: string; textChanges: { span: { start: number; length: number }; newText: string }[] }[];
}

/** Alt+Enter on a TypeScript error: its quick fixes (add the missing import, fix the spelling…). */
export async function scriptQuickFixes(model: monaco.editor.ITextModel, marker: monaco.editor.IMarker): Promise<{ title: string; run: () => void }[]> {
  const code = Number(typeof marker.code === 'object' ? marker.code.value : marker.code);
  if (!code) return [];
  const worker = await workerFor(model);
  const start = model.getOffsetAt({ lineNumber: marker.startLineNumber, column: marker.startColumn });
  const end = model.getOffsetAt({ lineNumber: marker.endLineNumber, column: marker.endColumn });
  const options = model.getOptions();
  const fixes = ((await worker.getCodeFixesAtPosition(model.uri.toString(), start, end, [code], { tabSize: options.tabSize, indentSize: options.indentSize, convertTabsToSpaces: options.insertSpaces })) ?? []) as CodeFix[];
  // Fixes are applied to editor documents: those that change a file that isn't open are left out.
  return fixes
    .filter((f) => f.changes.every((c) => monaco.editor.getModel(monaco.Uri.parse(c.fileName))))
    .map((f) => ({
      title: f.description,
      run: () => {
        for (const change of f.changes) {
          const target = monaco.editor.getModel(monaco.Uri.parse(change.fileName));
          if (!target) continue;
          const edits = change.textChanges.map((t) => ({
            range: monaco.Range.fromPositions(target.getPositionAt(t.span.start), target.getPositionAt(t.span.start + t.span.length)),
            text: t.newText,
          }));
          target.pushStackElement();
          target.pushEditOperations([], edits, () => null);
          target.pushStackElement();
        }
      },
    }));
}

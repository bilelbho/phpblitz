// Running PHPUnit and Pest: the whole suite, a file, a class, one test
// or the tests that failed, with the project's PHP interpreter (local, Docker, Compose, SSH) and
// optionally under the debugger. The runner reports with --teamcity, read as it streams, so the
// test tree (Run tool window) and the editor's gutter icons fill in while the tests run.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { runJob } from '../jobs';
import type { Backend } from '../backend/types';
import { isTauri } from '../platform';
import { commandFor, debugMappings, interpretersFor, mapPath, projectPhp, type Interpreter } from '../interpreters';
import { debug } from '../debug/manager';
import { TestTree, type TestNode, type TestStatus } from './teamcity';
import { findTests, phpunitFilter, pestFilter, type FoundTest } from './discover';

export type Framework = 'phpunit' | 'pest';

export type Scope =
  | { kind: 'all' }
  | { kind: 'file'; path: string }
  | { kind: 'test'; path: string; test: FoundTest }
  | { kind: 'node'; node: TestNode }
  | { kind: 'failed' };

export interface RunState {
  tree: TestTree;
  framework: Framework;
  label: string;
  scope: Scope;
  debug: boolean;
  running: boolean;
  started: number;
  finished: number | null;
  exitCode: number | null;
  /** The run couldn't start, or the runner crashed before reporting. */
  error?: string;
  /** The command line, shown at the top of the output. */
  command: string;
}

/** Result keys for the gutter: `path::Class` / `path::Class::method` (PHPUnit), `path::name` (Pest). */
export const resultKey = (path: string, className?: string, testName?: string) => [path, className?.replace(/^\\/, ''), testName].filter(Boolean).join('::');

class TestRunner {
  run: RunState | null = null;
  /** Last result per test and class, for the gutter icons; kept across runs. */
  results = new Map<string, TestStatus>();
  private backend: Backend | null = null;
  private job = 0;
  private stopped = false;
  private listeners = new Set<() => void>();
  private version = 0;
  private flushTimer = 0;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.version;
  private changed(now = true) {
    // Output arrives line by line: repaint at most every 50 ms while it streams.
    if (!now) {
      if (this.flushTimer) return;
      this.flushTimer = window.setTimeout(() => {
        this.flushTimer = 0;
        this.changed();
      }, 50);
      return;
    }
    this.version++;
    this.listeners.forEach((l) => l());
  }

  setProject(backend: Backend | null) {
    if (backend === this.backend) return;
    void this.stop();
    this.backend = backend;
    this.run = null;
    this.results.clear();
    this.changed();
  }

  get running() {
    return !!this.run?.running;
  }

  /** Which runner the project uses: Pest when it's installed, else PHPUnit. */
  async framework(): Promise<Framework | null> {
    const b = this.backend;
    if (!b) return null;
    if (b.kind === 'sample') return 'phpunit';
    const bin = await b.listDir(`${b.root}/vendor/bin`).catch(() => []);
    const names = new Set(bin.map((e) => e.name));
    return names.has('pest') ? 'pest' : names.has('phpunit') ? 'phpunit' : null;
  }

  /** What a scope is called in the Run window's tab and the gutter menu. */
  label(scope: Scope, framework: Framework): string {
    const runner = framework === 'pest' ? 'Pest' : 'PHPUnit';
    switch (scope.kind) {
      case 'all':
        return runner;
      case 'file':
        return scope.path.split('/').pop()!.replace(/\.php$/, '');
      case 'test':
        return scope.test.kind === 'class' ? scope.test.label : scope.test.kind === 'method' ? `${scope.test.className?.split('\\').pop()}::${scope.test.label}` : scope.test.label;
      case 'node':
        return scope.node.name;
      case 'failed':
        return `Failed tests (${runner})`;
    }
  }

  async start(scope: Scope, opts: { debug?: boolean } = {}) {
    const b = this.backend;
    if (!b) return;
    await this.stop();
    const framework = await this.framework();
    const tree = new TestTree((f) => f);
    const base = { tree, framework: framework ?? 'phpunit', scope, debug: !!opts.debug, running: true, started: Date.now(), finished: null, exitCode: null, command: '' } as const;
    if (!framework) {
      this.run = { ...base, label: 'PHPUnit', running: false, finished: Date.now(), error: 'Neither PHPUnit nor Pest is installed in vendor/bin. Add one with Composer: composer require --dev phpunit/phpunit' };
      this.changed();
      return;
    }
    const failedBefore = scope.kind === 'failed' ? this.failedTests() : [];
    const label = this.label(scope, framework);
    this.run = { ...base, label };
    this.stopped = false;
    this.changed();

    if (b.kind === 'sample' || !isTauri) return this.simulate(scope);

    // The interpreter the project uses; plain `php` from PATH when none is set.
    const php = projectPhp(b.root);
    const interpreter: Interpreter = interpretersFor(b.root).find((i) => i.id === php.interpreterId) ?? { id: 'path', name: 'php', kind: 'local', phpPath: 'php', debuggerExtension: '', options: [] };
    const mappings = await debugMappings(interpreter, b.root);
    const where = (rel: string) => (interpreter.kind === 'ssh' ? mapPath(`${b.root}/${rel}`, mappings, true) : rel);
    const rel = (path: string) => (path.startsWith(`${b.root}/`) ? path.slice(b.root.length + 1) : path);

    const args = [where(`vendor/bin/${framework}`), '--teamcity', '--colors=never', ...this.scopeArgs(scope, framework, failedBefore).map((a) => (a.startsWith(`${b.root}/`) ? where(rel(a)) : a))];
    let debugPort: number | null = null;
    if (opts.debug) {
      debugPort = await debug.prepareLaunch(label);
      if (debugPort === null) {
        this.finish(null, 'The debugger could not listen for Xdebug (see Settings ▸ PHP ▸ Debug).');
        return;
      }
    }
    const cmd = commandFor(interpreter, args, { root: b.root, debug: debugPort ? { port: debugPort } : undefined });
    this.run.command = [cmd.program, ...cmd.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    // Paths the runner reports: on the container / server, relative (Pest), or local.
    const toLocal = (file: string) => {
      const f = file.replace(/\\/g, '/');
      if (/^([A-Za-z]:)?\//.test(f)) return mappings.length ? mapPath(f, mappings, false) : f;
      return `${b.root}/${f}`;
    };
    this.run.tree = new TestTree(toLocal);

    const id = Date.now() % 1_000_000_000;
    this.job = id;
    const run = this.run;
    try {
      const code = await runJob('job_exec', { id, cwd: b.root, program: cmd.program, args: cmd.args }, (line) => {
        run.tree.line(line.replace(ANSI, ''));
        this.changed(false);
      });
      this.finish(this.stopped ? null : code);
    } catch (e) {
      this.finish(null, String(e instanceof Error ? e.message : e));
    } finally {
      this.job = 0;
    }
  }

  /** Arguments that pick the tests of a scope. */
  private scopeArgs(scope: Scope, framework: Framework, failed: TestNode[]): string[] {
    switch (scope.kind) {
      case 'all':
        return [];
      case 'file':
        return [scope.path];
      case 'test': {
        const t = scope.test;
        if (t.kind === 'class') return [scope.path];
        if (t.kind === 'method') return ['--filter', phpunitFilter([{ className: t.className!, name: t.testName! }]), scope.path];
        return ['--filter', pestFilter([t.testName!]), scope.path];
      }
      case 'node':
        return nodeArgs(scope.node, framework);
      case 'failed': {
        if (!failed.length) return [];
        if (framework === 'pest') return ['--filter', pestFilter(failed.map((t) => t.testName ?? t.name))];
        return ['--filter', phpunitFilter(failed.map((t) => ({ className: t.className ?? '', name: t.name, exact: true })))];
      }
    }
  }

  private finish(exitCode: number | null, error?: string) {
    const run = this.run;
    if (!run) return;
    run.tree.finish(exitCode);
    run.running = false;
    run.finished = Date.now();
    run.exitCode = exitCode;
    // Exit codes 0–2 are test results; anything else with no tests reported is a crash.
    if (error) run.error = error;
    else if (exitCode !== null && exitCode > 2 && !run.tree.tests().length) run.error = `The test runner exited with code ${exitCode} before running tests. See the output.`;
    else if (exitCode !== null && !run.tree.tests().length && run.tree.root.output.trim() && exitCode !== 0) run.error = 'No tests ran. See the output.';
    this.recordResults(run.tree);
    this.changed();
  }

  /** Gutter results from a run: data sets and classes take the worst of their tests. */
  private recordResults(tree: TestTree) {
    const rank: Record<TestStatus, number> = { error: 5, failed: 4, running: 3, pending: 2, passed: 1, ignored: 0 };
    const fresh = new Map<string, TestStatus>();
    const put = (key: string, status: TestStatus) => {
      const prev = fresh.get(key);
      if (!prev || rank[status] > rank[prev]) fresh.set(key, status);
    };
    const walk = (n: TestNode) => {
      n.children.forEach(walk);
      if (!n.path) return;
      if (n.kind === 'test') put(resultKey(n.path, n.className, n.testName), n.status);
      else if (n.kind === 'class') put(resultKey(n.path, n.className), n.status);
    };
    walk(tree.root);
    for (const [key, status] of fresh) this.results.set(key, status);
  }

  /** Failed tests of the last run. */
  failedTests(): TestNode[] {
    return this.run?.tree.tests().filter((t) => t.status === 'failed' || t.status === 'error') ?? [];
  }

  async stop() {
    if (!this.run?.running) return;
    this.stopped = true;
    if (this.job) await invoke('job_kill', { id: this.job }).catch(() => {});
    else this.finish(null);
  }

  rerun() {
    if (this.run) void this.start(this.run.scope, { debug: this.run.debug });
  }

  /** The browser preview's sample project: a believable run of its test files. */
  private async simulate(scope: Scope) {
    const b = this.backend!;
    const files = (await b.listFiles()).filter((f) => /\/tests\/.*Test\.php$/.test(f) && (scope.kind !== 'file' && scope.kind !== 'test' ? true : f === scope.path));
    const tree = new TestTree((f) => f);
    this.run!.tree = tree;
    this.run!.command = 'php vendor/bin/phpunit --teamcity (sample project: simulated)';
    const esc = (s: string) => s.replace(/[|'[\]]/g, '|$&').replace(/\n/g, '|n');
    const lines: string[] = [];
    for (const f of files) {
      const found = findTests(await b.readFile(f));
      const cls = found.find((t) => t.kind === 'class');
      if (!cls) continue;
      const hint = (m?: string) => `php_qn://${f}::\\${cls.className}${m ? `::${m}` : ''}`;
      lines.push(`##teamcity[testSuiteStarted name='${esc(cls.className!)}' locationHint='${esc(hint())}']`);
      for (const t of found.filter((x) => x.kind === 'method')) {
        if (scope.kind === 'test' && scope.test.kind === 'method' && scope.test.testName !== t.testName) continue;
        lines.push(`##teamcity[testStarted name='${esc(t.testName!)}' locationHint='${esc(hint(t.testName))}']`);
        if (/reject/i.test(t.testName!)) {
          lines.push(`##teamcity[testFailed name='${esc(t.testName!)}' message='${esc('Expected response status code [422] but received 201.')}' details='${esc(`${f}:${t.line + 4}\n`)}' type='comparisonFailure' expected='422' actual='201']`);
        }
        lines.push(`##teamcity[testFinished name='${esc(t.testName!)}' duration='${12 + (t.line % 30)}']`);
      }
      lines.push(`##teamcity[testSuiteFinished name='${esc(cls.className!)}']`);
    }
    for (const l of lines) {
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, 120));
      tree.line(l);
      this.changed();
    }
    const failed = tree.tests().some((t) => t.status === 'failed');
    this.finish(this.stopped ? null : failed ? 1 : 0);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Rerunning a node of the tree: its test, data-set suite, class or file. */
function nodeArgs(node: TestNode, framework: Framework): string[] {
  if (node.kind === 'root') return [];
  if (node.kind === 'class' || node.kind === 'file') return node.path ? [node.path] : [];
  const name = node.testName ?? node.name;
  if (framework === 'pest') return ['--filter', pestFilter([name]), ...(node.path ? [node.path] : [])];
  const exact = node.kind === 'test' && node.parent?.kind === 'suite';
  return ['--filter', phpunitFilter([{ className: node.className ?? '', name: exact ? node.name : name, exact }]), ...(node.path ? [node.path] : [])];
}

export const testRunner = new TestRunner();

export function useTestRunner() {
  useSyncExternalStore(testRunner.subscribe, testRunner.getSnapshot);
  return testRunner;
}


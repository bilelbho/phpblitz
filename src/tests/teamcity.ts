// PHPUnit's and Pest's `--teamcity` output: service messages, one per line, as the run goes:
//   ##teamcity[testStarted name='testAdds' locationHint='php_qn://C:\app\tests\CalcTest.php::\Tests\CalcTest::testAdds' flowId='1']
// Values escape | ' [ ] and line breaks with a leading |. Other lines are the tests' own output.

export interface ServiceMessage {
  name: string;
  attrs: Record<string, string>;
}

const UNESCAPE: Record<string, string> = { n: '\n', r: '\r', "'": "'", '|': '|', '[': '[', ']': ']' };

export function unescapeValue(v: string): string {
  return v.replace(/\|(0x[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c.startsWith('0x') ? String.fromCharCode(parseInt(c.slice(2), 16)) : (UNESCAPE[c] ?? c)));
}

/** A `##teamcity[...]` line, or null for ordinary output. */
export function parseServiceMessage(line: string): ServiceMessage | null {
  const start = line.indexOf('##teamcity[');
  if (start < 0) return null;
  const body = line.slice(start + 11).replace(/\]\s*$/, '');
  const m = /^(\w+)/.exec(body);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  const re = /(\w+)='((?:[^'|]|\|.)*)'/g;
  for (let a = re.exec(body); a; a = re.exec(body)) attrs[a[1]] = unescapeValue(a[2]);
  return { name: m[1], attrs };
}

export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'ignored';

export interface TestNode {
  /** Unique in the run: the location hint, or the parent's id and the name. */
  id: string;
  name: string;
  kind: 'root' | 'suite' | 'file' | 'class' | 'test';
  status: TestStatus;
  /** ms, when finished. */
  duration?: number;
  /** Where it is (absolute local path) and its line, when known. */
  path?: string;
  line?: number;
  /** PHPUnit: \Namespace\Class for classes and methods. */
  className?: string;
  /** PHPUnit method or Pest description, without the data set. */
  testName?: string;
  message?: string;
  details?: string;
  expected?: string;
  actual?: string;
  /** What the test printed. */
  output: string;
  children: TestNode[];
  parent?: TestNode;
}

export interface Location {
  /** Path as the runner reports it (may be relative or on the container). */
  file: string;
  className?: string;
  testName?: string;
}

/**
 * `php_qn://C:\app\tests\CalcTest.php::\Tests\CalcTest::testAdds with data set "x"` or
 * `pest_qn://tests\Unit\CalcTest.php::it adds`.
 */
export function parseLocation(hint: string | undefined): Location | null {
  if (!hint) return null;
  const m = /^(php|pest)_qn:\/\/(.*)$/.exec(hint);
  if (!m) return null;
  // The file ends at the first "::" after its .php extension.
  const rest = m[2];
  const at = rest.search(/\.php::/i);
  const file = (at < 0 ? rest : rest.slice(0, at + 4)).replace(/\\/g, '/');
  if (at < 0) return { file };
  const parts = rest.slice(at + 6);
  if (m[1] === 'pest') return { file, testName: stripDataSet(parts) };
  const [cls, method] = splitOnce(parts, '::');
  return { file, className: cls, testName: method ? stripDataSet(method) : undefined };
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + sep.length)];
}

export const stripDataSet = (name: string) => name.replace(/ with data set .*$/s, '');

/** Builds the result tree from service messages; `toLocal` maps reported paths to project files. */
export class TestTree {
  root: TestNode = { id: 'root', name: 'Test Results', kind: 'root', status: 'running', output: '', children: [] };
  /** Expected number of tests (testCount). */
  total = 0;
  private stack: TestNode[] = [this.root];
  private current: TestNode | null = null;
  private byId = new Map<string, TestNode>();

  constructor(readonly toLocal: (file: string) => string) {}

  private top() {
    return this.stack[this.stack.length - 1];
  }

  private add(parent: TestNode, node: Omit<TestNode, 'children' | 'output' | 'parent'>): TestNode {
    let id = node.id;
    for (let n = 2; this.byId.has(id); n++) id = `${node.id}#${n}`;
    const full: TestNode = { ...node, id, children: [], output: '', parent };
    parent.children.push(full);
    this.byId.set(id, full);
    return full;
  }

  /** Feeds one line of the run's output. */
  line(text: string) {
    const msg = parseServiceMessage(text);
    if (!msg) {
      // Output printed while a test runs belongs to it; the rest to the whole run.
      (this.current ?? this.root).output += text.endsWith('\n') ? text : `${text}\n`;
      if (this.current) this.root.output += text.endsWith('\n') ? text : `${text}\n`;
      return;
    }
    const a = msg.attrs;
    switch (msg.name) {
      case 'testCount':
        this.total += Number(a.count) || 0;
        break;
      case 'testSuiteStarted': {
        const loc = parseLocation(a.locationHint);
        const parent = this.top();
        // The configuration file and the <testsuite> only wrap everything: the tree starts at the
        // classes (PHPUnit) and files (Pest).
        const wrapper = !loc || (!loc.className && !loc.testName && (/\.xml(\.dist)?$/.test(a.name) || !/[\\/]/.test(a.name)));
        if (wrapper) {
          this.stack.push(parent);
          break;
        }
        const path = loc ? this.toLocal(loc.file) : undefined;
        const kind: TestNode['kind'] = loc?.testName ? 'suite' : loc?.className ? 'class' : 'file';
        const node = this.add(parent, { id: a.locationHint || `${parent.id}/${a.name}`, name: displayName(a.name, kind), kind, status: 'running', path, className: loc?.className, testName: loc?.testName });
        this.stack.push(node);
        break;
      }
      case 'testSuiteFinished': {
        const node = this.stack.pop();
        if (node && node !== this.root && this.stack.indexOf(node) < 0) finishSuite(node);
        break;
      }
      case 'testStarted': {
        const loc = parseLocation(a.locationHint);
        const parent = this.top();
        this.current = this.add(parent, {
          id: a.locationHint || `${parent.id}/${a.name}`,
          name: a.name,
          kind: 'test',
          status: 'running',
          path: loc ? this.toLocal(loc.file) : parent.path,
          className: loc?.className ?? parent.className,
          testName: loc?.testName ?? stripDataSet(a.name),
        });
        break;
      }
      case 'testFailed': {
        const node = this.current ?? this.find(a.name);
        if (!node) break;
        node.status = /^[\w\\]*(Error|Exception)\b[^:]*:/.test(a.message ?? '') && a.type !== 'comparisonFailure' ? 'error' : 'failed';
        node.message = a.message;
        node.details = a.details;
        if (a.type === 'comparisonFailure') {
          node.expected = a.expected;
          node.actual = a.actual;
        }
        break;
      }
      case 'testIgnored': {
        const node = this.current ?? this.find(a.name);
        if (!node) break;
        node.status = 'ignored';
        node.message = a.message;
        break;
      }
      case 'testStdOut':
      case 'testStdErr': {
        const node = this.current ?? this.find(a.name);
        if (node) node.output += a.out ?? '';
        break;
      }
      case 'testFinished': {
        const node = this.current ?? this.find(a.name);
        if (node) {
          if (node.status === 'running') node.status = 'passed';
          node.duration = Number(a.duration) || 0;
        }
        this.current = null;
        break;
      }
    }
  }

  private find(name: string): TestNode | undefined {
    const top = this.top();
    return [...top.children].reverse().find((c) => c.kind === 'test' && c.name === name);
  }

  /** The run ended (normally or not): whatever still runs is settled. */
  finish(exitCode: number | null) {
    const settle = (n: TestNode) => {
      n.children.forEach(settle);
      if (n.kind === 'test' && n.status === 'running') n.status = exitCode === null ? 'ignored' : 'error';
      if (n.kind !== 'test') finishSuite(n);
    };
    settle(this.root);
    this.current = null;
  }

  tests(): TestNode[] {
    const out: TestNode[] = [];
    const walk = (n: TestNode) => (n.kind === 'test' ? out.push(n) : n.children.forEach(walk));
    walk(this.root);
    return out;
  }
}

function displayName(name: string, kind: TestNode['kind']): string {
  if (kind === 'class' || kind === 'file') return name.split(/[\\/]/).pop() ?? name;
  return name;
}

/** A suite's status and time from its children. */
export function finishSuite(n: TestNode) {
  const kids = n.children;
  if (!kids.length) {
    if (n.status === 'running') n.status = 'passed';
    return;
  }
  const has = (s: TestStatus) => kids.some((k) => k.status === s);
  n.status = has('error') ? 'error' : has('failed') ? 'failed' : has('running') ? 'running' : kids.every((k) => k.status === 'ignored') ? 'ignored' : 'passed';
  n.duration = kids.reduce((t, k) => t + (k.duration ?? 0), 0);
}

/** `file:line` references in failure details and stack traces. */
export function stackLocations(details: string): { text: string; file: string; line: number }[] {
  const out: { text: string; file: string; line: number }[] = [];
  for (const raw of details.split('\n')) {
    const m = /^(?:at\s+)?((?:[A-Za-z]:)?[^:]*\.php):(\d+)\s*$/.exec(raw.trim());
    if (m) out.push({ text: raw.trim(), file: m[1].replace(/\\/g, '/'), line: Number(m[2]) });
  }
  return out;
}

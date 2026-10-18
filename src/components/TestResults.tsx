// The Run tool window's test results: the toolbar (rerun, rerun failed, stop,
// filters), the status line with a progress bar, the result tree and, beside it, the selected
// test's failure (message, expected / actual, stack trace with links) and output.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { useTestRunner, type RunState } from '../tests/runner';
import { stackLocations, type TestNode, type TestStatus } from '../tests/teamcity';
import { findTests } from '../tests/discover';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';

const STATUS_ICON: Record<TestStatus, { icon: IconName; className: string }> = {
  passed: { icon: 'check', className: 'tr-passed' },
  failed: { icon: 'close', className: 'tr-failed' },
  error: { icon: 'close', className: 'tr-error' },
  ignored: { icon: 'minus', className: 'tr-ignored' },
  running: { icon: 'refresh', className: 'tr-running' },
  pending: { icon: 'minus', className: 'tr-ignored' },
};

const ms = (n?: number) => (n === undefined ? '' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);

/** "Tests failed: 2, passed: 5, ignored: 1 of 8 tests – 120 ms" */
function summary(run: RunState): { text: string; tone: 'ok' | 'bad' | 'neutral' } {
  const tests = run.tree.tests();
  const count = (s: TestStatus[]) => tests.filter((t) => s.includes(t.status)).length;
  const failed = count(['failed', 'error']);
  const passed = count(['passed']);
  const ignored = count(['ignored']);
  const total = Math.max(run.tree.total, tests.length);
  const time = ms(run.tree.root.duration ?? tests.reduce((t, x) => t + (x.duration ?? 0), 0));
  if (run.error && !tests.length) return { text: run.error, tone: 'bad' };
  if (run.running) return { text: `Running: ${tests.length - count(['running'])} of ${total || '?'} tests${failed ? `, ${failed} failed` : ''}`, tone: failed ? 'bad' : 'neutral' };
  if (run.exitCode === null) return { text: `Stopped. ${failed ? `Tests failed: ${failed}, ` : ''}passed: ${passed} of ${total} tests`, tone: failed ? 'bad' : 'neutral' };
  const extra = ignored ? `, ignored: ${ignored}` : '';
  if (failed) return { text: `Tests failed: ${failed}, passed: ${passed}${extra} of ${total} tests – ${time}`, tone: 'bad' };
  if (!tests.length) return { text: 'No tests were found', tone: 'neutral' };
  return { text: `Tests passed: ${passed}${extra} of ${total} tests – ${time}`, tone: 'ok' };
}

export function TestResults({ ws }: { ws: Workspace }) {
  const runner = useTestRunner();
  const run = runner.run;
  const [showPassed, setShowPassed] = useState(true);
  const [showIgnored, setShowIgnored] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>('root');
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const treeBox = useRef<HTMLDivElement>(null);

  // A new run: select the root, then the first failure as soon as there is one.
  const runStarted = run?.started;
  useEffect(() => setSelected('root'), [runStarted]);
  const firstFailure = run?.tree.tests().find((t) => t.status === 'failed' || t.status === 'error');
  const autoSelected = useRef(false);
  useEffect(() => {
    autoSelected.current = false;
  }, [runStarted]);
  useEffect(() => {
    if (firstFailure && !autoSelected.current && run && !run.running) {
      autoSelected.current = true;
      setSelected(firstFailure.id);
    }
  }, [firstFailure, run, run?.running]);

  const visible = (n: TestNode): boolean => {
    if (n.kind !== 'test') return n.children.some(visible) || (n.kind === 'root' ? true : n.status === 'running');
    if (n.status === 'passed') return showPassed;
    if (n.status === 'ignored') return showIgnored;
    return true;
  };

  // Rows: the tree flattened, collapsed nodes' children left out.
  const rows = useMemo(() => {
    const out: { node: TestNode; depth: number }[] = [];
    if (!run) return out;
    const walk = (n: TestNode, depth: number) => {
      if (n.kind !== 'root' && !visible(n)) return;
      out.push({ node: n, depth });
      if (!collapsed.has(n.id)) n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(run.tree.root, 0);
    return out;
    // The tree mutates in place; the runner's version re-renders this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, runner.getSnapshot(), collapsed, showPassed, showIgnored]);

  const node = rows.find((r) => r.node.id === selected)?.node ?? run?.tree.root;

  /** The source line of a test, class or file node. */
  const jumpTo = async (n: TestNode) => {
    if (!n.path) return;
    const text = ws.liveTextOf(n.path) ?? (await ws.backend.readFile(n.path).catch(() => ''));
    const found = findTests(text);
    const target =
      n.kind === 'class'
        ? found.find((t) => t.kind === 'class')
        : found.find((t) => t.testName === n.testName && (t.kind === 'pest' || t.className === n.className?.replace(/^\\/, '')));
    void ws.openFile(n.path, target ? { line: target.line } : undefined);
  };

  const nodeMenu = (n: TestNode, x: number, y: number) => {
    const label = n.kind === 'root' ? (run?.label ?? 'tests') : n.name;
    setMenu({
      x,
      y,
      items: [
        { label: `Run '${label}'`, icon: 'run', shortcut: 'Ctrl+Shift+F10', run: () => void runner.start(n.kind === 'root' ? (run?.scope ?? { kind: 'all' }) : { kind: 'node', node: n }) },
        { label: `Debug '${label}'`, icon: 'bug', run: () => void runner.start(n.kind === 'root' ? (run?.scope ?? { kind: 'all' }) : { kind: 'node', node: n }, { debug: true }) },
        { kind: 'sep' },
        { label: 'Jump to Source', shortcut: 'F4', disabled: !n.path, run: () => void jumpTo(n) },
      ],
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.node.id === selected);
    if (e.key === 'ArrowDown' && i < rows.length - 1) setSelected(rows[i + 1].node.id);
    else if (e.key === 'ArrowUp' && i > 0) setSelected(rows[i - 1].node.id);
    else if (e.key === 'ArrowRight' && node && collapsed.has(node.id)) toggle(node.id);
    else if (e.key === 'ArrowLeft' && node && node.children.length && !collapsed.has(node.id)) toggle(node.id);
    else if ((e.key === 'Enter' || e.key === 'F4') && node) void jumpTo(node);
    else return;
    e.preventDefault();
  };
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    treeBox.current?.querySelector('.tr-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const failedCount = runner.failedTests().length;
  const status = run ? summary(run) : null;
  const total = run ? Math.max(run.tree.total, run.tree.tests().length) : 0;
  const done = run ? run.tree.tests().filter((t) => t.status !== 'running').length : 0;

  return (
    <div className="test-results">
      <div className="tr-toolbar" role="toolbar" aria-label="Test runner">
        <ToolButton icon="run" label={run ? `Rerun '${run.label}'` : 'Run Tests'} keys="Shift+F10" color="#5fb865" disabled={!!run?.running} onClick={() => (run ? runner.rerun() : void runner.start({ kind: 'all' }))} />
        <ToolButton icon="refresh" label="Rerun Failed Tests" color="#db5c5c" disabled={!!run?.running || !failedCount} onClick={() => void runner.start({ kind: 'failed' })} />
        <ToolButton icon="bug" label={run ? `Debug '${run.label}'` : 'Debug Tests'} color="#5fb865" disabled={!!run?.running} onClick={() => void runner.start(run?.scope ?? { kind: 'all' }, { debug: true })} />
        <ToolButton icon="stopSquare" label="Stop" keys="Ctrl+F2" color="#db5c5c" disabled={!run?.running} onClick={() => void runner.stop()} />
        <span className="strip-sep" />
        <ToolButton icon="check" label="Show Passed" pressed={showPassed} onClick={() => setShowPassed(!showPassed)} />
        <ToolButton icon="minus" label="Show Ignored" pressed={showIgnored} onClick={() => setShowIgnored(!showIgnored)} />
        <span className="strip-sep" />
        <ToolButton icon="expandAll" label="Expand All" onClick={() => setCollapsed(new Set())} />
        <ToolButton icon="collapseAll" label="Collapse All" onClick={() => setCollapsed(new Set(rows.filter((r) => r.node.kind !== 'test' && r.node.kind !== 'root').map((r) => r.node.id)))} />
        {status && (
          <span className={`tr-status ${status.tone}`} title={status.text}>
            {status.tone === 'ok' && <Icon name="check" size={13} />}
            {status.tone === 'bad' && <Icon name="warning" size={13} />}
            {status.text}
          </span>
        )}
      </div>
      {run && (
        <div className={'tr-progress' + (failedCount ? ' bad' : '') + (run.running ? ' running' : '')}>
          <span style={{ width: total ? `${Math.min(100, (done / total) * 100)}%` : run.running ? '30%' : '100%' }} />
        </div>
      )}
      {!run ? (
        <div className="empty tr-empty">
          No test results yet. Run tests with ▶ above, the gutter icons beside a test, or Ctrl+Shift+F10 in a test file.
        </div>
      ) : (
        <div className="tr-body">
          <div className="tr-tree" ref={treeBox} tabIndex={0} role="tree" aria-label="Test results" onKeyDown={onKey}>
            {rows.map(({ node: n, depth }) => {
              const icon = n.kind === 'root' && run.running ? STATUS_ICON.running : STATUS_ICON[n.status];
              const hasKids = n.children.length > 0;
              return (
                <div
                  key={n.id}
                  role="treeitem"
                  aria-selected={n.id === selected}
                  aria-expanded={hasKids ? !collapsed.has(n.id) : undefined}
                  className={'tr-row' + (n.id === selected ? ' selected' : '')}
                  style={{ paddingLeft: 6 + depth * 16 }}
                  onClick={() => setSelected(n.id)}
                  onDoubleClick={() => (hasKids && n.kind === 'root' ? toggle(n.id) : void jumpTo(n))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelected(n.id);
                    nodeMenu(n, e.clientX, e.clientY);
                  }}
                >
                  <span
                    className="tr-twisty"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (hasKids) toggle(n.id);
                    }}
                  >
                    {hasKids && <Icon name={collapsed.has(n.id) ? 'chevronRight' : 'chevronDown'} size={12} />}
                  </span>
                  <span className={`tr-icon ${icon.className}`}>
                    <Icon name={icon.icon} size={13} />
                  </span>
                  <span className="tr-name">{n.kind === 'root' ? (run.running ? `${run.label}` : 'Test Results') : n.name}</span>
                  <span className="tr-time">{ms(n.kind === 'root' ? (n.duration ?? undefined) : n.duration)}</span>
                </div>
              );
            })}
          </div>
          <Details ws={ws} run={run} node={node ?? run.tree.root} />
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Details({ ws, run, node }: { ws: Workspace; run: RunState; node: TestNode }) {
  const box = useRef<HTMLDivElement>(null);
  const isRoot = node.kind === 'root';
  // The whole run's output follows the end while it streams.
  useEffect(() => {
    if (isRoot && run.running && box.current) box.current.scrollTop = box.current.scrollHeight;
  });
  const failures = isRoot ? [] : node.kind === 'test' ? [node] : collect(node).filter((t) => t.status === 'failed' || t.status === 'error');
  const open = (file: string, line: number) => void ws.openFile(run.tree.toLocal(file), { line });
  return (
    <div className="tr-details mono" ref={box}>
      {isRoot && <div className="tr-command">{run.command}</div>}
      {isRoot && run.error && <div className="tr-fail-message">{run.error}</div>}
      {failures.map((t) => (
        <div key={t.id} className="tr-failure">
          {failures.length > 1 && <div className="tr-failure-name">{t.name}</div>}
          {t.message && <div className={t.status === 'ignored' ? 'muted' : 'tr-fail-message'}>{t.message}</div>}
          {t.expected !== undefined && (
            <div className="tr-diff">
              <div>
                <div className="tr-diff-label">Expected</div>
                <pre className="tr-expected">{t.expected}</pre>
              </div>
              <div>
                <div className="tr-diff-label">Actual</div>
                <pre className="tr-actual">{t.actual}</pre>
              </div>
            </div>
          )}
          {t.details && (
            <div className="tr-stack">
              {t.details.split('\n').map((line, i) => {
                const loc = stackLocations(line)[0];
                return loc ? (
                  <div key={i}>
                    <button type="button" className="link-btn" onClick={() => open(loc.file, loc.line)}>
                      {line.trim()}
                    </button>
                  </div>
                ) : line.trim() ? (
                  <div key={i}>{line}</div>
                ) : null;
              })}
            </div>
          )}
        </div>
      ))}
      {node.kind === 'test' && node.status === 'passed' && !node.output && <div className="muted">Test passed{node.duration !== undefined ? ` in ${ms(node.duration)}` : ''}.</div>}
      {(isRoot || node.kind === 'test') && node.output && <pre className="tr-output">{node.output}</pre>}
      {isRoot && !node.output && !run.error && run.running && <div className="muted">Waiting for output…</div>}
    </div>
  );
}

function collect(n: TestNode): TestNode[] {
  return n.kind === 'test' ? [n] : n.children.flatMap(collect);
}

function ToolButton({ icon, label, keys, color, disabled, pressed, onClick }: { icon: IconName; label: string; keys?: string; color?: string; disabled?: boolean; pressed?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={'icon-btn small debug-tool' + (pressed ? ' pressed' : '')}
      aria-label={label}
      aria-pressed={pressed}
      title={keys ? `${label} (${keys})` : label}
      disabled={disabled}
      style={{ color: disabled ? undefined : color }}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

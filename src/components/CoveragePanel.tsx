// Coverage tool window: the last coverage run's files and folders, with the share of their lines
// and methods the tests ran. Click a file to open it (its lines are marked in the editor).

import { useMemo, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { coverageTree, percent, useCoverage, type CoverageNode } from '../tests/coverage';
import { useTestRunner } from '../tests/runner';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

const ratio = (covered: number, total: number) => (total ? covered / total : 1);
/** Green from 80 %, amber from 50 %, red below. */
const tone = (r: number) => (r >= 0.8 ? 'good' : r >= 0.5 ? 'fair' : 'poor');

export function CoveragePanel({ ws }: { ws: Workspace }) {
  const cov = useCoverage();
  const runner = useTestRunner();
  const report = cov.report;
  const tree = useMemo(() => (report ? coverageTree(report.files.values(), ws.backend.root) : null), [report, ws.backend.root]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  const rerun = () => {
    ws.showBottom('tests');
    void runner.start(runner.run?.coverage ? runner.run.scope : { kind: 'all' }, { coverage: true });
  };

  const rows: { node: CoverageNode; depth: number }[] = [];
  const q = filter.trim().toLowerCase();
  const walk = (n: CoverageNode, depth: number) => {
    for (const c of n.children) {
      if (q && !c.file && !hasMatch(c, q)) continue;
      if (q && c.file && !c.name.toLowerCase().includes(q)) continue;
      rows.push({ node: c, depth });
      if (!c.file && (q || !collapsed.has(c.path))) walk(c, depth + 1);
    }
  };
  if (tree) walk(tree, 0);

  const toggle = (path: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="cov-panel">
      <div className="tr-toolbar" role="toolbar" aria-label="Coverage">
        <button type="button" className="icon-btn small" title={runner.run?.coverage ? `Rerun '${runner.run.label}' with Coverage` : 'Run All Tests with Coverage'} aria-label="Run with Coverage" disabled={runner.running} onClick={rerun} style={{ color: runner.running ? undefined : '#5fb865' }}>
          <Icon name="run" size={15} />
        </button>
        <button
          type="button"
          className={'icon-btn small' + (cov.shown ? ' pressed' : '')}
          aria-pressed={cov.shown}
          title="Show Covered Lines in the Editor"
          aria-label="Show covered lines in the editor"
          disabled={!report}
          onClick={() => cov.show(!cov.shown)}
        >
          <Icon name="eye" size={15} />
        </button>
        <button type="button" className="icon-btn small" title="Collapse All" aria-label="Collapse all" disabled={!tree} onClick={() => setCollapsed(new Set(rows.filter((r) => !r.node.file).map((r) => r.node.path)))}>
          <Icon name="collapseAll" size={15} />
        </button>
        <button type="button" className="icon-btn small" title="Close the Report" aria-label="Close the report" disabled={!report} onClick={() => cov.set(null)}>
          <Icon name="close" size={14} />
        </button>
        {runner.running && runner.run?.coverage && <span className="muted cov-running">Measuring…</span>}
      </div>
      {cov.problem && (
        <div className="te-error cov-problem">
          <b>{cov.problem.label}:</b> {cov.problem.message}
        </div>
      )}
      {!report || !tree ? (
        <div className="empty">
          No coverage yet
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Run tests with coverage: the ▶ menu beside a test, or Run ▸ Run All Tests with Coverage. PHP needs Xdebug or PCOV.
          </div>
          <button type="button" className="btn small" style={{ marginTop: 10 }} disabled={runner.running} onClick={rerun}>
            Run All Tests with Coverage
          </button>
        </div>
      ) : (
        <>
          <div className="cov-summary">
            <Bar covered={tree.coveredStatements} total={tree.statements} />
            <span>
              <b>{percent(tree.coveredStatements, tree.statements)}</b> of lines ({tree.coveredStatements}/{tree.statements}) · <b>{percent(tree.coveredMethods, tree.methods)}</b> of methods
            </span>
            <span className="muted" title={new Date(report.at).toLocaleString()}>
              {report.label}, {new Date(report.at).toLocaleTimeString()}
            </span>
          </div>
          <div style={{ padding: '0 10px 6px' }}>
            <div className="field">
              <Icon name="search" size={13} />
              <input aria-label="Filter files" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          </div>
          <div className="cov-head" aria-hidden>
            <span>Element</span>
            <span>Lines</span>
            <span>Methods</span>
          </div>
          <div className="panel-body cov-list" role="tree" aria-label="Coverage by file">
            {rows.map(({ node, depth }) => {
              const open = !collapsed.has(node.path) || !!q;
              return (
                <div
                  key={node.path}
                  role="treeitem"
                  aria-expanded={node.file ? undefined : open}
                  className="cov-row"
                  style={{ paddingLeft: 8 + depth * 14 }}
                  title={node.path}
                  onClick={() => (node.file ? void ws.openFile(node.path) : toggle(node.path))}
                >
                  <span className="cov-name">
                    {node.file ? <span className="cov-twisty" /> : <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
                    {node.file ? <FileIcon path={node.path} size={14} /> : <Icon name={open ? 'folderOpen' : 'folder'} size={14} />}
                    <span className="cov-label">{node.name}</span>
                  </span>
                  <span className="cov-cell">
                    <Bar covered={node.coveredStatements} total={node.statements} />
                    <span className={'cov-pct ' + tone(ratio(node.coveredStatements, node.statements))}>{percent(node.coveredStatements, node.statements)}</span>
                  </span>
                  <span className="cov-cell muted" title={`${node.coveredMethods} of ${node.methods} methods`}>
                    {percent(node.coveredMethods, node.methods)}
                  </span>
                </div>
              );
            })}
            {!rows.length && <div className="empty">{q ? 'No file matches' : 'The report has no files'}</div>}
          </div>
        </>
      )}
    </div>
  );
}

const hasMatch = (n: CoverageNode, q: string): boolean => n.children.some((c) => (c.file ? c.name.toLowerCase().includes(q) : hasMatch(c, q)));

function Bar({ covered, total }: { covered: number; total: number }) {
  const r = ratio(covered, total);
  return (
    <span className="cov-bar" aria-hidden>
      <span className={tone(r)} style={{ width: `${Math.round(r * 100)}%` }} />
    </span>
  );
}

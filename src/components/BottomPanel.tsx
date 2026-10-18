import { FileIcon } from './FileIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualRows } from './useVirtualRows';
import { toolOfTab, type BottomTab, type Workspace } from '../useWorkspace';
import { baseName, relativePath, type Problem } from '../backend/types';
import { Icon } from './Icon';
import { FindResults } from './FindInFiles';
import { DebugPanel, GitToolWindow, TerminalView, TodoToolWindow } from './lazy';
import { isTauri } from '../platform';
import { useHideTool } from './toolHide';
import { TestResults } from './TestResults';
import { useTestRunner } from '../tests/runner';

const SEVERITY_COLOR = { error: 'var(--red)', warning: 'var(--orange)', info: 'var(--muted)' } as const;

/**
 * The bottom tool windows. In the bottom panel it shows the current tab (tab); with `tab`,
 * that tool window alone, for a side column it was dragged to (`height` is then left to the column).
 */
export function BottomPanel({ ws, height, tab: only }: { ws: Workspace; height?: number; tab?: BottomTab }) {
  const tab = only ?? ws.bottomTab;
  const hide = useHideTool(() => ws.setBottomOpen(false));
  const place = only ? 'island side' : 'island bottom';
  /** In the bottom panel: the tabs whose tool window wasn't dragged to a side. */
  const inBottom = (t: BottomTab) => {
    const tool = toolOfTab(t);
    return !tool || ws.toolLayout.bottom.includes(tool);
  };
  const runner = useTestRunner();
  const problems = ws.activePath ? ws.problems[ws.activePath] ?? [] : [];
  const outdatedCount = ws.outdated ? Object.keys(ws.outdated).length : 0;
  const tabs: { id: BottomTab; label: string; count?: string }[] = [
    { id: 'problems', label: 'Problems', count: problems.length ? String(problems.length) : undefined },
    { id: 'tests', label: 'Run', count: runner.running ? 'running' : undefined },
    { id: 'composer', label: 'Composer', count: outdatedCount ? `${outdatedCount} updates` : undefined },
    ...(ws.findResults ? [{ id: 'find' as const, label: 'Find', count: String(ws.findResults.result.total) }] : []),
    ...(ws.usages ? [{ id: 'usages' as const, label: `Usages of ${ws.usages.name}`, count: ws.usages.loading ? '…' : String(ws.usages.items.length) }] : []),
  ];

  if (tab === 'debug') {
    return (
      <section className={place} style={{ height }} aria-label="Debug">
        <DebugPanel ws={ws} />
      </section>
    );
  }

  if (tab === 'todo') {
    return (
      <section className={place} style={{ height }} aria-label="TODO">
        <TodoToolWindow ws={ws} />
      </section>
    );
  }

  if (tab === 'git') {
    return (
      <section className={place} style={{ height }} aria-label="Git">
        <GitToolWindow ws={ws} />
      </section>
    );
  }

  // Terminal is a tool window of its own (not a tab next to Problems).
  if (tab === 'terminal') {
    return (
      <section className={place} style={{ height }} aria-label="Terminal">
        {isTauri && ws.backend.kind === 'disk' ? (
          <TerminalView ws={ws} />
        ) : (
          <>
            <div className="tw-head">
              <span className="tw-title">Terminal</span>
              <span className="grow" />
              <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={hide}>
                <Icon name="minus" size={14} />
              </button>
            </div>
            <div className="panel-body">
              <Terminal ws={ws} />
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <section className={place} style={{ height }} aria-label={(only && tabs.find((t) => t.id === only)?.label) || 'Tool window'}>
      <div className="tw-head" role="tablist">
        {tabs.filter((t) => (only ? t.id === only : inBottom(t.id))).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={'tw-tab' + (tab === t.id ? ' active' : '')}
            onClick={() => ws.showBottom(t.id)}
          >
            {t.label}
            {t.count && <span className="count">{t.count}</span>}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={hide}>
          <Icon name="minus" size={14} />
        </button>
      </div>
      <div className="panel-body">
        {tab === 'problems' && <Problems ws={ws} />}
        {tab === 'usages' && <Usages ws={ws} />}
        {tab === 'find' && <FindResults ws={ws} />}
        {tab === 'tests' && <TestResults ws={ws} />}
        {tab === 'composer' && (
          <>
            {ws.packages.map((p) => {
              const latest = ws.outdated?.[p.name];
              return (
                <div key={p.name} className="row" style={{ height: 26, paddingLeft: 14, gap: 12 }}>
                  <span style={{ minWidth: 240 }}>{p.name}</span>
                  <span className="mono muted" style={{ fontSize: 12, minWidth: 90 }}>
                    {p.version}
                  </span>
                  {latest ? <span className="chip warn">{latest} available</span> : ws.outdated ? <span className="chip ok">up to date</span> : null}
                  <span className="muted">{p.kind}</span>
                </div>
              );
            })}
            {!ws.packages.length && (
              <div className="empty">{ws.hasComposer ? 'composer.json has no dependencies.' : 'No composer.json found in this project.'}</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const SEVERITY_ICON = { error: 'error', warning: 'warning', info: 'warning' } as const;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/** The Problems tool window: the current file, or errors across the project. */
function Problems({ ws }: { ws: Workspace }) {
  const [view, setView] = useState<'file' | 'project'>('file');
  const path = ws.activePath;
  const fileProblems = (path ? ws.problems[path] ?? [] : []).slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line);
  const project = useMemo(() => ws.projectProblems ?? [], [ws.projectProblems]);
  // Project Errors as flat rows (a file header, then its problems), so only those in view render.
  const projectRows = useMemo(() => {
    const byFile = new Map<string, Problem[]>();
    for (const p of project) {
      const list = byFile.get(p.path);
      if (list) list.push(p);
      else byFile.set(p.path, [p]);
    }
    const rows: ({ file: string; count: number } | Problem)[] = [];
    for (const [file, list] of byFile) rows.push({ file, count: list.length }, ...list);
    return rows;
  }, [project]);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const range = useVirtualRows(scroller, list, view === 'project' ? projectRows.length : 0, 24);
  const hasProject = ws.backend.kind === 'disk' && ws.magoStatus.state !== 'off';
  const needsInstall = !!ws.magoStatus.summary?.needsInstall;

  const row = (p: Problem, i: number, indent: number, showFile: boolean) => (
    <button
      key={i}
      type="button"
      className="row"
      style={{ height: 24, paddingLeft: indent, gap: 8 }}
      onClick={() => ws.openFile(p.path, { line: p.line, column: p.column })}
      title={p.help ? `${p.message}\n${p.help}` : p.message}
    >
      <span style={{ color: SEVERITY_COLOR[p.severity], display: 'inline-flex', flex: 'none' }}>
        <Icon name={SEVERITY_ICON[p.severity]} size={13} />
      </span>
      <span className="name">{p.message}</span>
      {p.code && <span className="detail mono" style={{ fontSize: 11.5 }}>{p.code}</span>}
      <span className="detail" style={{ marginLeft: 'auto', flex: 'none', paddingLeft: 12 }}>
        {showFile ? `${baseName(p.path)}:` : ''}
        {p.line}
        {p.column ? `:${p.column}` : ''}
      </span>
    </button>
  );

  return (
    <div ref={scroller} className="tree" style={{ height: '100%', overflow: 'auto' }}>
      <div className="row" style={{ height: 30, paddingLeft: 4, gap: 4 }}>
        <button type="button" className={'tw-tab' + (view === 'file' ? ' active' : '')} onClick={() => setView('file')}>
          File{path ? `: ${baseName(path)}` : ''} <span className="count">{fileProblems.length || ''}</span>
        </button>
        {hasProject && (
          <button type="button" className={'tw-tab' + (view === 'project' ? ' active' : '')} onClick={() => setView('project')}>
            Project Errors <span className="count">{(ws.projectProblemsTotal || project.length || '').toLocaleString()}</span>
          </button>
        )}
        <span className="grow" />
        {hasProject && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() => ws.reanalyzeProject()}
            disabled={ws.magoStatus.state === 'analyzing'}
            title="Re-run Mago's analysis on the whole project"
          >
            <Icon name="refresh" size={13} />
            {ws.magoStatus.state === 'analyzing' ? 'Analyzing…' : 'Re-analyze Project'}
          </button>
        )}
      </div>

      {view === 'file' && (
        <>
          {fileProblems.map((p, i) => row(p, i, 10, false))}
          {!path && <div className="empty">Open a file to see its problems.</div>}
          {path && !fileProblems.length && <div className="empty">No problems in {baseName(path)}.</div>}
        </>
      )}

      {view === 'project' && (
        <>
          {needsInstall && (
            <div className="problems-banner">
              <Icon name="warning" size={14} />
              <span className="grow">
                Type checking is off until dependencies are installed: composer.json lists packages, but vendor/ is missing.
                {ws.projectProblemsHidden > 0 && ` ${ws.projectProblemsHidden.toLocaleString()} problems about unknown classes are not shown.`}
              </span>
              <button type="button" className="btn small primary" onClick={ws.composerInstall}>
                Run composer install
              </button>
            </div>
          )}
          {ws.magoStatus.state === 'analyzing' && <div className="empty">Analyzing the project in the background… Open files are already checked.</div>}
          {ws.projectProblemsTotal > project.length && (
            <div className="row muted" style={{ height: 24, paddingLeft: 6 }}>
              Showing the first {project.length.toLocaleString()} of {ws.projectProblemsTotal.toLocaleString()} problems. Exclude folders you don't edit (Mark Directory As ▸ Excluded) or turn rules off to see fewer.
            </div>
          )}
          <div ref={list} style={{ paddingTop: range.before, paddingBottom: range.after }}>
            {projectRows.slice(range.start, range.end).map((r, k) =>
              'file' in r ? (
                <button key={`f:${r.file}`} type="button" className="row" style={{ height: 24, paddingLeft: 6 }} onClick={() => ws.openFile(r.file)} title={relativePath(ws.backend, r.file)}>
                  <FileIcon path={r.file} />
                  <span className="name">{baseName(r.file)}</span>
                  <span className="detail">{relativePath(ws.backend, r.file).split('/').slice(0, -1).join('/')}</span>
                  <span className="detail">
                    {r.count} {r.count === 1 ? 'problem' : 'problems'}
                  </span>
                </button>
              ) : (
                row(r, range.start + k, 30, false)
              ),
            )}
          </div>
          {ws.magoStatus.state === 'ready' && !project.length && !needsInstall && <div className="empty">No errors or warnings found in the project.</div>}
        </>
      )}
    </div>
  );
}

function Usages({ ws }: { ws: Workspace }) {
  const u = ws.usages;
  if (!u) return null;
  if (u.loading) return <div className="empty">Searching for usages of {u.name}…</div>;
  if (u.error) return <div className="empty">Could not find usages: {u.error}</div>;
  if (!u.items.length) return <div className="empty">No usages of {u.name} found in the project.</div>;

  const exact = u.items.filter((i) => !i.dynamic);
  const dynamic = u.items.filter((i) => i.dynamic);
  const byFile = (items: typeof u.items) => {
    const m = new Map<string, typeof u.items>();
    for (const item of items) {
      const list = m.get(item.path);
      if (list) list.push(item);
      else m.set(item.path, [item]);
    }
    return m;
  };
  const files = byFile(exact);
  const dynamicFiles = byFile(dynamic);

  // "Model::save" → "save", "App\\Models\\User" → "User": the part a usage's line contains.
  const key = u.name.split('::').pop()!.replace(/[()$]/g, '').split('\\').pop()!;
  const renderFiles = (groups: Map<string, typeof u.items>, muted = false) =>
    [...groups].map(([path, items]) => (
      <div key={`${muted ? 'd' : 'e'}:${path}`} className={muted ? 'usages-dynamic' : undefined}>
        <div className="row" style={{ paddingLeft: 6 }} title={relativePath(ws.backend, path)}>
          <FileIcon path={path} />
          <span className="name">{baseName(path)}</span>
          <span className="detail">{relativePath(ws.backend, path).split('/').slice(0, -1).join('/')}</span>
          <span className="detail">
            {items.length} {items.length === 1 ? 'usage' : 'usages'}
          </span>
        </div>
        {items.map((it) => (
          <button key={`${it.line}:${it.column}`} type="button" className="row" style={{ paddingLeft: 30, gap: 10 }} onClick={() => ws.openFile(it.path, { line: it.line, column: it.column })}>
            <span className="mono" style={{ color: 'var(--faint)', minWidth: 34, textAlign: 'right' }}>
              {it.line}
            </span>
            <span className="mono name" style={{ fontSize: 12.5 }}>
              {highlight(it.preview, key)}
            </span>
          </button>
        ))}
      </div>
    ));

  return (
    <div className="tree">
      <div className="row" style={{ paddingLeft: 6, color: 'var(--muted)' }}>
        {exact.length} {exact.length === 1 ? 'usage' : 'usages'} in {files.size} {files.size === 1 ? 'file' : 'files'}
        {dynamic.length > 0 && ` · ${dynamic.length} dynamic`}
      </div>
      {renderFiles(files)}
      {dynamic.length > 0 && (
        <>
          <div className="row usages-group" style={{ paddingLeft: 6 }} title="Called on something whose type isn't known: maybe this member, maybe another class's member of the same name">
            Dynamic usages · {dynamic.length} (receiver type unknown)
          </div>
          {renderFiles(dynamicFiles, true)}
        </>
      )}
    </div>
  );
}

/** Bolds the searched name inside a usage's line preview. */
function highlight(text: string, name: string) {
  const i = name ? text.indexOf(name) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <b style={{ color: '#fff', background: 'rgba(84,138,247,0.25)', borderRadius: 2 }}>{name}</b>
      {text.slice(i + name.length)}
    </>
  );
}

/** `project/sub/folder` for the terminal prompt. */
function promptOf(ws: Workspace, cwd: string) {
  return cwd === ws.backend.root ? ws.backend.name : `${ws.backend.name}/${relativePath(ws.backend, cwd)}`;
}

function Terminal({ ws }: { ws: Workspace }) {
  const [line, setLine] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [ws.terminal]);

  const submit = () => {
    const cmd = line.trim();
    if (!cmd) return;
    if (cmd === 'clear' || cmd === 'cls') {
      ws.clearTerminal();
      setLine('');
      return;
    }
    ws.runCommand(cmd);
    setHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 50));
    setCursor(-1);
    setLine('');
  };

  return (
    <div className="console" onClick={() => input.current?.focus()}>
      {ws.terminal.length === 0 && (
        <div className="muted">
          Commands run in {ws.backend.kind === 'sample' ? 'the sample project (try: php artisan route:list)' : ws.backend.root}. Each command runs once and shows its output.
        </div>
      )}
      {ws.terminal.map((t) => (
        <div key={t.id}>
          <div>
            <span className="prompt">{promptOf(ws, t.cwd)}</span> $ {t.line}
          </div>
          {!t.result && <div className="muted">running…</div>}
          {t.result?.stdout && <div>{t.result.stdout.replace(/\n$/, '')}</div>}
          {t.result?.stderr && <div className="err">{t.result.stderr.replace(/\n$/, '')}</div>}
        </div>
      ))}
      <div className="console-input">
        <span className="prompt">{promptOf(ws, ws.terminalCwd)}</span> $
        <label htmlFor="terminal-input" className="sr-only">
          Command
        </label>
        <input
          id="terminal-input"
          ref={input}
          value={line}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const next = Math.min(cursor + 1, history.length - 1);
              setCursor(next);
              setLine(history[next]);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const next = cursor - 1;
              setCursor(Math.max(next, -1));
              setLine(next >= 0 ? history[next] : '');
            }
          }}
        />
      </div>
      <div ref={end} />
    </div>
  );
}

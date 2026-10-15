import { useEffect, useRef, useState } from 'react';
import type { BottomTab, Workspace } from '../useWorkspace';
import { baseName, relativePath, type Problem } from '../backend/types';
import { Badge, Icon, Play, fileBadge } from './Icon';
import { FindResults } from './FindInFiles';
import { TerminalView } from './TerminalView';
import { isTauri } from '../platform';

const SEVERITY_COLOR = { error: 'var(--red)', warning: 'var(--orange)', info: 'var(--muted)' } as const;

export function BottomPanel({ ws, height }: { ws: Workspace; height: number }) {
  const problems = ws.activePath ? ws.problems[ws.activePath] ?? [] : [];
  const outdatedCount = ws.outdated ? Object.keys(ws.outdated).length : 0;
  const tabs: { id: BottomTab; label: string; count?: string }[] = [
    { id: 'problems', label: 'Problems', count: problems.length ? String(problems.length) : undefined },
    { id: 'tests', label: 'Tests', count: ws.tests.running ? 'running' : undefined },
    { id: 'composer', label: 'Composer', count: outdatedCount ? `${outdatedCount} updates` : undefined },
    ...(ws.findResults ? [{ id: 'find' as const, label: 'Find', count: String(ws.findResults.result.total) }] : []),
    ...(ws.usages ? [{ id: 'usages' as const, label: `Usages of ${ws.usages.name}`, count: ws.usages.loading ? '…' : String(ws.usages.items.length) }] : []),
  ];

  // Terminal is a tool window of its own, like in PhpStorm (not a tab next to Problems).
  if (ws.bottomTab === 'terminal') {
    return (
      <section className="island bottom" style={{ height }} aria-label="Terminal">
        {isTauri && ws.backend.kind === 'disk' ? (
          <TerminalView ws={ws} />
        ) : (
          <>
            <div className="tw-head">
              <span className="tw-title">Terminal</span>
              <span className="grow" />
              <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={() => ws.setBottomOpen(false)}>
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
    <section className="island bottom" style={{ height }} aria-label="Tool window">
      <div className="tw-head" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={ws.bottomTab === t.id}
            className={'tw-tab' + (ws.bottomTab === t.id ? ' active' : '')}
            onClick={() => ws.showBottom(t.id)}
          >
            {t.label}
            {t.count && <span className="count">{t.count}</span>}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={() => ws.setBottomOpen(false)}>
          <Icon name="minus" size={14} />
        </button>
      </div>
      <div className="panel-body">
        {ws.bottomTab === 'problems' && <Problems ws={ws} />}
        {ws.bottomTab === 'usages' && <Usages ws={ws} />}
        {ws.bottomTab === 'find' && <FindResults ws={ws} />}
        {ws.bottomTab === 'tests' && <Tests ws={ws} />}
        {ws.bottomTab === 'composer' && (
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
            {!ws.packages.length && <div className="empty">No composer.json found in this project.</div>}
          </>
        )}
      </div>
    </section>
  );
}

const SEVERITY_ICON = { error: 'error', warning: 'warning', info: 'warning' } as const;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/** JetBrains' Problems tool window: the current file, or errors across the project. */
function Problems({ ws }: { ws: Workspace }) {
  const [view, setView] = useState<'file' | 'project'>('file');
  const path = ws.activePath;
  const fileProblems = (path ? ws.problems[path] ?? [] : []).slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line);
  const project = ws.projectProblems ?? [];
  const projectFiles = new Map<string, Problem[]>();
  for (const p of project) projectFiles.set(p.path, [...(projectFiles.get(p.path) ?? []), p]);
  const hasProject = ws.backend.kind === 'disk' && ws.magoStatus.state !== 'off';

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
    <div className="tree">
      <div className="row" style={{ height: 30, paddingLeft: 4, gap: 4 }}>
        <button type="button" className={'tw-tab' + (view === 'file' ? ' active' : '')} onClick={() => setView('file')}>
          File{path ? `: ${baseName(path)}` : ''} <span className="count">{fileProblems.length || ''}</span>
        </button>
        {hasProject && (
          <button type="button" className={'tw-tab' + (view === 'project' ? ' active' : '')} onClick={() => setView('project')}>
            Project Errors <span className="count">{project.length || ''}</span>
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
          {ws.magoStatus.state === 'analyzing' && <div className="empty">Mago is analyzing the project…</div>}
          {[...projectFiles].map(([file, list]) => {
            const badge = fileBadge(file);
            return (
              <div key={file}>
                <button type="button" className="row" style={{ paddingLeft: 6 }} onClick={() => ws.openFile(file)} title={relativePath(ws.backend, file)}>
                  <Badge text={badge.text} color={badge.color} />
                  <span className="name">{baseName(file)}</span>
                  <span className="detail">{relativePath(ws.backend, file).split('/').slice(0, -1).join('/')}</span>
                  <span className="detail">
                    {list.length} {list.length === 1 ? 'problem' : 'problems'}
                  </span>
                </button>
                {list.map((p, i) => row(p, i, 30, false))}
              </div>
            );
          })}
          {ws.magoStatus.state === 'ready' && !project.length && <div className="empty">No problems found in the project.</div>}
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

  const files = new Map<string, typeof u.items>();
  for (const item of u.items) files.set(item.path, [...(files.get(item.path) ?? []), item]);

  return (
    <div className="tree">
      <div className="row" style={{ paddingLeft: 6, color: 'var(--muted)' }}>
        {u.items.length} {u.items.length === 1 ? 'usage' : 'usages'} in {files.size} {files.size === 1 ? 'file' : 'files'}
      </div>
      {[...files].map(([path, items]) => {
        const badge = fileBadge(path);
        return (
          <div key={path}>
            <div className="row" style={{ paddingLeft: 6 }} title={relativePath(ws.backend, path)}>
              <Badge text={badge.text} color={badge.color} />
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
                  {highlight(it.preview, u.name)}
                </span>
              </button>
            ))}
          </div>
        );
      })}
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

function Tests({ ws }: { ws: Workspace }) {
  const { running, result } = ws.tests;
  return (
    <div>
      <div className="row" style={{ height: 34, paddingLeft: 12, gap: 10 }}>
        <button type="button" className="btn small" onClick={ws.runTests} disabled={running}>
          <Play size={12} />
          {running ? 'Running…' : 'Run tests'}
        </button>
        {result && (
          <span style={{ color: result.ok ? 'var(--green)' : 'var(--red)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
            {result.ok && <Icon name="check" size={14} strokeWidth={3} />}
            {result.summary}
          </span>
        )}
      </div>
      {!result && !running && <div className="empty">No test results yet. Run PHPUnit with the button above or the ▶ in the toolbar.</div>}
      {result?.tests?.map((t) => (
        <div key={t.name} className="row" style={{ paddingLeft: 38, gap: 10 }}>
          <span style={{ color: t.ok ? 'var(--green)' : 'var(--red)', display: 'inline-flex' }}>
            <Icon name={t.ok ? 'check' : 'close'} size={12} strokeWidth={3} />
          </span>
          <span>{t.name}</span>
          <span className="grow" />
          <span className="mono muted" style={{ fontSize: 12 }}>
            {t.ms}
          </span>
        </div>
      ))}
      {result && !result.tests && <div className="console">{result.output || '(no output)'}</div>}
    </div>
  );
}

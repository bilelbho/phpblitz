// Git tool window: Log (branches, commit graph, details with changed files) and Console
// (the git commands PHPBlitz ran, with their output).

import { FileIcon } from './FileIcon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Branch, Commit, ConsoleEntry, FileChange } from '../git/git';
import { baseName, relativePath } from '../backend/types';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon } from './Icon';
import { copyText } from '../editorMenu';
import { confirmDialog } from '../platform';
import { HideToolButton, useHideTool } from './toolHide';

const PAGE = 300;
const LANE_COLORS = ['#5f9ff5', '#e3a869', '#73bd79', '#c77dbb', '#2aacb8', '#e5c07b', '#f0727a', '#9d8cf5'];

// ── Commit graph ─────────────────────────────────────────────

interface GraphRow {
  col: number;
  /** Lanes passing straight through this row. */
  through: number[];
  /** Lanes that end in this commit (merges into it from above). */
  incoming: number[];
  /** Lanes this commit's parents continue in. */
  outgoing: number[];
  width: number;
}

/** Lane layout for commits in date order: each lane waits for the next commit it leads to. */
function layoutGraph(commits: Commit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.push(null) - 1;
    }
    const incoming: number[] = [];
    const through: number[] = [];
    lanes.forEach((h, k) => {
      if (h === null) return;
      if (h === c.hash) incoming.push(k);
      else through.push(k);
    });
    lanes.forEach((h, k) => {
      if (h === c.hash) lanes[k] = null;
    });
    const outgoing: number[] = [];
    c.parents.forEach((p, i) => {
      // The first parent continues in this commit's lane (keeping the main line straight); if another
      // lane already waits for it, both lanes lead there and join at the parent.
      if (i === 0) {
        lanes[col] = p;
        outgoing.push(col);
        return;
      }
      let t = lanes.indexOf(p);
      if (t === -1) {
        t = lanes.indexOf(null);
        if (t === -1) t = lanes.push(null) - 1;
        lanes[t] = p;
      }
      outgoing.push(t);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ col, through, incoming, outgoing, width: Math.max(lanes.length, col + 1, ...incoming.map((k) => k + 1), ...through.map((k) => k + 1)) });
  }
  return rows;
}

const LANE_W = 12;
const ROW_H = 24;

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (k: number) => k * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const color = (k: number) => LANE_COLORS[k % LANE_COLORS.length];
  return (
    <svg width={width * LANE_W + 4} height={ROW_H} className="graph-cell" aria-hidden="true">
      {row.through.map((k) => (
        <line key={`t${k}`} x1={x(k)} y1={0} x2={x(k)} y2={ROW_H} stroke={color(k)} strokeWidth={1.6} />
      ))}
      {row.incoming.map((k) => (
        <path key={`i${k}`} d={`M${x(k)} 0 C ${x(k)} ${mid * 0.6}, ${x(row.col)} ${mid * 0.4}, ${x(row.col)} ${mid}`} stroke={color(k)} strokeWidth={1.6} fill="none" />
      ))}
      {row.outgoing.map((k, i) => (
        <path key={`o${i}`} d={`M${x(row.col)} ${mid} C ${x(row.col)} ${mid + mid * 0.6}, ${x(k)} ${mid + mid * 0.4}, ${x(k)} ${ROW_H}`} stroke={color(k)} strokeWidth={1.6} fill="none" />
      ))}
      <circle cx={x(row.col)} cy={mid} r={3.6} fill={color(row.col)} stroke="#1e1f22" strokeWidth={1.2} />
    </svg>
  );
}

// ── Tool window ──────────────────────────────────────────────

export function GitToolWindow({ ws }: { ws: Workspace }) {
  const hide = useHideTool(() => ws.setBottomOpen(false));
  const [tab, setTab] = useState<'log' | 'console'>('log');
  const req = ws.gitLogRequest;
  useEffect(() => {
    if (req.console) setTab('console');
    else if (req.nonce) setTab('log');
  }, [req.nonce, req.console]);

  return (
    <>
      <div className="tw-head">
        <span className="tw-title">Git</span>
        <button type="button" role="tab" aria-selected={tab === 'log'} className={'tw-tab' + (tab === 'log' ? ' active' : '')} onClick={() => setTab('log')}>
          Log
        </button>
        <button type="button" role="tab" aria-selected={tab === 'console'} className={'tw-tab' + (tab === 'console' ? ' active' : '')} onClick={() => setTab('console')}>
          Console
        </button>
        <span className="grow" />
        <HideToolButton onHide={hide} />
      </div>
      {!ws.git ? (
        <div className="empty">This project is not a Git repository, or Git is not installed.</div>
      ) : tab === 'log' ? (
        <GitLog ws={ws} />
      ) : (
        <GitConsole ws={ws} />
      )}
    </>
  );
}

function GitConsole({ ws }: { ws: Workspace }) {
  const [entries, setEntries] = useState<ConsoleEntry[]>(ws.gitRepo.console);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = ws.gitRepo.onConsole(() => setEntries([...ws.gitRepo.console]));
    return () => {
      off();
    };
  }, [ws.gitRepo]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [entries]);
  return (
    <div className="panel-body git-console mono">
      {!entries.length && <div className="muted">Git commands run by PHPBlitz (checkout, merge, push…) appear here.</div>}
      {entries.map((e, i) => (
        <div key={i} className={'gc-entry' + (e.ok ? '' : ' failed')}>
          <div>
            <span className="qc-time">{e.time}</span> <span className="gc-cmd">{e.command}</span>
          </div>
          {e.output && <div className="gc-out">{e.output}</div>}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function GitLog({ ws }: { ws: Workspace }) {
  const repo = ws.gitRepo;
  const [commits, setCommits] = useState<Commit[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [message, setMessage] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const pendingHash = useRef<string | null>(null);
  /** The file to highlight among the selected commit's changes (clicked annotation). */
  const [focusFile, setFocusFile] = useState<string | null>(null);

  // Requests from elsewhere: Show History (path), a commit from annotations, reload after actions.
  const req = ws.gitLogRequest;
  useEffect(() => {
    if (!req.nonce) return;
    if (req.path !== undefined) {
      setPath(req.path && req.path !== ws.backend.root ? req.path : null);
      setBranch(null);
      setSearch('');
      setSearchInput('');
    }
    if (req.hash) {
      pendingHash.current = req.hash;
      setFocusFile(req.file ?? null);
      setPath(null);
      setSearch('');
      setSearchInput('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.nonce]);

  const load = useCallback(
    async (append = false) => {
      setLoading(true);
      setError(null);
      try {
        const page = await repo.log({ max: PAGE, skip: append ? commits.length : 0, branch: branch ?? undefined, path: path ?? undefined, search: /^[0-9a-f]{6,40}$/i.test(search) ? undefined : search || undefined });
        let next = append ? [...commits, ...page] : page;
        // A hash in the search box: just that commit.
        if (/^[0-9a-f]{6,40}$/i.test(search)) next = next.filter((c) => c.hash.startsWith(search.toLowerCase()));
        setCommits(next);
        setMore(page.length === PAGE);
        const want = pendingHash.current;
        if (want) {
          pendingHash.current = null;
          const hit = next.find((c) => c.hash.startsWith(want));
          if (hit) setSelected(hit.hash);
        } else if (!append && !next.some((c) => c.hash === selected)) setSelected(next[0]?.hash ?? null);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, branch, path, search, commits.length, selected],
  );

  useEffect(() => {
    load(false);
    repo.branches().then(setBranches).catch(() => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, branch, path, search, req.reload, req.nonce]);

  // Details of the selected commit.
  useEffect(() => {
    if (!selected) {
      setFiles(null);
      setMessage('');
      return;
    }
    let live = true;
    setFiles(null);
    Promise.all([repo.commitFiles(selected), repo.commitMessage(selected)])
      .then(([f, m]) => {
        if (!live) return;
        setFiles(f);
        setMessage(m);
      })
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [repo, selected]);

  useEffect(() => {
    list.current?.querySelector('.log-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected, commits]);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const graphWidth = Math.min(10, Math.max(1, ...graph.map((g) => g.width)));
  const current = branches.find((b) => b.current)?.name ?? ws.git?.branch;
  const sel = commits.find((c) => c.hash === selected);

  const commitMenu = (e: React.MouseEvent, c: Commit) => {
    e.preventDefault();
    setSelected(c.hash);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copy Revision Number', icon: 'copy', run: () => copyText(ws, c.hash, 'revision number') },
        { label: 'Copy Subject', run: () => copyText(ws, c.subject, 'commit subject') },
        { kind: 'sep' },
        {
          label: 'Checkout Revision',
          run: async () => {
            if (await confirmDialog(`Checkout ${c.short}? You will be on a detached HEAD.`)) ws.runGit(`Checkout ${c.short}`, () => repo.checkout(c.hash));
          },
        },
        { label: 'New Branch…', icon: 'plus', run: () => ws.setGitDialog({ kind: 'newBranch', from: c.hash }) },
        { label: 'New Tag…', run: () => ws.setGitDialog({ kind: 'tag', hash: c.hash }) },
        { kind: 'sep' },
        { label: `Reset Current Branch to Here…`, run: () => ws.setGitDialog({ kind: 'reset', hash: c.hash, subject: c.subject }) },
        {
          label: 'Revert Commit',
          run: async () => {
            if (await confirmDialog(`Revert "${c.subject}"? A new commit undoes its changes.`)) ws.runGit(`Revert ${c.short}`, () => repo.revert(c.hash));
          },
        },
        { label: 'Cherry-Pick', disabled: c.parents.length > 1, run: () => ws.runGit(`Cherry-pick ${c.short}`, () => repo.cherryPick(c.hash)) },
      ],
    });
  };

  const fileMenu = (e: React.MouseEvent, f: FileChange) => {
    e.preventDefault();
    if (!sel) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Show Diff', icon: 'columns', run: () => ws.openDiff(f.path, sel.hash) },
        { label: 'Jump to Source', icon: 'goTo', disabled: f.status === 'D', run: () => ws.openFile(f.path) },
        { label: 'Show History for File', icon: 'history', run: () => ws.showHistory(f.path) },
        { kind: 'sep' },
        { label: 'Copy Path', icon: 'copy', run: () => copyText(ws, relativePath(ws.backend, f.path), 'path') },
      ],
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const i = commits.findIndex((c) => c.hash === selected);
    if (e.key === 'ArrowDown' && i < commits.length - 1) {
      e.preventDefault();
      setSelected(commits[i + 1].hash);
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      setSelected(commits[i - 1].hash);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel) {
      e.preventDefault();
      copyText(ws, sel.hash, 'revision number');
    }
  };

  return (
    <div className="git-log">
      <div className="gl-branches">
        <button type="button" className={'gl-branch' + (!branch ? ' selected' : '')} onClick={() => setBranch(null)}>
          <Icon name="history" size={13} /> All branches
        </button>
        <button type="button" className={'gl-branch' + (branch === 'HEAD' ? ' selected' : '')} onClick={() => setBranch('HEAD')}>
          <span className="bp-current">●</span> HEAD ({current})
        </button>
        <div className="gl-group">Local</div>
        {branches
          .filter((b) => !b.remote)
          .map((b) => (
            <button key={b.name} type="button" className={'gl-branch' + (branch === b.name ? ' selected' : '')} onClick={() => setBranch(b.name)} onDoubleClick={() => !b.current && ws.runGit(`Checkout ${b.name}`, () => repo.checkout(b.name))} title={b.current ? 'Current branch' : 'Double-click to check out'}>
              <Icon name="branch" size={12} /> <span className={b.current ? 'current' : undefined}>{b.name}</span>
              {(b.ahead || b.behind) && <span className="bp-detail">{[b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].join(' ')}</span>}
            </button>
          ))}
        {branches.some((b) => b.remote) && <div className="gl-group">Remote</div>}
        {branches
          .filter((b) => b.remote)
          .map((b) => (
            <button key={b.name} type="button" className={'gl-branch' + (branch === b.name ? ' selected' : '')} onClick={() => setBranch(b.name)}>
              <Icon name="branch" size={12} /> {b.name}
            </button>
          ))}
      </div>

      <div className="gl-main">
        <div className="tw-toolbar gl-toolbar">
          <div className="field gl-search">
            <Icon name="search" size={13} />
            <input
              value={searchInput}
              placeholder="Text or hash"
              aria-label="Search commits"
              spellCheck={false}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSearch(searchInput.trim());
                if (e.key === 'Escape') {
                  setSearchInput('');
                  setSearch('');
                }
              }}
            />
          </div>
          {branch && (
            <span className="chip gl-filter">
              Branch: {branch}
              <button type="button" aria-label="Clear branch filter" onClick={() => setBranch(null)}>
                ×
              </button>
            </span>
          )}
          {path && (
            <span className="chip gl-filter" title={path}>
              Path: {relativePath(ws.backend, path)}
              <button type="button" aria-label="Clear path filter" onClick={() => setPath(null)}>
                ×
              </button>
            </span>
          )}
          <button type="button" className="icon-btn small" title="Refresh" aria-label="Refresh" onClick={() => load(false)} disabled={loading}>
            <Icon name="refresh" size={13} />
          </button>
          <button type="button" className="icon-btn small" title="Fetch" aria-label="Fetch" onClick={() => ws.runGit('Fetch', () => repo.fetch())}>
            <Icon name="chevronDown" size={13} />
          </button>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>
            {loading ? 'Loading…' : `${commits.length}${more ? '+' : ''} ${commits.length === 1 && !more ? 'commit' : 'commits'}`}
          </span>
        </div>
        {error && <div className="te-error"><pre>{error}</pre></div>}
        <div
          ref={list}
          className="gl-list"
          tabIndex={0}
          onKeyDown={onKey}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (more && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 200) load(true);
          }}
        >
          {commits.map((c, i) => (
            <div
              key={c.hash}
              className={'log-row' + (c.hash === selected ? ' selected' : '')}
              onMouseDown={() => setSelected(c.hash)}
              onContextMenu={(e) => commitMenu(e, c)}
              title={`${c.hash}\n${c.author} <${c.email}>\n${new Date(c.date).toLocaleString()}`}
            >
              <span className="log-graph">{graph[i] && <GraphCell row={graph[i]} width={graphWidth} />}</span>
              <span className="log-subject">
                {c.refs.map((r) => (
                  <RefLabel key={r} name={r} />
                ))}
                <span className={c.parents.length > 1 ? 'muted' : undefined}>{c.subject}</span>
              </span>
              <span className="log-author">{c.author}</span>
              <span className="log-date">{formatDate(c.date)}</span>
            </div>
          ))}
          {!commits.length && !loading && <div className="empty">{search || branch || path ? 'No commits match.' : 'No commits yet.'}</div>}
        </div>
      </div>

      <div className="gl-details">
        {sel ? (
          <>
            <div className="gl-files">
              {files === null ? (
                <div className="muted gl-pad">Loading…</div>
              ) : (
                <>
                  <div className="gl-group">
                    {files.length} {files.length === 1 ? 'file' : 'files'} changed
                  </div>
                  {files.map((f) => {
                    return (
                      <button
                        key={f.path}
                        ref={f.path === focusFile ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                        type="button"
                        className={'gl-file' + (f.path === focusFile ? ' selected' : '')}
                        onClick={() => setFocusFile(f.path)}
                        onDoubleClick={() => ws.openDiff(f.path, sel.hash)} onContextMenu={(e) => fileMenu(e, f)} title={`${relativePath(ws.backend, f.path)}${f.from ? `\nrenamed from ${relativePath(ws.backend, f.from)}` : ''}\nDouble-click to show the diff`}>
                        <FileIcon path={f.path} />
                        <span className={`name status-${f.status === 'C' || f.status === 'T' ? 'M' : f.status}`}>{baseName(f.path)}</span>
                        <span className="detail">{relativePath(ws.backend, f.path).split('/').slice(0, -1).join('/')}</span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
            <div className="gl-message">
              <div className="gl-subject">{message || sel.subject}</div>
              <div className="muted gl-meta">
                <span className="mono">{sel.short}</span> {sel.author} &lt;{sel.email}&gt;
                <br />
                {new Date(sel.date).toLocaleString()}
                {sel.parents.length > 1 && (
                  <>
                    <br />
                    Merge of {sel.parents.map((p) => p.slice(0, 7)).join(', ')}
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="muted gl-pad">Select a commit to see its changes.</div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function RefLabel({ name }: { name: string }) {
  if (name.startsWith('tag: ')) return <span className="ref-label tag">{name.slice(5)}</span>;
  if (name.startsWith('HEAD -> ')) return <span className="ref-label head">{name.slice(8)}</span>;
  if (name === 'HEAD') return <span className="ref-label head">HEAD</span>;
  return <span className={'ref-label ' + (name.includes('/') && /^(origin|upstream)\//.test(name) ? 'remote' : 'local')}>{name}</span>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days < 1 && d.getDate() === now.getDate()) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (days < 2) return `Yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { year: '2-digit', month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The Git branches popup (top bar branch widget), like PhpStorm's: search, Update / Commit /
// Push / Fetch / New Branch / Stash, then local and remote branches with their actions.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Branch } from '../git/git';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import { confirmDialog } from '../platform';

interface Row {
  key: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  detail?: string;
  branch?: Branch;
  run?: () => void;
  head?: boolean;
}

export function BranchesPopup({ ws, anchor, onClose }: { ws: Workspace; anchor: DOMRect; onClose: () => void }) {
  const repo = ws.gitRepo;
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [submenu, setSubmenu] = useState<{ x: number; y: number; items: ContextItem[]; key: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    repo.branches().then(setBranches).catch(() => setBranches([]));
    search.current?.focus();
  }, [repo]);

  const current = branches?.find((b) => b.current)?.name ?? ws.git?.branch ?? '';
  const act = (label: string, fn: () => Promise<unknown>) => () => {
    onClose();
    ws.runGit(label, fn);
  };
  const dialog = (d: Parameters<Workspace['setGitDialog']>[0]) => () => {
    onClose();
    ws.setGitDialog(d);
  };

  const branchItems = (b: Branch): ContextItem[] => {
    if (b.current) {
      return [
        { label: `New Branch from '${b.name}'…`, icon: 'plus', run: dialog({ kind: 'newBranch', from: b.name }) },
        { label: 'Rename…', icon: 'pencil', run: dialog({ kind: 'renameBranch', branch: b.name }) },
        { label: 'Push…', shortcut: 'Ctrl+Shift+K', run: dialog({ kind: 'push' }) },
        { label: 'Show History', icon: 'history', run: () => (onClose(), ws.showHistory(ws.backend.root)) },
      ];
    }
    const items: ContextItem[] = [
      { label: 'Checkout', run: act(`Checkout ${b.name}`, () => (b.remote ? repo.checkoutRemote(b.name) : repo.checkout(b.name))) },
      { label: `New Branch from '${b.name}'…`, icon: 'plus', run: dialog({ kind: 'newBranch', from: b.name }) },
      { kind: 'sep' },
      { label: `Rebase '${current}' onto '${b.name}'`, run: act(`Rebase onto ${b.name}`, () => repo.rebase(b.name)) },
      { label: `Merge '${b.name}' into '${current}'`, run: act(`Merge ${b.name}`, () => repo.merge(b.name)) },
      { kind: 'sep' },
    ];
    if (!b.remote) items.push({ label: 'Rename…', icon: 'pencil', run: dialog({ kind: 'renameBranch', branch: b.name }) });
    items.push({
      label: 'Delete',
      run: async () => {
        onClose();
        if (!(await confirmDialog(b.remote ? `Delete the remote branch ${b.name}? This deletes it on the server.` : `Delete the branch ${b.name}?`))) return;
        const ok = await ws.runGit(`Delete ${b.name}`, () => (b.remote ? repo.deleteRemoteBranch(b.name) : repo.deleteBranch(b.name)));
        // Not merged: offer to force it, like PhpStorm.
        if (!ok && !b.remote && (await confirmDialog(`${b.name} is not fully merged. Delete it anyway? Its unmerged commits are lost.`))) {
          await ws.runGit(`Delete ${b.name}`, () => repo.deleteBranch(b.name, true));
        }
      },
    });
    return items;
  };

  const actions: Row[] = [
    { key: 'update', label: 'Update Project…', icon: 'refresh', shortcut: 'Ctrl+T', run: act('Update project', () => repo.pull()) },
    { key: 'commit', label: 'Commit…', icon: 'commit', shortcut: 'Ctrl+K', run: () => (onClose(), ws.showLeft('commit')) },
    { key: 'push', label: 'Push…', icon: 'chevronUp', shortcut: 'Ctrl+Shift+K', run: dialog({ kind: 'push' }) },
    { key: 'fetch', label: 'Fetch', icon: 'chevronDown', run: act('Fetch', () => repo.fetch()) },
    { key: 'new', label: 'New Branch…', icon: 'plus', run: dialog({ kind: 'newBranch' }) },
    { key: 'rev', label: 'Checkout Tag or Revision…', run: dialog({ kind: 'checkoutRevision' }) },
    { key: 'stash', label: 'Stash Changes…', run: dialog({ kind: 'stash' }) },
    { key: 'unstash', label: 'Unstash Changes…', run: dialog({ kind: 'unstash' }) },
    { key: 'log', label: 'Show Git Log', icon: 'history', run: () => (onClose(), ws.showHistory('')) },
  ];

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const track = (b: Branch) => [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
  const local = (branches ?? []).filter((b) => !b.remote && match(b.name)).sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  const remote = (branches ?? []).filter((b) => b.remote && match(b.name));
  const rows: Row[] = [
    ...actions.filter((a) => match(a.label)),
    ...(local.length ? [{ key: 'h-local', label: 'Local', head: true }] : []),
    ...local.map((b) => ({ key: `l:${b.name}`, label: b.name, branch: b, detail: [b.upstream, track(b)].filter(Boolean).join('  ') })),
    ...(remote.length ? [{ key: 'h-remote', label: 'Remote', head: true }] : []),
    ...remote.map((b) => ({ key: `r:${b.name}`, label: b.name, branch: b })),
  ];
  const selectable = rows.map((r, i) => (r.head ? -1 : i)).filter((i) => i >= 0);
  const activeRow = rows[selectable[Math.min(active, selectable.length - 1)] ?? -1];

  const openSubmenu = (row: Row) => {
    if (!row.branch) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(row.key)}"]`);
    const r = el?.getBoundingClientRect();
    if (!r) return;
    setSubmenu({ x: r.right + 2, y: r.top - 4, items: branchItems(row.branch), key: row.key });
  };
  const choose = (row: Row) => (row.branch ? openSubmenu(row) : row.run?.());

  useLayoutEffect(() => {
    box.current?.querySelector('.bp-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.branches-popup, .ctx-menu')) onClose();
    };
    window.addEventListener('mousedown', outside, true);
    return () => window.removeEventListener('mousedown', outside, true);
  }, [onClose]);

  const left = Math.min(anchor.left, window.innerWidth - 420);
  return (
    <div
      ref={box}
      className="branches-popup"
      style={{ left, top: anchor.bottom + 4 }}
      role="dialog"
      aria-label="Git branches"
      onKeyDown={(e) => {
        if (submenu) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((a) => Math.min(a + 1, selectable.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === 'Enter' || (e.key === 'ArrowRight' && activeRow?.branch)) {
          e.preventDefault();
          if (activeRow) choose(activeRow);
        }
      }}
    >
      <div className="field bp-search">
        <Icon name="search" size={14} />
        <input
          ref={search}
          value={query}
          placeholder="Search for branches and actions"
          aria-label="Search for branches and actions"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
      </div>
      <div className="bp-list">
        {rows.map((r) =>
          r.head ? (
            <div key={r.key} className="bp-head">
              {r.label}
            </div>
          ) : (
            <button
              key={r.key}
              type="button"
              data-key={r.key}
              className={'bp-row' + (activeRow?.key === r.key ? ' active' : '') + (submenu?.key === r.key ? ' open' : '')}
              onMouseEnter={() => setActive(selectable.indexOf(rows.indexOf(r)))}
              onClick={() => choose(r)}
            >
              <span className="bp-icon">
                {r.branch ? (
                  r.branch.current ? (
                    <span className="bp-current" title="Current branch">●</span>
                  ) : (
                    <Icon name="branch" size={13} />
                  )
                ) : r.icon ? (
                  <Icon name={r.icon} size={14} />
                ) : null}
              </span>
              <span className={'bp-label' + (r.branch?.current ? ' current' : '')}>{r.label}</span>
              {r.detail && <span className="bp-detail">{r.detail}</span>}
              {r.shortcut && <span className="shortcut">{r.shortcut}</span>}
              {r.branch && <Icon name="chevronRight" size={11} />}
            </button>
          ),
        )}
        {branches === null && <div className="muted bp-head">Loading branches…</div>}
      </div>
      {submenu && (
        <ContextMenu
          x={submenu.x}
          y={submenu.y}
          items={submenu.items}
          onClose={() => {
            setSubmenu(null);
            search.current?.focus();
          }}
        />
      )}
    </div>
  );
}

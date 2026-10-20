// Rollback Changes: every local change in a tree by folder, each with a checkbox (the ones the
// rollback was asked for start checked). Rollback puts the checked files back to HEAD; added
// files become unversioned again, or go to the Recycle Bin with "Delete local copies".

import { useMemo, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath, type GitChange } from '../backend/types';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { useDialogFocus } from './useDialogFocus';

const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'unversioned' } as const;

export function RollbackDialog({ ws, paths, onClose }: { ws: Workspace; paths: string[]; onClose: () => void }) {
  const changes = useMemo(() => (ws.git?.changes ?? []).filter((c) => c.status !== 'U'), [ws.git]);
  const [checked, setChecked] = useState(() => new Set(paths.filter((p) => changes.some((c) => c.path === p))));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(paths[0] ?? null);
  const [deleteAdded, setDeleteAdded] = useState(false);
  const [busy, setBusy] = useState(false);

  // Folders (by their path from the project root), then the files at the root.
  const groups = useMemo(() => {
    const byDir = new Map<string, GitChange[]>();
    for (const c of changes) {
      const dir = relativePath(ws.backend, c.path).split('/').slice(0, -1).join('/');
      byDir.set(dir, [...(byDir.get(dir) ?? []), c]);
    }
    return [...byDir.entries()].sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
  }, [changes, ws.backend]);

  const picked = changes.filter((c) => checked.has(c.path));
  const addedPicked = picked.some((c) => c.status === 'A');
  const set = (list: GitChange[], on: boolean) =>
    setChecked((s) => {
      const next = new Set(s);
      for (const c of list) {
        if (on) next.add(c.path);
        else next.delete(c.path);
      }
      return next;
    });
  const toggleOpen = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const box = (list: GitChange[], label: string) => {
    const on = list.filter((c) => checked.has(c.path)).length;
    return (
      <input
        type="checkbox"
        className="checkbox"
        aria-label={`Roll back ${label}`}
        checked={on > 0 && on === list.length}
        ref={(el) => {
          if (el) el.indeterminate = on > 0 && on < list.length;
        }}
        onChange={() => set(list, on !== list.length)}
        onClick={(e) => e.stopPropagation()}
      />
    );
  };

  const showDiff = (c: GitChange | undefined) => {
    if (!c) return;
    onClose();
    ws.openDiff(c.path);
  };

  const rollback = async () => {
    if (!picked.length) return;
    setBusy(true);
    const ok = await ws.rollbackNow(picked, deleteAdded && addedPicked);
    setBusy(false);
    if (ok) {
      ws.setStatus(`Rolled back ${picked.length === 1 ? baseName(picked[0].path) : `${picked.length} files`}.`);
      onClose();
    }
  };

  const fileRow = (c: GitChange, depth: number) => (
    <div
      key={c.path}
      className={'row' + (selected === c.path ? ' selected' : '')}
      style={{ paddingLeft: 8 + depth * 18 }}
      onMouseDown={() => setSelected(c.path)}
      onDoubleClick={() => showDiff(c)}
      title={`${relativePath(ws.backend, c.path)} (${STATUS_LABEL[c.status]}) · double-click for the diff`}
    >
      <span className="chev-space" />
      <input type="checkbox" className="checkbox" aria-label={`Roll back ${baseName(c.path)}`} checked={checked.has(c.path)} onChange={() => set([c], !checked.has(c.path))} />
      <FileIcon path={c.path} />
      <span className={`name status-${c.status}`}>{baseName(c.path)}</span>
    </div>
  );

  const dialogRef = useDialogFocus();
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-dialog rollback-dialog"
        role="dialog"
        aria-modal="true"
        ref={dialogRef} tabIndex={-1} aria-label="Rollback Changes"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void rollback();
          else if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            showDiff(changes.find((c) => c.path === selected));
          }
        }}
      >
        <div className="pb-dialog-title">Rollback Changes</div>
        <div className="tw-toolbar rollback-toolbar">
          <button type="button" className="icon-btn" aria-label="Show diff" title="Show Diff (Ctrl+D)" disabled={!selected} onClick={() => showDiff(changes.find((c) => c.path === selected))}>
            <Icon name="columns" size={15} />
          </button>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Expand all" title="Expand All" onClick={() => setCollapsed(new Set())}>
            <Icon name="expandAll" size={15} />
          </button>
          <button type="button" className="icon-btn" aria-label="Collapse all" title="Collapse All" onClick={() => setCollapsed(new Set(groups.map(([d]) => d).filter(Boolean)))}>
            <Icon name="collapseAll" size={15} />
          </button>
        </div>
        <div className="tree rollback-tree" tabIndex={-1}>
          {changes.length ? (
            <>
              <div className="row commit-group group main" style={{ paddingLeft: 8 }}>
                <span className="chev-space" />
                {box(changes, 'all changes')}
                <span className="commit-group-label">Changes</span>
                <span className="detail">
                  {changes.length} {changes.length === 1 ? 'file' : 'files'}
                </span>
              </div>
              {groups.map(([dir, files]) =>
                dir ? (
                  <div key={dir}>
                    <div className="row commit-group dir" style={{ paddingLeft: 26 }} onClick={() => toggleOpen(dir)}>
                      <span className={'chev' + (collapsed.has(dir) ? '' : ' open')}>
                        <Icon name="chevronRight" size={12} />
                      </span>
                      {box(files, dir)}
                      <Icon name="folder" size={14} />
                      <span>{dir}</span>
                      <span className="detail">
                        {files.length} {files.length === 1 ? 'file' : 'files'}
                      </span>
                    </div>
                    {!collapsed.has(dir) && files.map((c) => fileRow(c, 2))}
                  </div>
                ) : (
                  files.map((c) => fileRow(c, 1))
                ),
              )}
            </>
          ) : (
            <div className="empty">No local changes to roll back.</div>
          )}
        </div>
        <label className="settings-check rollback-delete" title={addedPicked ? 'The added files go to the Recycle Bin instead of staying on disk as unversioned files' : 'None of the checked files is an added file'}>
          <input type="checkbox" className="checkbox" checked={deleteAdded && addedPicked} disabled={!addedPicked} onChange={(e) => setDeleteAdded(e.target.checked)} />
          Delete local copies of added files
        </label>
        <div className="pb-dialog-buttons">
          <span className="muted rollback-count">
            {picked.length} of {changes.length} selected
          </span>
          <button type="button" className="btn primary" disabled={!picked.length || busy} onClick={() => void rollback()} title="Rollback (Ctrl+Enter)">
            {busy ? 'Rolling back…' : 'Rollback'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

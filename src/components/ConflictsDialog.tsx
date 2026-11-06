// Git ▸ Resolve Conflicts: the files a merge, rebase, cherry-pick or revert left conflicted. Each is
// resolved by taking one side whole, or in the merge editor; then the operation can go on.

import { Fragment, useEffect, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { ConflictKind, GitChange, GitOperation } from '../backend/types';
import { baseName, relativePath } from '../backend/types';
import { FileIcon } from './FileIcon';
import { useDialogFocus } from './useDialogFocus';
import { Icon } from './Icon';
import { MergeEditor, sideLabels } from './MergeEditor';
import { operationName } from './GitOperationBanner';

const KIND: Record<ConflictKind, [ours: string, theirs: string]> = {
  'both-modified': ['Modified', 'Modified'],
  'both-added': ['Added', 'Added'],
  'both-deleted': ['Deleted', 'Deleted'],
  'deleted-by-us': ['Deleted', 'Modified'],
  'deleted-by-them': ['Modified', 'Deleted'],
  'added-by-us': ['Added', '—'],
  'added-by-them': ['—', 'Added'],
};

/** Whether this side has no file (taking it deletes the file). */
const deletedOn = (kind: ConflictKind | undefined, side: 'ours' | 'theirs') =>
  kind === 'both-deleted' || (side === 'ours' ? kind === 'deleted-by-us' || kind === 'added-by-them' : kind === 'deleted-by-them' || kind === 'added-by-us');

/** Both sides have the file: it can be merged line by line. */
export const canMerge = (c: GitChange) => !deletedOn(c.conflict, 'ours') && !deletedOn(c.conflict, 'theirs');

/** "Merging branch dev1 into branch dev2", "Rebasing branch topic (2/3)"… */
function describe(op: GitOperation | undefined, branch: string): string {
  switch (op?.kind) {
    case 'merge':
      return op.incoming ? `Merging branch ${op.incoming} into branch ${branch}` : `Merging into branch ${branch}`;
    case 'rebase':
      return `Rebasing branch ${op.branch ?? branch}${op.step ? ` (commit ${op.step})` : ''}`;
    case 'cherry-pick':
      return `Cherry-picking commit ${op.incoming ?? ''} onto branch ${branch}`;
    case 'revert':
      return `Reverting commit ${op.incoming ?? ''} on branch ${branch}`;
    default:
      return 'Files with conflicts';
  }
}

const GROUP_KEY = 'phpblitz.conflictsByDirectory';

export function ConflictsDialog({ ws, onClose, initial }: { ws: Workspace; onClose: () => void; initial?: string }) {
  const box = useDialogFocus();
  const [byDir, setByDir] = useState(() => {
    try {
      return localStorage.getItem(GROUP_KEY) === '1';
    } catch {
      return false;
    }
  });
  const conflictsAll = (ws.git?.changes ?? []).filter((c) => c.status === 'C');
  const dirOf = (c: GitChange) => relativePath(ws.backend, c.path).split('/').slice(0, -1).join('/');
  const conflicts = byDir ? [...conflictsAll].sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || a.path.localeCompare(b.path)) : conflictsAll;
  const [selected, setSelected] = useState<string | null>(initial ?? conflicts[0]?.path ?? null);
  const [merging, setMerging] = useState<string | null>(initial && conflicts.some((c) => c.path === initial && canMerge(c)) ? initial : null);
  const op = ws.git?.operation;
  const labels = sideLabels(op, ws.git?.branch ?? 'HEAD');
  const current = conflicts.find((c) => c.path === selected) ?? conflicts[0];

  // The list follows the status: a resolved file leaves it.
  useEffect(() => {
    if (selected && !conflicts.some((c) => c.path === selected)) setSelected(conflicts[0]?.path ?? null);
  }, [conflicts, selected]);

  const accept = (c: GitChange, side: 'ours' | 'theirs') =>
    void ws.runGit(`Accept ${side === 'ours' ? 'yours' : 'theirs'}: ${baseName(c.path)}`, () => ws.gitRepo.acceptSide(c.path, side, deletedOn(c.conflict, side)));

  if (merging) return <MergeEditor ws={ws} path={merging} onClose={() => setMerging(null)} />;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        className="pb-dialog conflicts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflicts-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="pb-dialog-title" id="conflicts-title">
          Conflicts
        </div>
        <div className="pb-dialog-body">
          <div className="conflicts-subtitle">{describe(op, ws.git?.branch ?? 'HEAD')}</div>
          {!conflicts.length ? (
            <div className="empty conflicts-done">All conflicts are resolved.{op ? ` Continue (${operationName(op)}) from the Commit panel.` : ''}</div>
          ) : (
            <div className="conflicts-body">
              <div className="conflicts-list" role="grid" aria-label="Conflicted files">
                <div className="conflicts-row head" role="row">
                  <span role="columnheader">Name</span>
                  <span role="columnheader" title={labels.ours}>
                    {labels.ours}
                  </span>
                  <span role="columnheader" title={labels.theirs}>
                    {labels.theirs}
                  </span>
                </div>
                {conflicts.map((c, i) => {
                  const [ours, theirs] = KIND[c.conflict ?? 'both-modified'];
                  const dir = dirOf(c);
                  const newDir = byDir && (i === 0 || dirOf(conflicts[i - 1]) !== dir);
                  return (
                    <Fragment key={c.path}>
                      {newDir && (
                        <div className="conflicts-row dir" role="row">
                          <span className="conflicts-name">
                            <Icon name="folder" size={14} className="folder-icon" />
                            <span className="name">{dir || ws.backend.name}</span>
                          </span>
                        </div>
                      )}
                      <div
                        role="row"
                        aria-selected={current?.path === c.path}
                        className={'conflicts-row' + (current?.path === c.path ? ' selected' : '') + (byDir ? ' nested' : '')}
                        onMouseDown={() => setSelected(c.path)}
                        onDoubleClick={() => canMerge(c) && setMerging(c.path)}
                        title={relativePath(ws.backend, c.path)}
                      >
                        <span className="conflicts-name">
                          <FileIcon path={c.path} />
                          <span className="name">{baseName(c.path)}</span>
                          {!byDir && <span className="detail">{dir}</span>}
                        </span>
                        <span>{ours}</span>
                        <span>{theirs}</span>
                      </div>
                    </Fragment>
                  );
                })}
              </div>
              <div className="conflicts-actions">
                <button type="button" className="btn" disabled={!current} onClick={() => current && accept(current, 'ours')}>
                  Accept Yours
                </button>
                <button type="button" className="btn" disabled={!current} onClick={() => current && accept(current, 'theirs')}>
                  Accept Theirs
                </button>
                <button type="button" className="btn primary" disabled={!current || !canMerge(current)} onClick={() => current && setMerging(current.path)} title={current && !canMerge(current) ? 'One side deleted this file: accept a side' : undefined}>
                  Merge…
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="pb-dialog-buttons">
          <label className="settings-check" style={{ marginRight: 'auto' }}>
            <input
              type="checkbox"
              className="checkbox"
              checked={byDir}
              onChange={(e) => {
                setByDir(e.target.checked);
                try {
                  localStorage.setItem(GROUP_KEY, e.target.checked ? '1' : '0');
                } catch {
                  // Only a preference.
                }
              }}
            />
            Group files by directory
          </label>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

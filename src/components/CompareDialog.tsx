// Branches popup ▸ Compare with Current / Show Diff with Working Tree (and the log's Compare with
// Local): the commits each side has that the other hasn't, and the files that differ. A file opens
// as a diff between the two; a commit opens in the Git log.

import { useEffect, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Commit, FileChange } from '../git/git';
import { baseName, relativePath } from '../backend/types';
import { FileIcon } from './FileIcon';
import { useDialogFocus } from './useDialogFocus';

const STATUS: Record<FileChange['status'], string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

/** `right` null: the working tree. */
export function CompareDialog({ ws, left, right, onClose }: { ws: Workspace; left: string; right: string | null; onClose: () => void }) {
  const box = useDialogFocus();
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [commits, setCommits] = useState<{ onlyRight: Commit[]; onlyLeft: Commit[] } | null>(null);
  const [tab, setTab] = useState<'commits' | 'files'>(right ? 'commits' : 'files');
  const [error, setError] = useState<string | null>(null);
  const rightName = right ?? 'your working tree';

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [f, onlyRight, onlyLeft] = await Promise.all([
          ws.gitRepo.compareFiles(left, right),
          right ? ws.gitRepo.commitsBetween(left, right) : Promise.resolve([]),
          right ? ws.gitRepo.commitsBetween(right, left) : Promise.resolve([]),
        ]);
        if (!live) return;
        setFiles(f);
        setCommits({ onlyRight, onlyLeft });
      } catch (e) {
        if (live) setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ws, left, right]);

  const openFile = (f: FileChange) => {
    onClose();
    ws.openDiff(f.path, right ?? undefined, left);
  };
  const openCommit = (c: Commit) => {
    onClose();
    ws.showCommit(c.hash);
  };

  const commitList = (title: string, list: Commit[]) => (
    <div className="compare-commits">
      <div className="compare-head">
        {title} <span className="muted">{list.length}</span>
      </div>
      {list.length ? (
        list.map((c) => (
          <div key={c.hash} className="compare-row" onDoubleClick={() => openCommit(c)} title={`${c.hash}\n${c.author} · ${new Date(c.date).toLocaleString()}\nDouble-click to show it in the log`}>
            <span className="mono muted">{c.short}</span>
            <span className="compare-subject">{c.subject}</span>
            <span className="muted">{c.author}</span>
          </div>
        ))
      ) : (
        <div className="muted compare-none">None</div>
      )}
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        className="pb-dialog compare-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="pb-dialog-title" id="compare-title">
          Comparing {left} with {rightName}
        </div>
        <div className="pb-dialog-body">
          {right && (
            <div className="compare-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'commits'} className={'tw-tab' + (tab === 'commits' ? ' active' : '')} onClick={() => setTab('commits')}>
                Commits
              </button>
              <button type="button" role="tab" aria-selected={tab === 'files'} className={'tw-tab' + (tab === 'files' ? ' active' : '')} onClick={() => setTab('files')}>
                Files <span className="count">{files?.length ?? ''}</span>
              </button>
            </div>
          )}
          {error ? (
            <div className="error-text">{error}</div>
          ) : !files || !commits ? (
            <div className="muted">Comparing…</div>
          ) : tab === 'commits' && right ? (
            <div className="compare-body">
              {commitList(`In ${right}, not in ${left}`, commits.onlyRight)}
              {commitList(`In ${left}, not in ${right}`, commits.onlyLeft)}
            </div>
          ) : (
            <div className="compare-body compare-files" role="list" aria-label="Files that differ">
              {files.length ? (
                files.map((f) => (
                  <div key={f.path} className="compare-row" role="listitem" onDoubleClick={() => openFile(f)} title={`${relativePath(ws.backend, f.path)} (${STATUS[f.status]})\nDouble-click for the diff`}>
                    <FileIcon path={f.path} />
                    <span className={`name status-${f.status === 'C' || f.status === 'T' ? 'M' : f.status}`}>{baseName(f.path)}</span>
                    <span className="muted compare-subject">{relativePath(ws.backend, f.path).split('/').slice(0, -1).join('/')}</span>
                    <span className="muted">{STATUS[f.status]}</span>
                  </div>
                ))
              ) : (
                <div className="muted compare-none">No differences.</div>
              )}
            </div>
          )}
        </div>
        <div className="pb-dialog-buttons">
          <span className="muted compare-hint">Double-click a {tab === 'files' || !right ? 'file for its diff' : 'commit to show it in the log'}.</span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

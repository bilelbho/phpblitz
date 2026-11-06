// Commit panel ▸ Shelve Changes: the chosen files' changes put aside as a named patch (Shelf tab).

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { FileIcon } from './FileIcon';

export function ShelveDialog({ ws, paths, onClose }: { ws: Workspace; paths: string[]; onClose: () => void }) {
  const changes = (ws.git?.changes ?? []).filter((c) => paths.includes(c.path) && c.status !== 'C');
  const [name, setName] = useState('');
  const [keep, setKeep] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const shelve = () => {
    if (!changes.length) return;
    onClose();
    void ws.runGit(`Shelve ${changes.length === 1 ? baseName(changes[0].path) : `${changes.length} files`}`, () => ws.gitRepo.shelve(changes, name, keep));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shelve-title"
        style={{ width: 520 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') shelve();
        }}
      >
        <div className="pb-dialog-title" id="shelve-title">
          Shelve Changes
        </div>
        <div className="pb-dialog-body">
          <label htmlFor="shelve-name">Name:</label>
          <div className="field">
            <input id="shelve-name" ref={input} type="text" value={name} spellCheck={false} placeholder={`Changes from ${new Date().toLocaleDateString()}`} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="shelve-files" role="list" aria-label="Files to shelve">
            {changes.map((c) => (
              <div key={c.path} className="row" role="listitem" title={relativePath(ws.backend, c.path)}>
                <FileIcon path={c.path} />
                <span className={`name status-${c.status}`}>{baseName(c.path)}</span>
                <span className="detail">{relativePath(ws.backend, c.path).split('/').slice(0, -1).join('/')}</span>
              </div>
            ))}
            {!changes.length && <div className="muted" style={{ padding: 8 }}>No changes chosen: check files in the Commit panel first.</div>}
          </div>
          <label className="settings-check">
            <input type="checkbox" className="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            Keep the changes in the working tree
          </label>
          {!keep && <span className="muted" style={{ fontSize: 12 }}>The files go back to HEAD; new files go to the Recycle Bin. Unshelve brings them back.</span>}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!changes.length} onClick={shelve}>
            Shelve
          </button>
        </div>
      </div>
    </div>
  );
}

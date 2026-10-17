// Refactor ▸ Rename (Shift+F6), like PhpStorm's dialog: the new name, what will change, and the
// choices (dynamic usages, renaming the class file).

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName } from '../backend/types';
import { renameEdits, validName, type RenamePlan } from '../rename';

export function SymbolRenameDialog({ ws, plan, onClose }: { ws: Workspace; plan: RenamePlan; onClose: () => void }) {
  const [name, setName] = useState(plan.oldName);
  const [dynamic, setDynamic] = useState(false);
  const [renameFile, setRenameFile] = useState(!!plan.file);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);

  const valid = validName(name) && name !== plan.oldName;
  const files = new Set([...plan.declarations, ...plan.usages, ...(dynamic ? plan.dynamic : [])].map((e) => e.path));
  const count = plan.usages.length + (dynamic ? plan.dynamic.length : 0);
  const extraDeclarations = plan.declarations.length - 1;
  const what = plan.kind === 'variable' ? `variable $${plan.oldName}` : plan.kind === 'method' || plan.kind === 'function' ? `${plan.kind} ${plan.oldName}()` : `${plan.kind} ${plan.oldName}`;

  const run = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const byFile = new Map([...renameEdits(plan, dynamic)].map(([path, edits]) => [path, edits.map((e) => ({ ...e, text: name }))]));
      await ws.applyFileEdits(byFile);
      if (renameFile && plan.file) await ws.renameItem(plan.file, `${name}.php`);
      ws.setStatus(`Renamed ${what} → ${name}: ${count} ${count === 1 ? 'usage' : 'usages'} in ${files.size} ${files.size === 1 ? 'file' : 'files'}`);
      onClose();
    } catch (e) {
      ws.notify({ title: 'Rename failed', body: String(e instanceof Error ? e.message : e), tone: 'error' });
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="jb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        style={{ width: 460 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') void run();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="jb-dialog-title" id="rename-title">
          Rename
        </div>
        <div className="jb-dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label htmlFor="rename-to">
            Rename {what} and its usages to:
          </label>
          <div className={'field' + (name && !validName(name) ? ' invalid' : '')}>
            {plan.kind === 'variable' || plan.kind === 'property' ? <span className="muted" style={{ paddingLeft: 6 }}>$</span> : null}
            <input id="rename-to" ref={input} value={name} spellCheck={false} onChange={(e) => setName(e.target.value.replace(/^\$/, ''))} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {count} {count === 1 ? 'usage' : 'usages'} in {files.size} {files.size === 1 ? 'file' : 'files'}
            {extraDeclarations > 0 && ` · also renames ${extraDeclarations} ${extraDeclarations === 1 ? 'override or implementation' : 'overrides and implementations'}`}
          </div>
          {plan.dynamic.length > 0 && (
            <label className="settings-check">
              <input type="checkbox" className="checkbox" checked={dynamic} onChange={(e) => setDynamic(e.target.checked)} />
              Also rename {plan.dynamic.length} dynamic {plan.dynamic.length === 1 ? 'usage' : 'usages'} (called on values of unknown type: may be another class's {plan.oldName})
            </label>
          )}
          {plan.file && (
            <label className="settings-check">
              <input type="checkbox" className="checkbox" checked={renameFile} onChange={(e) => setRenameFile(e.target.checked)} />
              Rename file {baseName(plan.file)} → {name}.php
            </label>
          )}
        </div>
        <div className="jb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void run()} disabled={!valid || busy}>
            {busy ? 'Renaming…' : 'Refactor'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Project tree ▸ Refactor ▸ Rename… (Shift+F6).

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { structureOf } from '../php';
import { symbols } from '../symbols';

export function RenameDialog({ ws, path, isDir, onClose, onRenamed }: { ws: Workspace; path: string; isDir: boolean; onClose: () => void; onRenamed: (to: string) => void }) {
  const old = baseName(path);
  const [name, setName] = useState(old);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The class declared in this file when it has the file's name (User.php → class User). */
  const [className, setClassName] = useState<string | null>(null);
  const [renameClass, setRenameClass] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  // The class's usages come from the symbol index (desktop) or a running language server.
  const lspReady = ws.lspStatus.state === 'ready' || symbols.rust;

  useEffect(() => {
    // Select the name without the extension, like PhpStorm.
    const el = input.current;
    if (el) {
      el.focus();
      const dot = old.lastIndexOf('.');
      el.setSelectionRange(0, isDir || dot <= 0 ? old.length : dot);
    }
    if (!isDir && old.endsWith('.php')) {
      const text = ws.liveTextOf(path);
      (text !== undefined ? Promise.resolve(text) : ws.backend.readFile(path))
        .then((src) => {
          const cls = structureOf(src).find((s) => s.depth === 0 && s.kind !== 'function');
          if (cls && cls.name === old.replace(/\.php$/, '')) setClassName(cls.name);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newStem = name.trim().replace(/\.php$/, '');
  const willRenameClass = !!className && renameClass && lspReady && name.trim().endsWith('.php') && newStem !== className && /^[A-Za-z_]\w*$/.test(newStem);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === old) return onClose();
    if (/[\\/:*?"<>|]/.test(trimmed) || trimmed === '.' || trimmed === '..') return setError('A name can’t contain \\ / : * ? " < > |');
    setBusy(true);
    try {
      const to = await ws.renameItem(path, trimmed, willRenameClass ? { from: className!, to: newStem } : undefined);
      onRenamed(to);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
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
        style={{ width: 420 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter') submit();
        }}
      >
        <div className="jb-dialog-title" id="rename-title">
          Rename {isDir ? 'Directory' : 'File'}
        </div>
        <div className="jb-dialog-body">
          <span className="muted" style={{ fontSize: 12 }}>
            {relativePath(ws.backend, path)}
          </span>
          <label htmlFor="rename-name">New name:</label>
          <div className={'field' + (error ? ' invalid' : '')}>
            <input
              id="rename-name"
              ref={input}
              value={name}
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
            />
          </div>
          {className && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, color: lspReady ? undefined : 'var(--muted)' }}>
              <input type="checkbox" className="checkbox" checked={renameClass && lspReady} disabled={!lspReady} onChange={(e) => setRenameClass(e.target.checked)} />
              Rename class '{className}' and update its usages
            </label>
          )}
          {className && !lspReady && <span className="muted" style={{ fontSize: 12 }}>Needs the desktop app or a running language server.</span>}
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="jb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy}>
            Refactor
          </button>
        </div>
      </div>
    </div>
  );
}

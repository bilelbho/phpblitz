// Bookmark popups: "Add Mnemonic Bookmark" (Ctrl+F11), a grid of 0-9 and A-Z with
// an optional description, and "Bookmarks" (Shift+F11), every bookmark in the project.

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { bookmarks, MNEMONICS, useBookmarks, type Bookmark } from '../bookmarks';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

/** Picks a mnemonic for the bookmark on `line` (typing the character picks it too). */
export function MnemonicDialog({ path, line, onClose }: { path: string; line: number; onClose: () => void }) {
  const all = useBookmarks();
  const current = bookmarks.at(path, line);
  const [picked, setPicked] = useState(current?.mnemonic ?? MNEMONICS.find((m) => !bookmarks.byMnemonic(m)) ?? '1');
  const [description, setDescription] = useState(current?.description ?? '');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);

  const ok = (m = picked) => {
    bookmarks.set({ path, line, mnemonic: m, description: description.trim() || undefined });
    onClose();
  };
  const usedBy = (m: string) => all.find((b) => b.mnemonic === m && !(b.path === path && b.line === line));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        className="pb-dialog mnemonic-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add Mnemonic Bookmark"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') ok();
          else if ((e.target as HTMLElement).tagName !== 'INPUT' && e.key.length === 1 && MNEMONICS.includes(e.key.toUpperCase())) ok(e.key.toUpperCase());
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="pb-dialog-title">Add Mnemonic Bookmark</div>
        <div className="pb-dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="mnemonic-grid" role="radiogroup" aria-label="Mnemonic">
            {MNEMONICS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={m === picked}
                className={'mnemonic-key' + (m === picked ? ' picked' : '') + (usedBy(m) ? ' used' : '')}
                title={usedBy(m) ? `Used in ${baseName(usedBy(m)!.path)}:${usedBy(m)!.line}; picking it moves it here` : undefined}
                onClick={() => setPicked(m)}
                onDoubleClick={() => ok(m)}
              >
                {m}
              </button>
            ))}
          </div>
          <label htmlFor="bookmark-description">Description:</label>
          <div className="field">
            <input id="bookmark-description" value={description} spellCheck={false} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            Type a digit or letter to pick it. Ctrl+{'<digit>'} jumps to a digit bookmark.
          </span>
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => ok()}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shift+F11: every bookmark in the project. Enter opens one, Delete removes it. */
export function BookmarksPopup({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const all = useBookmarks();
  // Mnemonic bookmarks first (in 1-9, 0, A-Z order), then the others by file and line.
  const rank = (b: Bookmark) => (b.mnemonic ? MNEMONICS.indexOf(b.mnemonic) : MNEMONICS.length);
  const list = [...all].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line);
  const [selected, setSelected] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => setSelected((i) => Math.min(i, Math.max(0, list.length - 1))), [list.length]);

  const open = (b: Bookmark) => {
    onClose();
    ws.openFile(b.path, { line: b.line });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        className="pb-popup"
        role="dialog"
        aria-label="Bookmarks"
        style={{ marginTop: '12vh', alignSelf: 'flex-start' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') setSelected((i) => Math.min(i + 1, list.length - 1));
          else if (e.key === 'ArrowUp') setSelected((i) => Math.max(i - 1, 0));
          else if (e.key === 'Enter' && list[selected]) open(list[selected]);
          else if ((e.key === 'Delete' || e.key === 'Backspace') && list[selected]) bookmarks.remove(list[selected].path, list[selected].line);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="pb-popup-title">Bookmarks</div>
        <div className="pb-popup-list" role="listbox">
          {!list.length && <div className="empty">No bookmarks. Press F11 on a line to add one, or Ctrl+F11 for one with a mnemonic.</div>}
          {list.map((b, i) => (
            <div
              key={`${b.path}:${b.line}`}
              role="option"
              aria-selected={i === selected}
              className={'row bookmark-row' + (i === selected ? ' selected' : '')}
              onMouseMove={() => setSelected(i)}
              onClick={() => open(b)}
              title={relativePath(ws.backend, b.path)}
            >
              <span className="bookmark-badge">{b.mnemonic ?? <Icon name="bookmark" size={12} />}</span>
              <FileIcon path={b.path} size={14} />
              <span className="name">
                {baseName(b.path)}:{b.line}
              </span>
              {b.description && <span className="detail">{b.description}</span>}
              <span className="grow" />
              <button
                type="button"
                className="icon-btn small"
                title="Remove Bookmark (Delete)"
                aria-label="Remove bookmark"
                onClick={(e) => {
                  e.stopPropagation();
                  bookmarks.remove(b.path, b.line);
                }}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

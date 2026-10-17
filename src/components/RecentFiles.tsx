// Recent Files (Ctrl+E), like PhpStorm's: tool windows with their shortcuts on the left, recently
// opened files on the right (previous file preselected, so Ctrl+E, Enter switches back), typing
// filters, Ctrl+E again shows edited files only, the selected file's path at the bottom.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { useDirMarks } from '../dirMarks';
import { FileIcon } from './FileIcon';
import { Icon, type IconName } from './Icon';

interface ToolEntry {
  label: string;
  icon: IconName;
  shortcut?: string;
  run: (ws: Workspace) => void;
}

/** Tool windows, with the shortcuts WorkspaceView binds (TOOL_SHORTCUTS). */
export const TOOL_WINDOWS: ToolEntry[] = [
  { label: 'Commit', icon: 'commit', shortcut: 'Alt+0', run: (ws) => ws.showLeft('commit') },
  { label: 'Project', icon: 'folder', shortcut: 'Alt+1', run: (ws) => ws.showLeft('project') },
  { label: 'Terminal', icon: 'terminal', shortcut: 'Alt+F12', run: (ws) => ws.showBottom('terminal') },
  { label: 'Database', icon: 'database', run: (ws) => ws.showLeft('database') },
  { label: 'Structure', icon: 'structure', shortcut: 'Alt+7', run: (ws) => ws.showLeft('structure') },
  { label: 'Problems', icon: 'error', shortcut: 'Alt+6', run: (ws) => ws.showBottom('problems') },
  { label: 'Git', icon: 'git', shortcut: 'Alt+9', run: (ws) => ws.showBottom('git') },
  { label: 'TODO', icon: 'todo', run: (ws) => ws.showBottom('todo') },
  { label: 'Run', icon: 'run', shortcut: 'Alt+4', run: (ws) => ws.showBottom('tests') },
  { label: 'AI Assistant', icon: 'sparkle', run: (ws) => ws.setRightTool('ai') },
  { label: 'Endpoints', icon: 'route', run: (ws) => ws.setRightTool('endpoints') },
  { label: 'Composer', icon: 'box', run: (ws) => ws.setRightTool('composer') },
  { label: 'Notifications', icon: 'bell', run: (ws) => ws.setRightTool('notifications') },
];

const nativePath = (p: string) => (/^[A-Za-z]:\//.test(p) ? p.replace(/\//g, '\\') : p);

export function RecentFiles({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const marks = useDirMarks();
  const [editedOnly, setEditedOnly] = useState(false);
  const [query, setQuery] = useState('');
  /** Which column has the keyboard: files (right) or tool windows (left). */
  const [column, setColumn] = useState<'files' | 'tools'>('files');
  const [fileIndex, setFileIndex] = useState(1);
  const [toolIndex, setToolIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const files = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ws.recentFiles
      .filter((p) => !editedOnly || ws.editedFiles.has(p))
      .filter((p) => !q || baseName(p).toLowerCase().includes(q));
  }, [ws.recentFiles, ws.editedFiles, editedOnly, query]);
  const tools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOL_WINDOWS.filter((t) => !q || t.label.toLowerCase().includes(q));
  }, [query]);

  // The previous file is preselected (the first one is the file you are in).
  useEffect(() => {
    setFileIndex(files.length > 1 && files[0] === ws.activePath && !query ? 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedOnly, query]);

  useEffect(() => {
    box.current?.focus();
  }, []);

  useEffect(() => {
    box.current?.querySelector('.rf-file.selected')?.scrollIntoView({ block: 'nearest' });
  }, [fileIndex]);

  /** Same name in several folders: show the folder, like ".gitignore  migrations". */
  const dupes = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of ws.recentFiles) count.set(baseName(p), (count.get(baseName(p)) ?? 0) + 1);
    return count;
  }, [ws.recentFiles]);

  const openFile = (path: string) => {
    onClose();
    ws.openFile(path);
  };
  const openTool = (t: ToolEntry) => {
    onClose();
    t.run(ws);
  };

  const selected = column === 'files' ? files[Math.min(fileIndex, files.length - 1)] : undefined;

  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else onClose();
    } else if (ctrl && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setEditedOnly((v) => !v);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      if (column === 'files') setFileIndex((i) => Math.max(0, Math.min(files.length - 1, i + d)));
      else setToolIndex((i) => Math.max(0, Math.min(tools.length - 1, i + d)));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') {
      e.preventDefault();
      setColumn((c) => (e.key === 'ArrowLeft' ? 'tools' : e.key === 'ArrowRight' ? 'files' : c === 'files' ? 'tools' : 'files'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (column === 'files' && selected) openFile(selected);
      else if (column === 'tools' && tools[toolIndex]) openTool(tools[toolIndex]);
    } else if (e.key === 'Delete' && column === 'files' && selected) {
      e.preventDefault();
      ws.forgetRecent(selected);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      setQuery((q) => q.slice(0, -1));
    } else if (e.key.length === 1 && !ctrl && !e.altKey) {
      // Speed search, like PhpStorm: just type.
      e.preventDefault();
      setQuery((q) => q + e.key);
    }
  };

  const footerPath = selected;
  const footerDir = footerPath ? footerPath.slice(0, footerPath.lastIndexOf('/')) : '';

  return (
    <div className="modal-backdrop clear" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="recent-files" role="dialog" aria-label="Recent Files" tabIndex={-1} onKeyDown={onKey}>
        <div className="rf-head">
          <span className="rf-title">{editedOnly ? 'Recently Edited Files' : 'Recent Files'}</span>
          {query && (
            <span className="rf-query">
              <Icon name="search" size={12} /> {query}
            </span>
          )}
          <span className="grow" />
          <label className="settings-check rf-edited">
            <input type="checkbox" className="checkbox" checked={editedOnly} onChange={(e) => setEditedOnly(e.target.checked)} />
            Show edited only <span className="muted">Ctrl+E</span>
          </label>
        </div>
        <div className="rf-body">
          <div className="rf-tools" role="listbox" aria-label="Tool windows">
            {tools.map((t, i) => (
              <div
                key={t.label}
                role="option"
                aria-selected={column === 'tools' && i === toolIndex}
                className={'rf-tool' + (column === 'tools' && i === toolIndex ? ' selected' : '')}
                onMouseEnter={() => {
                  setColumn('tools');
                  setToolIndex(i);
                }}
                onClick={() => openTool(t)}
              >
                <Icon name={t.icon} size={15} />
                <span className="grow">{t.label}</span>
                {t.shortcut && <span className="shortcut">{t.shortcut}</span>}
              </div>
            ))}
          </div>
          <div className="rf-files" role="listbox" aria-label="Recent files">
            {files.map((p, i) => {
              const color = marks.colorOf(p);
              const dir = relativePath(ws.backend, p).split('/').slice(0, -1);
              return (
                <div
                  key={p}
                  role="option"
                  aria-selected={column === 'files' && i === fileIndex}
                  className={'rf-file' + (column === 'files' && i === fileIndex ? ' selected' : '') + (color ? ` file-color-${color}` : '')}
                  onMouseEnter={() => {
                    setColumn('files');
                    setFileIndex(i);
                  }}
                  onClick={() => openFile(p)}
                >
                  <FileIcon path={p} />
                  <span className={'rf-name' + (ws.git?.changes.some((c) => c.path === p) ? ` status-${ws.git!.changes.find((c) => c.path === p)!.status}` : '')}>{baseName(p)}</span>
                  {(dupes.get(baseName(p)) ?? 0) > 1 && dir.length > 0 && <span className="muted rf-dir">{dir[dir.length - 1]}</span>}
                  {ws.dirty.has(p) && <span className="dirty-mark">*</span>}
                  <span className="grow" />
                  <button
                    type="button"
                    className="icon-btn small rf-remove"
                    title="Remove from Recent Files (Delete)"
                    aria-label={`Remove ${baseName(p)} from recent files`}
                    onClick={(e) => {
                      e.stopPropagation();
                      ws.forgetRecent(p);
                    }}
                  >
                    <Icon name="close" size={9} strokeWidth={2.5} />
                  </button>
                </div>
              );
            })}
            {!files.length && <div className="muted rf-empty">{editedOnly ? 'No files edited in this session.' : query ? 'Nothing matches.' : 'No recent files yet.'}</div>}
          </div>
        </div>
        <div className="rf-foot" title={footerPath ? nativePath(footerPath) : undefined}>
          {footerPath ? (ws.backend.kind === 'disk' ? nativePath(footerDir) : footerDir === ws.backend.root ? ws.backend.name : relativePath(ws.backend, footerDir)) : ' '}
        </div>
      </div>
    </div>
  );
}

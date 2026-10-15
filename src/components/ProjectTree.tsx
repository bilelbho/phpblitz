// The Project tool window, modeled on PhpStorm's: header with view switcher, New,
// Expand/Collapse and ⋮ options; a tree with selection, keyboard navigation and speed search.

import { gitSubmenu } from '../editorMenu';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Entry } from '../backend/types';
import { baseName, relativePath } from '../backend/types';
import { useTreePrefs, type TreePrefs } from '../treePrefs';
import { Badge, Icon, fileBadge } from './Icon';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { NewItemDialog, type NewKind } from './NewItemDialog';
import { RenameDialog } from './RenameDialog';
import { copyText } from '../editorMenu';
import { confirmDialog, isTauri } from '../platform';
import { invoke } from '@tauri-apps/api/core';

const HINTS: Record<string, string> = { vendor: 'library root', node_modules: 'library root' };
const VIEW_LABELS: Record<TreePrefs['view'], string> = { project: 'Project', open: 'Open Files', changed: 'Changed Files' };

interface Row {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  root?: boolean;
  /** Folder shown next to the name in the flat views. */
  detail?: string;
}

function sortEntries(entries: Entry[], prefs: TreePrefs): Entry[] {
  const ext = (n: string) => (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '');
  return [...entries].sort((a, b) => {
    if (prefs.foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (prefs.sortBy === 'modified') return (b.modified ?? 0) - (a.modified ?? 0) || a.name.localeCompare(b.name);
    if (prefs.sortBy === 'type') return ext(a.name).localeCompare(ext(b.name)) || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function ProjectTree({ ws, onHide }: { ws: Workspace; onHide: () => void }) {
  const { backend } = ws;
  const [prefs, setPrefs] = useTreePrefs();
  const [selected, setSelectedState] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const setSelected = (v: string | null) => {
    selectedRef.current = v;
    setSelectedState(v);
  };
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [speed, setSpeedState] = useState<string | null>(null);
  // Keys can arrive faster than React re-renders: keep the query in a ref too.
  const speedRef = useRef<string | null>(null);
  const setSpeed = (v: string | null) => {
    speedRef.current = v;
    setSpeedState(v);
  };
  const [dialog, setDialog] = useState<{ kind: NewKind; dir: string } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; isDir: boolean } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const statusOf = useMemo(() => new Map(ws.git?.changes.map((c) => [c.path, c.status]) ?? []), [ws.git]);

  // Behavior ▸ Always Select Opened File: expand the folders down to the active file and select it.
  useEffect(() => {
    const path = ws.activePath;
    if (!prefs.alwaysSelect || !path) return;
    setSelected(path);
    if (prefs.view === 'project') ws.revealInTree(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.activePath, prefs.alwaysSelect, prefs.view]);

  const rows: Row[] = useMemo(() => {
    if (prefs.view === 'open') {
      return ws.tabs.flatMap((t) => (t.kind === 'file' ? [{ path: t.path, name: baseName(t.path), isDir: false, depth: 0, detail: dirOf(ws, t.path) }] : []));
    }
    if (prefs.view === 'changed') {
      return (ws.git?.changes ?? []).map((c) => ({ path: c.path, name: baseName(c.path), isDir: false, depth: 0, detail: dirOf(ws, c.path) }));
    }
    const out: Row[] = [{ path: backend.root, name: backend.name, isDir: true, depth: 0, root: true }];
    const walk = (dir: string, depth: number) => {
      for (const e of sortEntries(ws.children[dir] ?? [], prefs)) {
        out.push({ path: e.path, name: e.name, isDir: e.isDir, depth });
        if (e.isDir && ws.expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    if (ws.expanded.has(backend.root)) walk(backend.root, 1);
    return out;
  }, [prefs, ws.tabs, ws.git, ws.children, ws.expanded, backend, ws]);

  // Keep the selection visible.
  useEffect(() => {
    if (!selected) return;
    const el = body.current?.querySelector(`[data-path="${CSS.escape(selected)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows]);

  const index = rows.findIndex((r) => r.path === selected);

  const open = (row: Row, how: 'single' | 'double' | 'enter') => {
    if (row.isDir) {
      if (how !== 'single' || prefs.singleClickDirs) ws.toggleDir(row.path);
      return;
    }
    if (how === 'single') {
      if (prefs.previewTab) ws.openFile(row.path, undefined, { preview: true });
      else if (prefs.singleClickOpen) ws.openFile(row.path);
      return;
    }
    ws.openFile(row.path);
  };

  /** Speed search: the first row at or after `from` whose name contains the query. */
  const findRow = (query: string, from: number) => {
    const q = query.toLowerCase();
    for (let k = 0; k < rows.length; k++) {
      const r = rows[(from + k) % rows.length];
      if (r.name.toLowerCase().includes(q)) return r;
    }
    return undefined;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const speed = speedRef.current;
    const index = rows.findIndex((r) => r.path === selectedRef.current);
    const row = rows[index];
    const move = (i: number) => rows[i] && setSelected(rows[i].path);
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      setSpeed('');
      return;
    }
    // File operations on the selected row, with PhpStorm's keys.
    if (row && !speed) {
      const k = e.key.toLowerCase();
      if (e.key === 'Delete') {
        e.preventDefault();
        deleteRow(row);
        return;
      }
      if (e.key === 'F6' && e.shiftKey && !row.root) {
        e.preventDefault();
        setRenaming({ path: row.path, isDir: row.isDir });
        return;
      }
      if (ctrl && e.shiftKey && k === 'c') {
        e.preventDefault();
        copyText(ws, row.path, 'path');
        return;
      }
      if (ctrl && !e.shiftKey && (k === 'c' || k === 'x') && !row.root) {
        e.preventDefault();
        ws.setFileClipboard({ mode: k === 'c' ? 'copy' : 'cut', paths: [row.path] });
        ws.setStatus(`${k === 'c' ? 'Copied' : 'Cut'} ${row.name}. Paste into a folder with Ctrl+V`);
        return;
      }
      if (ctrl && !e.shiftKey && k === 'v' && ws.fileClipboard) {
        e.preventDefault();
        paste(row);
        return;
      }
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (speed) {
          const next = findRow(speed, index + 1);
          if (next) setSelected(next.path);
        } else move(Math.min(index + 1, rows.length - 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(Math.max(index - 1, 0));
        return;
      case 'Home':
        e.preventDefault();
        move(0);
        return;
      case 'End':
        e.preventDefault();
        move(rows.length - 1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (row?.isDir && prefs.view === 'project') {
          if (!ws.expanded.has(row.path)) ws.toggleDir(row.path);
          else move(index + 1);
        }
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (row?.isDir && ws.expanded.has(row.path) && prefs.view === 'project') ws.toggleDir(row.path);
        else if (row && !row.root) {
          const parent = row.path.slice(0, row.path.lastIndexOf('/'));
          if (rows.some((r) => r.path === parent)) setSelected(parent);
        }
        return;
      case 'Enter':
      case 'F4':
        e.preventDefault();
        if (row) open(row, 'enter');
        setSpeed(null);
        return;
      case 'Escape':
        if (speed !== null) {
          e.preventDefault();
          e.stopPropagation();
          setSpeed(null);
        }
        return;
      case 'Backspace':
        if (speed) {
          e.preventDefault();
          setSpeed(speed.slice(0, -1));
        }
        return;
    }
    // Any printable character starts or extends the speed search, like PhpStorm.
    if (e.key.length === 1 && !ctrl && !e.altKey && (speed !== null || e.key !== ' ')) {
      e.preventDefault();
      const q = (speed ?? '') + e.key;
      setSpeed(q);
      const hit = findRow(q, Math.max(index, 0));
      if (hit) setSelected(hit.path);
    }
  };

  // ── Header menus ──
  const menuAt = (e: React.MouseEvent, items: ContextItem[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  /** Where "+ New" creates things: the selected folder, or the selected file's folder. */
  const targetDir = () => {
    const row = rows[index];
    if (prefs.view !== 'project' || !row) return backend.root;
    return row.isDir ? row.path : row.path.slice(0, row.path.lastIndexOf('/'));
  };

  const viewMenu: ContextItem[] = (['project', 'open', 'changed'] as const).map((v) => ({
    label: VIEW_LABELS[v],
    checked: prefs.view === v,
    disabled: v === 'changed' && !ws.git,
    run: () => setPrefs({ view: v }),
  }));

  const newMenu = (): ContextItem[] => [
    { label: 'File', icon: 'newFile', run: () => setDialog({ kind: 'file', dir: targetDir() }) },
    { label: 'PHP Class', icon: 'code', run: () => setDialog({ kind: 'class', dir: targetDir() }) },
    { label: 'Directory', icon: 'folder', run: () => setDialog({ kind: 'dir', dir: targetDir() }) },
  ];

  const toggle = (key: keyof TreePrefs, label: string): ContextItem => ({ label, checked: !!prefs[key], run: () => setPrefs({ [key]: !prefs[key] }) });
  const optionsMenu: ContextItem[] = [
    {
      label: 'Behavior',
      submenu: [
        toggle('previewTab', 'Enable Preview Tab'),
        toggle('singleClickOpen', 'Open Files with Single Click'),
        toggle('singleClickDirs', 'Open Directories with Single Click'),
        toggle('alwaysSelect', 'Always Select Opened File'),
      ],
    },
    { label: 'Appearance', submenu: [toggle('foldersFirst', 'Folders Always on Top'), toggle('showPath', 'Show Project Path')] },
    {
      label: 'Sort By',
      submenu: [
        { label: 'Name', checked: prefs.sortBy === 'name', run: () => setPrefs({ sortBy: 'name' }) },
        { label: 'Type', checked: prefs.sortBy === 'type', run: () => setPrefs({ sortBy: 'type' }) },
        { label: 'Modification Time', checked: prefs.sortBy === 'modified', run: () => setPrefs({ sortBy: 'modified' }) },
      ],
    },
    { kind: 'sep' },
    {
      label: 'Speed Search',
      icon: 'search',
      shortcut: 'Ctrl+F or any symbol',
      run: () => {
        body.current?.focus();
        setSpeed('');
      },
    },
    { label: 'Select Opened File', icon: 'target', disabled: !ws.activePath, run: () => selectOpened() },
    { kind: 'sep' },
    { label: 'Expand Selected', icon: 'expandAll', disabled: prefs.view !== 'project', run: () => expandSelected() },
    { label: 'Collapse All', icon: 'collapseAll', disabled: prefs.view !== 'project', run: ws.collapseAll },
  ];

  const selectOpened = () => {
    const path = ws.activePath;
    if (!path) return;
    if (prefs.view !== 'project') setPrefs({ view: 'project' });
    ws.revealInTree(path);
    setSelected(path);
    body.current?.focus();
  };

  const expandSelected = () => {
    const row = rows[index];
    ws.expandRecursively(row?.isDir ? row.path : backend.root);
  };

  // ── Right-click menu and file operations ──
  const dirOfRow = (row: Row) => (row.isDir ? row.path : row.path.slice(0, row.path.lastIndexOf('/')));

  const deleteRow = async (row: Row) => {
    if (row.root) return;
    const unsaved = [...ws.dirty].filter((p) => p === row.path || p.startsWith(row.path + '/'));
    const what = row.isDir ? `the folder "${row.name}" and everything in it` : `"${row.name}"`;
    const bin = backend.kind === 'disk' ? ' It goes to the Recycle Bin, so you can restore it.' : '';
    const lost = unsaved.length ? ` Unsaved changes in ${unsaved.length} open file${unsaved.length === 1 ? '' : 's'} will be lost.` : '';
    if (!(await confirmDialog(`Delete ${what}?${bin}${lost}`))) return;
    try {
      await ws.deleteItems([row.path]);
      setSelected(row.path.slice(0, row.path.lastIndexOf('/')));
    } catch (e) {
      ws.notify({ title: `Could not delete ${row.name}`, body: String(e), tone: 'error' });
    }
    body.current?.focus();
  };

  const paste = async (row: Row) => {
    const pasted = await ws.pasteInto(dirOfRow(row));
    if (pasted?.length) {
      await ws.revealInTree(pasted[0]);
      setSelected(pasted[0]);
    }
    body.current?.focus();
  };

  const rowMenu = (row: Row): ContextItem[] => {
    const dir = dirOfRow(row);
    const rel = relativePath(backend, row.path);
    const disk = backend.kind === 'disk';
    return [
      {
        label: 'New',
        submenu: [
          { label: 'File', icon: 'newFile', run: () => setDialog({ kind: 'file', dir }) },
          { label: 'PHP Class', icon: 'code', run: () => setDialog({ kind: 'class', dir }) },
          { label: 'Directory', icon: 'folder', run: () => setDialog({ kind: 'dir', dir }) },
        ],
      },
      { kind: 'sep' },
      { label: 'Cut', shortcut: 'Ctrl+X', icon: 'cut', disabled: row.root, run: () => ws.setFileClipboard({ mode: 'cut', paths: [row.path] }) },
      { label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', disabled: row.root, run: () => ws.setFileClipboard({ mode: 'copy', paths: [row.path] }) },
      { label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', disabled: !ws.fileClipboard, run: () => paste(row) },
      {
        label: 'Copy Path/Reference…',
        submenu: [
          { label: 'Absolute Path', shortcut: 'Ctrl+Shift+C', run: () => copyText(ws, row.path, 'path') },
          { label: 'Path From Content Root', disabled: row.root, run: () => copyText(ws, rel, 'path') },
          { label: row.isDir ? 'Directory Name' : 'File Name', run: () => copyText(ws, row.name, 'name') },
        ],
      },
      { kind: 'sep' },
      { label: 'Find in Files…', shortcut: 'Ctrl+Shift+F', icon: 'search', run: () => ws.openFindInFiles('find', '', row.root ? undefined : dir) },
      { label: 'Replace in Files…', shortcut: 'Ctrl+Shift+R', run: () => ws.openFindInFiles('replace', '', row.root ? undefined : dir) },
      { kind: 'sep' },
      { label: 'Refactor', icon: 'pencil', submenu: [{ label: 'Rename…', shortcut: 'Shift+F6', disabled: row.root, run: () => setRenaming({ path: row.path, isDir: row.isDir }) }] },
      { label: 'Delete…', shortcut: 'Delete', disabled: row.root, run: () => deleteRow(row) },
      { kind: 'sep' },
      {
        label: 'Open In',
        icon: 'folderOpen',
        submenu: [
          { label: 'Explorer', icon: 'explorer', disabled: !disk || !isTauri, run: () => invoke('reveal_in_explorer', { path: row.path }).catch((e) => ws.notify({ title: 'Could not open Explorer', body: String(e), tone: 'error' })) },
          { label: 'Terminal', icon: 'terminal', run: () => ws.openTerminalAt(dir) },
        ],
      },
      { label: 'Reload from Disk', icon: 'refresh', run: () => ws.reloadItem(row.path, row.isDir) },
      ...(ws.git ? [{ kind: 'sep' as const }, { label: 'Git', icon: 'git' as const, submenu: gitSubmenu(ws, row.path, row.isDir) }] : []),
    ];
  };

  const openRowMenu = (e: React.MouseEvent, row: Row) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(row.path);
    setSpeed(null);
    body.current?.focus();
    setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(row) });
  };

  const created = async (path: string) => {
    const isDir = dialog?.kind === 'dir'; // read before awaiting: the dialog closes meanwhile
    const parent = path.slice(0, path.lastIndexOf('/'));
    await ws.revealInTree(path);
    await ws.loadDir(parent);
    setSelected(path);
    if (isDir) ws.toggleDir(path);
    else ws.openFile(path);
    body.current?.focus();
  };

  // ── Rendering ──
  const renderName = (name: string) => {
    if (!speed) return name;
    const i = name.toLowerCase().indexOf(speed.toLowerCase());
    if (i < 0) return name;
    return (
      <>
        {name.slice(0, i)}
        <mark className="speed-hit">{name.slice(i, i + speed.length)}</mark>
        {name.slice(i + speed.length)}
      </>
    );
  };

  const items: ReactNode[] = rows.map((row) => {
    const isSelected = row.path === selected;
    const status = !row.isDir ? statusOf.get(row.path) : undefined;
    const open_ = row.isDir && (row.root ? ws.expanded.has(backend.root) : ws.expanded.has(row.path));
    const badge = row.isDir ? null : fileBadge(row.path);
    return (
      <div
        key={row.path}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={row.isDir && prefs.view === 'project' ? open_ : undefined}
        aria-level={row.depth + 1}
        data-path={row.path}
        className={'row' + (isSelected ? ' selected' : '') + (ws.fileClipboard?.mode === 'cut' && ws.fileClipboard.paths.includes(row.path) ? ' cut' : '')}
        style={{ paddingLeft: 4 + row.depth * 18 }}
        onContextMenu={(e) => openRowMenu(e, row)}
        title={row.root ? backend.root : relativePath(backend, row.path)}
        onMouseDown={() => {
          setSelected(row.path);
          setSpeed(null);
        }}
        onClick={() => open(row, 'single')}
        onDoubleClick={() => open(row, 'double')}
      >
        {row.isDir && prefs.view === 'project' ? (
          <span
            className={'chev' + (open_ ? ' open' : '')}
            onClick={(e) => {
              e.stopPropagation();
              ws.toggleDir(row.path);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name="chevronRight" size={12} strokeWidth={2.5} />
          </span>
        ) : (
          <span style={{ width: 12, flex: 'none' }} />
        )}
        {row.isDir ? <Icon name="folder" size={15} className="folder-icon" /> : <Badge text={badge!.text} color={badge!.color} />}
        <span className={'name' + (status && !isSelected ? ` status-${status}` : '')} style={row.root ? { fontWeight: 600 } : undefined}>
          {renderName(row.name)}
        </span>
        {row.root && prefs.showPath && <span className="detail">{backend.kind === 'sample' ? 'sample project' : backend.root}</span>}
        {!row.root && row.depth === 1 && HINTS[row.name] && <span className="detail">{HINTS[row.name]}</span>}
        {row.detail && <span className="detail">{row.detail}</span>}
        {!row.isDir && ws.dirty.has(row.path) && <span className="detail">●</span>}
      </div>
    );
  });

  return (
    <>
      <div className="tw-head">
        <button type="button" className="tw-tab view-switch" aria-haspopup="menu" onClick={(e) => menuAt(e, viewMenu)} title="Change view">
          <span className="tw-title" style={{ padding: 0 }}>
            {VIEW_LABELS[prefs.view]}
          </span>
          <Icon name="chevronDown" size={11} strokeWidth={2.4} />
        </button>
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="New" title="New (File, PHP Class, Directory)" onClick={(e) => menuAt(e, newMenu())}>
          <Icon name="plus" size={15} />
        </button>
        {!prefs.alwaysSelect && (
          <button type="button" className="icon-btn small" aria-label="Select opened file" title="Select Opened File" onClick={selectOpened} disabled={!ws.activePath}>
            <Icon name="target" size={14} />
          </button>
        )}
        <span className="strip-sep" style={{ width: 1, height: 14, margin: '0 3px' }} />
        <button type="button" className="icon-btn small" aria-label="Expand selected" title="Expand Selected" onClick={expandSelected} disabled={prefs.view !== 'project'}>
          <Icon name="expandAll" size={14} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Collapse all" title="Collapse All" onClick={ws.collapseAll} disabled={prefs.view !== 'project'}>
          <Icon name="collapseAll" size={14} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Options" title="Options" aria-haspopup="menu" onClick={(e) => menuAt(e, optionsMenu)}>
          <Icon name="more" size={15} strokeWidth={3} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Hide Project" title="Hide" onClick={onHide}>
          <Icon name="minus" size={14} />
        </button>
      </div>
      <div ref={body} className="panel-body tree project-tree" role="tree" aria-label={VIEW_LABELS[prefs.view]} tabIndex={0} onKeyDown={onKeyDown}>
        {items}
        {prefs.view === 'open' && !rows.length && <div className="empty">No files are open.</div>}
        {prefs.view === 'changed' && !rows.length && <div className="empty">No changed files.</div>}
      </div>
      {speed !== null && (
        <div className="speed-search" role="status">
          <Icon name="search" size={12} />
          {speed || <span className="muted">Search for:</span>}
          {speed && !findRow(speed, 0) && <span style={{ color: '#f0787f' }}>no matches</span>}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && <NewItemDialog ws={ws} kind={dialog.kind} dir={dialog.dir} onClose={() => setDialog(null)} onCreated={created} />}
      {renaming && (
        <RenameDialog
          ws={ws}
          path={renaming.path}
          isDir={renaming.isDir}
          onClose={() => {
            setRenaming(null);
            body.current?.focus();
          }}
          onRenamed={(to) => setSelected(to)}
        />
      )}
    </>
  );
}

function dirOf(ws: Workspace, path: string) {
  return relativePath(ws.backend, path).split('/').slice(0, -1).join('/');
}

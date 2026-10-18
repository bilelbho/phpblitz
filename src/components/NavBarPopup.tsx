// Popups of the status bar's navigation bar (breadcrumbs): a folder's contents
// (folders open another column to the right, files open), or a class's members (jump to one).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Entry } from '../backend/types';
import type { PhpSymbol } from '../php';
import { useDirMarks } from '../dirMarks';
import { FileIcon } from './FileIcon';
import { Icon, Sym, Visibility } from './Icon';
import { SYMBOL_KIND } from './StructurePanel';

export type NavRequest =
  | { kind: 'dir'; path: string; selected?: string; anchor: DOMRect }
  | { kind: 'members'; path: string; selected?: number; anchor: DOMRect };

interface Item {
  key: string;
  label: string;
  icon: ReactNode;
  detail?: ReactNode;
  /** Folders open a column to the right. */
  dir?: string;
  run?: () => void;
  muted?: boolean;
}

export function NavBarPopup({ ws, request, onClose }: { ws: Workspace; request: NavRequest; onClose: () => void }) {
  /** Columns: the first from the crumb, then one per folder opened from it. */
  const [columns, setColumns] = useState<{ path: string; selected?: string }[]>(request.kind === 'dir' ? [{ path: request.path, selected: request.selected }] : []);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', outside, true);
    return () => window.removeEventListener('mousedown', outside, true);
  }, [onClose]);

  const openFile = (path: string) => {
    onClose();
    ws.openFile(path);
  };

  return (
    <div ref={box} className="navbar-popups" style={{ left: request.anchor.left, bottom: window.innerHeight - request.anchor.top + 4 }}>
      {request.kind === 'members' ? (
        <MemberColumn ws={ws} path={request.path} selected={request.selected} onClose={onClose} />
      ) : (
        columns.map((c, i) => (
          <DirColumn
            key={c.path}
            ws={ws}
            path={c.path}
            selected={c.selected}
            focused={i === columns.length - 1}
            onOpenDir={(dir) => setColumns((cols) => [...cols.slice(0, i + 1), { path: dir }])}
            onBack={i > 0 ? () => setColumns((cols) => cols.slice(0, i)) : undefined}
            onOpenFile={openFile}
            onClose={onClose}
          />
        ))
      )}
    </div>
  );
}

function DirColumn({
  ws,
  path,
  selected,
  focused,
  onOpenDir,
  onBack,
  onOpenFile,
  onClose,
}: {
  ws: Workspace;
  path: string;
  selected?: string;
  focused: boolean;
  onOpenDir: (dir: string) => void;
  onBack?: () => void;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const marks = useDirMarks();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    let live = true;
    ws.backend
      .listDir(path)
      .then((list) => live && setEntries([...list].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [ws.backend, path]);

  const items: Item[] = (entries ?? []).map((e) => {
    const mark = e.isDir ? marks.markOf(e.path) : null;
    return {
      key: e.path,
      label: e.name,
      icon: e.isDir ? <Icon name="folder" size={15} className={'folder-icon' + (mark ? ` folder-${mark}` : '')} /> : <FileIcon path={e.path} />,
      dir: e.isDir ? e.path : undefined,
      run: e.isDir ? undefined : () => onOpenFile(e.path),
      muted: marks.isExcluded(e.path),
    };
  });
  return <Column items={items} loading={entries === null} selectedKey={selected} focused={focused} onOpenDir={onOpenDir} onBack={onBack} onClose={onClose} />;
}

function MemberColumn({ ws, path, selected, onClose }: { ws: Workspace; path: string; selected?: number; onClose: () => void }) {
  const members = ws.structure.filter((s) => s.depth > 0 && s.kind !== 'use');
  const items: Item[] = members.map((s: PhpSymbol) => {
    const [letter, color] = SYMBOL_KIND[s.kind];
    return {
      key: String(s.line),
      label: s.name,
      icon: (
        <span className="nav-sym">
          <Sym letter={letter} color={color} />
          <Visibility value={s.visibility} />
        </span>
      ),
      detail: s.isStatic ? 'static' : undefined,
      run: () => {
        onClose();
        ws.setGoto({ path, line: s.line, nonce: Date.now() });
      },
    };
  });
  return <Column items={items} loading={false} selectedKey={selected !== undefined ? String(selected) : undefined} focused onOpenDir={() => {}} onClose={onClose} empty="No members" />;
}

/** One list: keyboard (↑ ↓ Enter, → into a folder, ← back), typing filters, Escape closes. */
function Column({
  items,
  loading,
  selectedKey,
  focused,
  onOpenDir,
  onBack,
  onClose,
  empty = 'Empty folder',
}: {
  items: Item[];
  loading: boolean;
  selectedKey?: string;
  focused: boolean;
  onOpenDir: (dir: string) => void;
  onBack?: () => void;
  onClose: () => void;
  empty?: string;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const shown = query ? items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())) : items;

  // Start on the crumb's own entry (the file, or the member at the caret).
  useEffect(() => {
    const at = selectedKey ? items.findIndex((i) => i.key === selectedKey) : -1;
    if (at >= 0) setIndex(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, selectedKey]);
  useLayoutEffect(() => {
    if (focused) list.current?.focus();
  }, [focused, loading]);
  useEffect(() => {
    list.current?.querySelector('.nav-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [index, shown.length]);

  const choose = (item: Item) => {
    if (item.dir) {
      setOpenKey(item.key);
      onOpenDir(item.dir);
    } else item.run?.();
  };

  return (
    <div
      ref={list}
      className={'nav-column' + (focused ? ' focused' : '')}
      tabIndex={-1}
      role="listbox"
      onKeyDown={(e) => {
        const item = shown[Math.min(index, shown.length - 1)];
        if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, shown.length - 1));
        else if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
        else if (e.key === 'Enter' || (e.key === 'ArrowRight' && item?.dir)) item && choose(item);
        else if (e.key === 'ArrowLeft' && onBack) onBack();
        else if (e.key === 'Escape') query ? setQuery('') : onClose();
        else if (e.key === 'Backspace') setQuery((q) => q.slice(0, -1));
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          setQuery((q) => q + e.key);
          setIndex(0);
        } else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {query && (
        <div className="nav-query">
          <Icon name="search" size={11} /> {query}
        </div>
      )}
      {loading && <div className="muted nav-empty">Loading…</div>}
      {!loading && !shown.length && <div className="muted nav-empty">{query ? 'Nothing matches' : empty}</div>}
      {shown.map((item, i) => (
        <div
          key={item.key}
          role="option"
          aria-selected={i === index}
          className={'nav-item' + (i === index ? ' active' : '') + (openKey === item.key ? ' open' : '') + (item.muted ? ' muted' : '')}
          onMouseEnter={() => setIndex(i)}
          onClick={() => choose(item)}
        >
          {item.icon}
          <span className="nav-label">{item.label}</span>
          {item.detail && <span className="muted nav-detail">{item.detail}</span>}
          {item.dir && <Icon name="chevronRight" size={11} />}
        </div>
      ))}
    </div>
  );
}

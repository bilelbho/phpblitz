// The TODO tool window: every `todo` / `fixme` comment in the project (or the current file),
// grouped by folder and file, with the selected one's code in a preview on the right.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { languageOf } from '../php';
import { themeId } from '../editor/themes';
import { useSettings } from '../settings';
import { projectTodos, todosInText, type TodoItem } from '../todo';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { useHideTool } from './toolHide';

type Row =
  | { kind: 'root'; key: string; depth: number; label: string }
  | { kind: 'group'; key: string; depth: number; label: string; count: number; path?: string; dir?: boolean }
  | { kind: 'item'; key: string; depth: number; item: TodoItem };

const keyOf = (t: TodoItem) => `${t.path}:${t.line}`;

export function TodoToolWindow({ ws }: { ws: Workspace }) {
  const hide = useHideTool(() => ws.setBottomOpen(false));
  const [view, setView] = useState<'project' | 'file'>('project');
  const [projectItems, setProjectItems] = useState<TodoItem[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    try {
      const found = await projectTodos(ws);
      if (id === seq.current) {
        setProjectItems(found);
        setError('');
      }
    } catch (e) {
      if (id === seq.current) setError(String(e instanceof Error ? e.message : e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.backend, ws.files]);

  // Scan when opened, and again after saves (the set of unsaved files changes).
  const dirtyKey = [...ws.dirty].sort().join('\n');
  useEffect(() => {
    const timer = window.setTimeout(refresh, projectItems ? 800 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, dirtyKey]);

  const path = ws.activePath;
  const fileText = path ? (ws.liveTextOf(path) ?? ws.loaded[path] ?? '') : '';
  const fileItems = useMemo(() => (path ? todosInText(path, fileText) : []), [path, fileText]);
  const items = useMemo(() => (view === 'project' ? (projectItems ?? []) : fileItems), [view, projectItems, fileItems]);

  // The tree: Found … › project › folder › file › items (folders only in the Project view).
  const rows = useMemo(() => {
    const out: Row[] = [];
    const files = new Map<string, TodoItem[]>();
    for (const t of items) files.set(t.path, [...(files.get(t.path) ?? []), t]);
    const fileCount = files.size;
    out.push({ kind: 'root', key: 'root', depth: 0, label: `Found ${items.length} TODO ${items.length === 1 ? 'item' : 'items'} in ${fileCount} ${fileCount === 1 ? 'file' : 'files'}` });
    if (collapsed.has('root')) return out;
    const addFile = (file: string, list: TodoItem[], depth: number) => {
      const key = `file:${file}`;
      out.push({ kind: 'group', key, depth, label: baseName(file), count: list.length, path: file });
      if (!collapsed.has(key)) for (const t of [...list].sort((a, b) => a.line - b.line)) out.push({ kind: 'item', key: keyOf(t), depth: depth + 1, item: t });
    };
    if (view === 'file') {
      for (const [file, list] of files) addFile(file, list, 1);
      return out;
    }
    out.push({ kind: 'group', key: 'project', depth: 1, label: ws.backend.name, count: items.length });
    if (collapsed.has('project')) return out;
    const dirs = new Map<string, string[]>();
    for (const file of files.keys()) {
      const dir = relativePath(ws.backend, file).split('/').slice(0, -1).join('/');
      dirs.set(dir, [...(dirs.get(dir) ?? []), file]);
    }
    for (const [dir, list] of [...dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sorted = list.sort((a, b) => a.localeCompare(b));
      if (!dir) {
        for (const file of sorted) addFile(file, files.get(file)!, 2);
        continue;
      }
      const key = `dir:${dir}`;
      out.push({ kind: 'group', key, depth: 2, label: dir, count: sorted.reduce((n, f) => n + files.get(f)!.length, 0), dir: true });
      if (!collapsed.has(key)) for (const file of sorted) addFile(file, files.get(file)!, 3);
    }
    return out;
  }, [items, collapsed, view, ws.backend]);

  const itemRows = rows.filter((r): r is Extract<Row, { kind: 'item' }> => r.kind === 'item');
  const current = itemRows.find((r) => r.key === selected)?.item ?? null;
  const open = (t: TodoItem) => ws.openFile(t.path, { line: t.line, column: 1 });
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = itemRows.findIndex((r) => r.key === selected);
    if (e.key === 'ArrowDown') setSelected(itemRows[Math.min(i + 1, itemRows.length - 1)]?.key ?? null);
    else if (e.key === 'ArrowUp') setSelected(itemRows[Math.max(i - 1, 0)]?.key ?? null);
    else if (e.key === 'Enter' && current) open(current);
    else return;
    e.preventDefault();
  };

  useEffect(() => {
    document.querySelector('.todo-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <>
      <div className="tw-head" role="tablist">
        <span className="tw-title">TODO</span>
        {(['project', 'file'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={'tw-tab' + (view === v ? ' active' : '')} onClick={() => setView(v)}>
            {v === 'project' ? 'Project' : 'Current File'}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="icon-btn small" title="Refresh" aria-label="Refresh" onClick={() => void refresh()}>
          <Icon name="refresh" size={13} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={hide}>
          <Icon name="minus" size={14} />
        </button>
      </div>
      <div className="todo-body">
        <div className="todo-tree tree" role="tree" tabIndex={0} onKeyDown={onKeyDown}>
          {error && <div className="empty error-text">{error}</div>}
          {view === 'project' && !projectItems && !error && <div className="empty">Looking for TODO items…</div>}
          {view === 'file' && !path && <div className="empty">Open a file to see its TODO items.</div>}
          {(view === 'file' ? !!path : !!projectItems) &&
            rows.map((r) =>
              r.kind === 'item' ? (
                <div
                  key={r.key}
                  role="treeitem"
                  aria-selected={r.key === selected}
                  className={'row todo-row' + (r.key === selected ? ' selected' : '')}
                  style={{ paddingLeft: 8 + r.depth * 18 }}
                  onClick={() => setSelected(r.key)}
                  onDoubleClick={() => open(r.item)}
                  title={`${relativePath(ws.backend, r.item.path)}:${r.item.line}\nDouble-click or Enter to open`}
                >
                  <span className="todo-line">{r.item.line}</span>
                  <span className="todo-text-row">
                    {r.item.text.slice(0, r.item.start)}
                    <span className="todo-word">{r.item.text.slice(r.item.start, r.item.end)}</span>
                  </span>
                </div>
              ) : (
                <div key={r.key} role="treeitem" aria-expanded={!collapsed.has(r.key)} className="row" style={{ paddingLeft: 8 + r.depth * 18 }} onClick={() => toggle(r.key)}>
                  <Icon name={collapsed.has(r.key) ? 'chevronRight' : 'chevronDown'} size={12} />
                  {r.kind === 'group' && r.path ? <FileIcon path={r.path} size={14} /> : r.kind === 'group' ? <Icon name="folder" size={14} className="folder-icon" /> : null}
                  <span className={r.kind === 'root' ? '' : 'name'}>{r.label}</span>
                  {r.kind === 'group' && (
                    <span className="detail">
                      {r.count} {r.count === 1 ? 'item' : 'items'}
                    </span>
                  )}
                </div>
              ),
            )}
        </div>
        <div className="todo-preview">{current ? <TodoPreview ws={ws} item={current} /> : <div className="empty">Select a TODO item to see its code.</div>}</div>
      </div>
    </>
  );
}

/** The selected item's file, read-only, scrolled to it with the TODO highlighted. */
function TodoPreview({ ws, item }: { ws: Workspace; item: TodoItem }) {
  const settings = useSettings().editor;
  const [text, setText] = useState<string | null>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    const open = ws.liveTextOf(item.path);
    if (open !== undefined) setText(open);
    else
      ws.backend.readFile(item.path).then(
        (t) => live && setText(t),
        () => live && setText(''),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path]);

  useEffect(() => {
    const ed = editor.current;
    const model = ed?.getModel();
    if (!ready || !ed || !model || text === null || item.line > model.getLineCount()) return;
    const column = model.getLineContent(item.line).indexOf(item.text) + 1;
    const range = new monaco.Range(item.line, column + item.start, item.line, column + item.end);
    const deco = ed.createDecorationsCollection([{ range, options: { inlineClassName: 'todo-preview-hit' } }, { range, options: { isWholeLine: true, className: 'todo-preview-line' } }]);
    ed.revealLineInCenter(item.line);
    return () => deco.clear();
  }, [ready, text, item]);

  if (text === null) return <div className="empty">Loading…</div>;
  return (
    <Editor
      value={text}
      language={languageOf(item.path)}
      theme={themeId(settings.scheme)}
      onMount={(ed) => {
        editor.current = ed;
        setReady(true);
      }}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
        fontSize: settings.fontSize - 1,
        lineNumbersMinChars: 4,
        glyphMargin: false,
        folding: false,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        contextmenu: false,
        codeLens: false,
        stickyScroll: { enabled: false },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
        automaticLayout: true,
      }}
    />
  );
}

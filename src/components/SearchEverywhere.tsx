import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { phpIndex } from '../php';
import { editorCommands } from '../editorCommands';
import { Badge, Icon } from './Icon';

export type SearchTab = 'all' | 'classes' | 'files' | 'symbols' | 'actions';

type Kind = 'Class' | 'File' | 'Symbol' | 'Action';

interface Item {
  key: string;
  kind: Kind;
  name: string;
  detail: string;
  run: () => void;
}

const TABS: [SearchTab, string][] = [
  ['all', 'All'],
  ['classes', 'Classes'],
  ['files', 'Files'],
  ['symbols', 'Symbols'],
  ['actions', 'Actions'],
];
const TAB_KIND: Record<SearchTab, Kind | null> = { all: null, classes: 'Class', files: 'File', symbols: 'Symbol', actions: 'Action' };
const KIND_BADGE: Record<Kind, [string, string]> = {
  Class: ['C', '#5fc9be'],
  File: ['F', '#9d8cf5'],
  Symbol: ['ƒ', '#72b7f2'],
  Action: ['A', '#e3a869'],
};
const LIMIT = 80;

interface Props {
  ws: Workspace;
  initialTab: SearchTab;
  onClose: () => void;
  actions: { openFolder: () => void; closeProject: () => void };
}

export function SearchEverywhere({ ws, initialTab, onClose, actions }: Props) {
  const [tab, setTab] = useState<SearchTab>(initialTab);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  const done = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const items = useMemo(() => {
    const out: Item[] = [];
    for (const c of phpIndex.all()) {
      out.push({ key: `c:${c.path}`, kind: 'Class', name: c.name, detail: c.fqn, run: done(() => ws.openFile(c.path, { line: c.line })) });
      for (const m of c.members) {
        if (m.kind !== 'method' || m.visibility !== 'public') continue;
        out.push({
          key: `s:${c.path}:${m.line}`,
          kind: 'Symbol',
          name: `${c.name}::${m.name}()`,
          detail: m.detail,
          run: done(() => ws.openFile(c.path, { line: m.line })),
        });
      }
    }
    for (const f of ws.files) {
      const rel = relativePath(ws.backend, f);
      out.push({ key: `f:${f}`, kind: 'File', name: baseName(f), detail: rel.split('/').slice(0, -1).join('/') || '/', run: done(() => ws.openFile(f)) });
    }
    const act = (name: string, detail: string, run: () => void) => out.push({ key: `a:${name}`, kind: 'Action', name, detail, run: done(run) });
    act('Run PHPUnit tests', 'Run', ws.runTests);
    act('Save file', 'Ctrl+S', ws.saveActive);
    act('Check for Composer updates', 'Composer', () => {
      ws.setRightTool('composer');
      ws.checkOutdated();
    });
    act('Open terminal', 'Tool window', () => ws.showBottom('terminal'));
    act('Show problems', 'Tool window', () => ws.showBottom('problems'));
    act('Commit changes', 'Git', () => ws.toggleLeft('commit'));
    act('Refresh Git status', 'Git', ws.refreshGit);
    act('Open folder…', 'Project', actions.openFolder);
    act('Close project', 'Project', actions.closeProject);
    act('Find in Files…', 'Ctrl+Shift+F', () => ws.openFindInFiles('find'));
    act('Replace in Files…', 'Ctrl+Shift+R', () => ws.openFindInFiles('replace'));
    for (const c of editorCommands()) act(c.label, c.shortcut ?? 'Editor', c.run);
    return out;
    // phpIndex is mutable; indexVersion tells us when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.files, ws.indexVersion]);

  const results = useMemo(() => {
    const kind = TAB_KIND[tab];
    const q = query.trim().toLowerCase();
    const pool = kind ? items.filter((i) => i.kind === kind) : items;
    if (!q) return (tab === 'all' ? pool.filter((i) => i.kind !== 'Symbol') : pool).slice(0, LIMIT);
    const scored: [number, Item][] = [];
    for (const item of pool) {
      const name = item.name.toLowerCase();
      let score = -1;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.includes(q)) score = 2;
      else if (item.detail.toLowerCase().includes(q)) score = 3;
      if (score >= 0) scored.push([score * 1000 + name.length, item]);
    }
    return scored
      .sort((a, b) => a[0] - b[0])
      .slice(0, LIMIT)
      .map(([, i]) => i);
  }, [items, tab, query]);

  useEffect(() => { setSelected(0); }, [tab, query]);
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      results[selected]?.run();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const i = TABS.findIndex(([id]) => id === tab);
      setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length][0]);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Search everywhere" onKeyDown={onKeyDown}>
        <div className="dialog-tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={'dialog-tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Close search" onClick={onClose}>
            <Icon name="close" size={12} strokeWidth={2.5} />
          </button>
        </div>
        <div className="search-field">
          <Icon name="search" />
          <label htmlFor="search-everywhere" className="sr-only">
            Search classes, files, symbols and actions
          </label>
          <input
            id="search-everywhere"
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to search classes, files, symbols, actions…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="results" ref={list}>
          {results.map((r, i) => (
            <button
              key={r.key}
              type="button"
              className={'result' + (i === selected ? ' selected' : '')}
              data-selected={i === selected}
              onMouseMove={() => setSelected(i)}
              onClick={r.run}
            >
              <Badge text={KIND_BADGE[r.kind][0]} color={KIND_BADGE[r.kind][1]} />
              <span className="name">{r.name}</span>
              <span className="detail">{r.detail}</span>
              <span className="kind">{r.kind}</span>
            </button>
          ))}
          {!results.length && <div className="empty">Nothing found.</div>}
        </div>
        <div className="dialog-foot">↑↓ to move · Enter to open · Tab to switch category · Esc to close</div>
      </div>
    </div>
  );
}

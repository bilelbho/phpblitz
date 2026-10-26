import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { symbols, useSymbols, type SearchHit } from '../symbols';
import { editorCommands } from '../editorCommands';
import { Badge, Icon } from './Icon';
import type { ContextItem } from './ContextMenu';
import type { TopMenu } from '../mainMenu';
import { COMMANDS } from '../keymap/catalog';
import { canRun, runCommand } from '../keymap/commands';
import { shortcut } from '../keymap/store';

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
  /** The main menu: everything in it is an action too. */
  menus: TopMenu[];
}

export function SearchEverywhere({ ws, initialTab, onClose, actions, menus }: Props) {
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
    // Classes and symbols come from the index as you type (see `hits`); files and actions are here.
    const out: Item[] = [];
    for (const f of ws.files) {
      const rel = relativePath(ws.backend, f);
      out.push({ key: `f:${f}`, kind: 'File', name: baseName(f), detail: rel.split('/').slice(0, -1).join('/') || '/', run: done(() => ws.openFile(f)) });
    }
    const act = (name: string, detail: string, run: () => void) => {
      if (!out.some((i) => i.kind === 'Action' && i.name === name)) out.push({ key: `a:${name}`, kind: 'Action', name, detail, run: done(run) });
    };
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
    // The main menu's items (as they are now: disabled ones aren't offered), then the keymap's commands.
    const walk = (items: ContextItem[], trail: string) => {
      for (const it of items) {
        if (it.kind === 'sep' || it.head || it.disabled) continue;
        if (it.submenu) walk(it.submenu, `${trail} ▸ ${it.label}`);
        else if (it.run) act(it.label, it.shortcut ? `${trail} · ${it.shortcut}` : trail, it.run);
      }
    };
    for (const m of menus) walk(m.items(), m.label);
    for (const c of COMMANDS) if (!c.monaco && canRun(c.id)) act(c.label, shortcut(c.id) ?? c.group, () => void runCommand(c.id, null));
    return out;
    // phpIndex is mutable; indexVersion tells us when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.files, ws.indexVersion]);

  // Classes, methods and functions: ranked by the index (project above vendor), fetched per query.
  useSymbols();
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (tab === 'files' || tab === 'actions') return setHits([]);
    let live = true;
    const t = window.setTimeout(() => {
      void symbols.search(query, LIMIT).then((h) => live && setHits(h));
    }, 40);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, tab, ws.indexVersion]);
  const hitItems = useMemo(
    () =>
      hits.map((h): Item => {
        const isClass = h.kind !== 'method' && h.kind !== 'function';
        return {
          key: `${h.kind}:${h.path}:${h.line}:${h.name}`,
          kind: isClass ? 'Class' : 'Symbol',
          name: h.name,
          detail: `${h.detail}${h.vendor ? ' · vendor' : ''}`,
          run: done(() => ws.openFile(h.path, { line: h.line })),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hits],
  );

  const results = useMemo(() => {
    const kind = TAB_KIND[tab];
    const q = query.trim().toLowerCase();
    const classes = hitItems.filter((i) => i.kind === 'Class');
    const symbolsFound = hitItems.filter((i) => i.kind === 'Symbol');
    if (kind === 'Class') return classes.slice(0, LIMIT);
    if (kind === 'Symbol') return symbolsFound.slice(0, LIMIT);
    const pool = kind ? items.filter((i) => i.kind === kind) : items;
    if (!q) return (tab === 'all' ? [...classes.slice(0, 20), ...pool] : pool).slice(0, LIMIT);
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
    const local = scored.sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    // "All": the best classes, then files and actions, then methods and functions.
    return (tab === 'all' ? [...classes.slice(0, 25), ...local.slice(0, 40), ...symbolsFound.slice(0, 25)] : local).slice(0, LIMIT);
  }, [items, hitItems, tab, query]);

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
            <Icon name="close" size={12} />
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

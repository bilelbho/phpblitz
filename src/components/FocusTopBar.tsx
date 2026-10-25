// The Focus layout's top bar: the project and branch over the sidebar, the editor tabs over the
// editor, then toggles for the sidebar and the columns, Run / Debug, Search, Settings and the main
// menu.

import { useLayoutEffect, useRef, useState } from 'react';
import { withKeys } from '../keymap/store';
import { hamburgerItems, mainMenu } from '../mainMenu';
import { useSettings } from '../settings';
import { useTestRunner } from '../tests/runner';
import { debug } from '../debug/manager';
import { columnShown, FOCUS_TOGGLES, FOCUS_TOOLS, isEditorColumn, type Tool } from '../toolLayout';
import { openPresetDialog, sameLayout, useFocusPresets } from '../focusLayouts';
import type { Workspace } from '../useWorkspace';
import { ContextMenu } from './ContextMenu';
import { Icon, Logo, Play, type IconName } from './Icon';
import { MainMenuBar } from './MainMenuBar';
import type { SearchTab } from './SearchEverywhere';
import { TabBar } from './TabBar';
import { BranchWidget, openBranches, ProjectWidget } from './TopBar';
import { WindowControls } from './WindowControls';

/**
 * A narrow window: the bar's icons go into the ⋯ list, these first (the least used), so nothing is
 * cut off. The sidebar button, the list itself and the main menu always stay.
 */
const FOLD_ORDER = ['settings', 'search', 'debug', 'run', 'problems', 'ai', 'database', 'terminal'] as const;
type Foldable = (typeof FOLD_ORDER)[number];
/** Room kept for the main menu, project and branch buttons. */
const START_ROOM = 184;

interface Props {
  ws: Workspace;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
  onSearch: (tab?: SearchTab) => void;
  /** The tool windows' names and icons. */
  tools: Record<Tool, { label: string; icon: IconName; dot?: boolean; count?: number }>;
}

export function FocusTopBar({ ws, onOpenFolder, onOpenPath, onClose, onSearch, tools }: Props) {
  const ui = useSettings().ui;
  const runner = useTestRunner();
  const [hamburger, setHamburger] = useState<DOMRect | null>(null);
  const [more, setMore] = useState<DOMRect | null>(null);
  const presets = useFocusPresets();
  const menus = mainMenu({ ws, onOpenFolder, onOpenPath, onClose, onSearch, onBranches: openBranches });
  const problemCount = Object.values(ws.problems).flat().length;
  // The sidebar: the column left of the editor's (when the editor's isn't the first).
  const columns = ws.focus.columns;
  const sidebar = columns[0] && !isEditorColumn(columns[0]) ? columns[0] : null;
  const sidebarOpen = !!sidebar && columnShown(sidebar);
  // The tabs start above the editor, where it is on screen (columns shrink when the window is short of room).
  const [editorLeft, setEditorLeft] = useState(0);
  const layoutKey = JSON.stringify(ws.focus);
  useLayoutEffect(() => {
    const main = document.querySelector('.focus-main');
    if (!main) return;
    const measure = () => {
      const editor = document.querySelector('.focus-main .focus-col.editor')?.getBoundingClientRect();
      const bar = document.querySelector('.focus-topbar')?.getBoundingClientRect();
      setEditorLeft(editor && bar ? Math.round(editor.left - bar.left) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    main.querySelectorAll('.focus-col').forEach((c) => observer.observe(c));
    return () => observer.disconnect();
  }, [layoutKey]);
  // Room for the project and branch first: the editor far left, they come before the tabs.
  const startWidth = editorLeft > 180 ? editorLeft - 6 : undefined;
  // The list: tool windows without a toggle, the sidebar's excepted (they have its icons).
  const others = FOCUS_TOOLS.filter((t) => !(FOCUS_TOGGLES as readonly Tool[]).includes(t) && !sidebar?.groups.some((g) => g.panels.includes(t)));
  const otherOpen = others.some((t) => ws.isToolOpen(t));
  const debugTitle = ws.activePath?.endsWith('.php') ? `Debug '${ws.activePath.split('/').pop()}'` : 'Debug (open a PHP file)';

  // How many icons are folded into the list: measured on every change of the bar's size or content.
  const bar = useRef<HTMLElement>(null);
  const [fold, setFold] = useState(0);
  const iconWidths = useRef<Partial<Record<Foldable, number>>>({});
  const measureFold = useRef(() => {});
  measureFold.current = () => {
    const el = bar.current;
    const end = el?.querySelector<HTMLElement>('.focus-top-end');
    if (!el || !end) return;
    // Each icon's width, remembered while it shows (a folded one keeps its last).
    el.querySelectorAll<HTMLElement>('[data-fold]').forEach((b) => (iconWidths.current[b.dataset.fold as Foldable] = b.offsetWidth + 2));
    const room = el.clientWidth - (el.querySelector<HTMLElement>('.win-controls')?.offsetWidth ?? 0) - START_ROOM;
    let width = end.scrollWidth + FOLD_ORDER.slice(0, fold).reduce((sum, k) => sum + (iconWidths.current[k] ?? 34), 0);
    let n = 0;
    while (width > room && n < FOLD_ORDER.length) width -= iconWidths.current[FOLD_ORDER[n++]] ?? 34;
    if (n !== fold) setFold(n);
  };
  useLayoutEffect(() => measureFold.current());
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measureFold.current());
    if (bar.current) observer.observe(bar.current);
    return () => observer.disconnect();
  }, []);
  const folded = new Set<Foldable>(FOLD_ORDER.slice(0, fold));
  const shows = (k: Foldable) => !folded.has(k);
  /** The folded icons, at the top of the ⋯ list. */
  const foldedItems = [
    ...FOCUS_TOGGLES.filter((t) => folded.has(t)).map((t) => ({ label: tools[t].label, icon: tools[t].icon, checked: ws.isToolOpen(t), run: () => ws.toggleTool(t) })),
    ...(folded.has('run') ? [{ label: "Run 'PHPUnit'", icon: 'run' as const, disabled: runner.running, run: ws.runTests }] : []),
    ...(folded.has('debug') ? [{ label: debugTitle, icon: 'bug' as const, disabled: !ws.activePath?.endsWith('.php'), run: () => ws.activePath && void debug.debugScript(ws.activePath) }] : []),
    ...(folded.has('search') ? [{ label: 'Search Everywhere', icon: 'search' as const, run: () => onSearch('all') }] : []),
    ...(folded.has('settings') ? [{ label: 'Settings…', icon: 'gear' as const, run: () => ws.openSettings() }] : []),
  ];

  return (
    <>
      {ui.mainMenu === 'separate' && (
        <div className="menubar-row" data-tauri-drag-region>
          <span className="menubar-logo">
            <Logo size={16} />
          </span>
          <MainMenuBar menus={menus} merged={false} />
          <div className="drag" data-tauri-drag-region />
          <WindowControls />
        </div>
      )}
      <header className="topbar focus-topbar" data-tauri-drag-region ref={bar}>
        <div className="focus-top-start" data-tauri-drag-region style={startWidth ? { flexBasis: startWidth } : undefined}>
          {/* The main menu first, at the left, as in the Classic layout. */}
          {ui.mainMenu !== 'separate' && (
            <button
              type="button"
              className={'top-icon hamburger-btn' + (hamburger ? ' open' : '')}
              aria-label="Main menu"
              aria-haspopup="menu"
              title="Main Menu"
              onClick={(e) => setHamburger(hamburger ? null : e.currentTarget.getBoundingClientRect())}
            >
              <Icon name="menu" />
            </button>
          )}
          {hamburger && <ContextMenu x={hamburger.left} y={hamburger.bottom + 4} items={hamburgerItems(menus)} ignoreClicksIn=".hamburger-btn" onClose={() => setHamburger(null)} />}
          <ProjectWidget ws={ws} onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onClose={onClose} />
          <BranchWidget ws={ws} />
        </div>
        <div className="focus-top-tabs" data-tauri-drag-region>
          {ws.tabs.length > 0 ? <TabBar ws={ws} windowDrag /> : <div className="drag" data-tauri-drag-region />}
        </div>
        <div className="focus-top-end" data-tauri-drag-region>
          <button
            type="button"
            className={'top-icon' + (sidebarOpen ? ' on' : '')}
            aria-label="Sidebar"
            aria-pressed={sidebarOpen}
            disabled={!sidebar}
            title={!sidebar ? 'Sidebar (no column left of the editor)' : sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
            onClick={ws.toggleFocusSidebar}
          >
            <Icon name="sidebar" />
          </button>
          <span className="focus-top-sep" />
          {FOCUS_TOGGLES.filter(shows).map((t) => (
            <button
              key={t}
              data-fold={t}
              type="button"
              className={'top-icon' + (ws.isToolOpen(t) ? ' on' : '') + (t === 'problems' && problemCount ? ' with-count' : '')}
              aria-label={tools[t].label}
              aria-pressed={ws.isToolOpen(t)}
              title={withKeys(tools[t].label, `phpblitz.tool.${tools[t].label.toLowerCase()}`)}
              onClick={() => ws.toggleTool(t)}
            >
              <Icon name={tools[t].icon} />
              {t === 'problems' && problemCount > 0 && <span className="top-count">{problemCount}</span>}
            </button>
          ))}
          <button
            type="button"
            className={'top-icon focus-more' + (more ? ' open' : otherOpen || foldedItems.some((i) => 'checked' in i && i.checked) ? ' on' : '')}
            aria-label="More tool windows and layouts"
            aria-haspopup="menu"
            title="More Tool Windows and Layouts"
            onClick={(e) => setMore(more ? null : e.currentTarget.getBoundingClientRect())}
          >
            <Icon name="panels" />
          </button>
          {more && (
            <ContextMenu
              x={more.left}
              y={more.bottom + 4}
              ignoreClicksIn=".focus-more"
              items={[
                ...foldedItems,
                ...(foldedItems.length ? [{ kind: 'sep' as const }] : []),
                ...others.map((t) => ({ label: tools[t].label, icon: tools[t].icon, checked: ws.isToolOpen(t), run: () => ws.toggleTool(t) })),
                { kind: 'sep' as const },
                { label: 'Layouts', head: true },
                ...presets.map((p) => ({ label: p.name, checked: sameLayout(p.layout, ws.focus), run: () => ws.applyFocusLayout(p.layout) })),
                { label: 'Save Current Layout As…', run: () => openPresetDialog({ mode: 'save' }) },
              ]}
              onClose={() => setMore(null)}
            />
          )}
          {(shows('run') || shows('debug') || shows('search') || shows('settings')) && <span className="focus-top-sep" />}
          {shows('run') && (
            <button type="button" data-fold="run" className="top-icon" aria-label="Run tests" title="Run 'PHPUnit'" style={{ color: '#5fb865' }} onClick={ws.runTests} disabled={runner.running}>
              <Play />
            </button>
          )}
          {shows('debug') && (
            <button
              type="button"
              data-fold="debug"
              className="top-icon"
              aria-label="Debug current file"
              title={debugTitle}
              style={{ color: '#5fb865' }}
              disabled={!ws.activePath?.endsWith('.php')}
              onClick={() => ws.activePath && void debug.debugScript(ws.activePath)}
            >
              <Icon name="bug" />
            </button>
          )}
          {shows('search') && (
            <button type="button" data-fold="search" className="top-icon" aria-label="Search everywhere" title={withKeys('Search Everywhere', 'phpblitz.searchEverywhere')} onClick={() => onSearch('all')}>
              <Icon name="search" />
            </button>
          )}
          {shows('settings') && (
            <button type="button" data-fold="settings" className="top-icon" aria-label="Settings" title={withKeys('Settings', 'phpblitz.settings')} onClick={() => ws.openSettings()}>
              <Icon name="gear" />
            </button>
          )}
        </div>
        {ui.mainMenu !== 'separate' && <WindowControls />}
      </header>
    </>
  );
}

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import * as monaco from 'monaco-editor';
// The code editor and its PHP support load with the workspace, not at launch (see lazy.tsx).
import '../monaco';
import '../mago';
import type { Backend } from '../backend/types';
import { tabOfTool, toolOfTab, useWorkspace } from '../useWorkspace';
import { Icon, type IconName } from './Icon';
import { Splitter } from './Splitter';
import { ContextMenu } from './ContextMenu';
import { TopBar } from './TopBar';
import { FocusTopBar } from './FocusTopBar';
import { FocusPresetDialog } from './FocusPresetDialog';
import { usePresetDialog } from '../focusLayouts';
import { ToolStrip, type StripItem, type ToolDrag } from './ToolStrip';
import { columnShown, isBottomTool, isEditorColumn, type Anchor, type FocusDrop, type FocusGroup, type FocusPanel, type IconsSide, type Tool } from '../toolLayout';
import { HideToolButton, ToolColumnContext, ToolHideContext } from './toolHide';
import { ProjectTree } from './ProjectTree';
import { CommitPanel } from './CommitPanel';
import { StructurePanel } from './StructurePanel';
import { EditorArea } from './EditorArea';
import { BottomPanel } from './BottomPanel';
import { NotificationsPanel } from './NotificationsPanel';
import { AiPanel } from './AiPanel';
import { AiDialogs } from './AiDialogs';
import { setAiDialog } from '../ai/review';
import { RecentLocations } from './RecentLocations';
import { ErrorBoundary } from './ErrorBoundary';
import { NotificationBalloons } from './NotificationBalloons';
import { ErrorLogDialog } from './ErrorLogDialog';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { mainMenu } from '../mainMenu';
import { useFileDrop } from '../fileDrop';
import { EndpointsPanel } from './EndpointsPanel';
import { ComposerPanel } from './ComposerPanel';
import { NpmPanel } from './NpmPanel';
import { StatusBar } from './StatusBar';
import { TrustDialog } from './TrustDialog';
import { SearchEverywhere } from './SearchEverywhere';
import { FindInFiles } from './FindInFiles';
import { AboutDialog, DatabasePanel, SettingsDialog, StartupPerformance } from './lazy';
import { openAppDialog, useAppDialog } from '../appDialogs';
import { LocalHistoryDialog, openLocalHistory, useLocalHistory } from './LocalHistoryDialog';
import { perf, usePerf } from '../perf';
import { GitDialogs } from './GitDialogs';
import { projectHasNoColor, useProjectColor } from '../projectColors';
import { zoomBy } from '../uiSettings';
import { RecentFiles, TOOL_WINDOWS } from './RecentFiles';
import { DEFAULT_SETTINGS, getSettings, updateEditorSettings, useSettings } from '../settings';
import { invoke } from '@tauri-apps/api/core';
import { RELEASES_URL, restartToUpdate, useUpdateState } from '../updater';
import { debug, useDebug } from '../debug/manager';
import { UsagesPopup } from './UsagesPopup';
import { registerCommands } from '../keymap/commands';
import { installDispatcher } from '../keymap/dispatcher';
import { lastEditPlace } from '../navHistory';

interface Props {
  backend: Backend;
  onOpenFolder: () => void;
  onOpenPath: (path: string, opts?: { trusted?: boolean }) => void;
  onClose: () => void;
}

/** A tool window island: header with title and a hide button, then its content. */
function ToolWindow({ title, hint, onHide, children, style }: { title: string; hint?: string; onHide: () => void; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section className="island side" aria-label={title} style={style}>
      <div className="tw-head">
        <span className="tw-title">{title}</span>
        {hint && <span className="tw-hint">{hint}</span>}
        <span className="grow" />
        <HideToolButton onHide={onHide} label={title} />
      </div>
      {children}
    </section>
  );
}

export function WorkspaceView({ backend, onOpenFolder, onOpenPath, onClose }: Props) {
  const ws = useWorkspace(backend);
  /** Restricted Mode ▸ trust the project (it opens again, with everything running). */
  const [trusting, setTrusting] = useState(false);
  useFileDrop(ws);
  const perfState = usePerf();
  const appDialog = useAppDialog();
  const localHistory = useLocalHistory();
  useEffect(() => perf.mark('Workspace shown', 'UI and code editor loaded'), []);

  // Updates: a notification once a new version is downloaded (or found, for copies that can't
  // install it themselves); Help ▸ Check for Updates also reports "up to date" and errors.
  const update = useUpdateState();
  const announced = useRef('');
  useEffect(() => {
    const version = 'version' in update ? update.version : '';
    if (!update.manual && announced.current === update.kind + version) return;
    if (update.kind === 'ready') {
      ws.notify({
        title: `PHPBlitz ${update.version} is ready`,
        body: 'Restart to finish updating. Unsaved files are saved first.',
        tone: 'info',
        action: {
          label: 'Restart and Update',
          run: async () => {
            for (const path of ws.dirty) await ws.save(path);
            await restartToUpdate().catch((e) => ws.notify({ title: 'Could not install the update', body: String(e), tone: 'error' }));
          },
        },
      });
    } else if (update.kind === 'available') {
      ws.notify({
        title: `PHPBlitz ${update.version} is available`,
        body: 'The portable version updates by downloading the new zip.',
        tone: 'info',
        action: { label: 'Download', run: () => void invoke('open_external', { url: RELEASES_URL }).catch(() => {}) },
      });
    } else if (update.kind === 'none' && update.manual) ws.notify({ title: 'PHPBlitz is up to date', body: 'You have the latest version.', tone: 'success' });
    else if (update.kind === 'error' && update.manual) ws.notify({ title: 'Could not check for updates', body: update.message, tone: 'error' });
    else return;
    announced.current = update.kind + version;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);
  // Classic: the sizes, saved with the project (useWorkspace).
  const { leftWidth, leftTopHeight, rightTopHeight, rightWidth, bottomHeight } = ws.classicSizes;
  const layout = useSettings().ui.layout;
  const presetDialog = usePresetDialog();
  const openSearch = ws.openSearch;

  // The keymap's commands (Settings ▸ Keymap) that work anywhere in the window, and the key
  // dispatcher that runs them. In a code editor, its own actions with the same ids come first.
  const latest = useRef({ ws, openSearch });
  latest.current = { ws, openSearch };
  useEffect(() => {
    const w = () => latest.current.ws;
    const search = (tab: Parameters<typeof openSearch>[0]) => () => latest.current.openSearch(tab);
    const selected = () => window.getSelection()?.toString().split('\n')[0] ?? '';
    const fontSize = (step: number | null) => () =>
      updateEditorSettings({
        fontSize: step === null ? DEFAULT_SETTINGS.editor.fontSize : Math.min(40, Math.max(8, getSettings().editor.fontSize + step)),
      });
    const stopped = () => debug.active?.status === 'break';
    // F6 / Ctrl+Shift+F6: the next / previous panel on screen, in reading order (Focus: its groups;
    // Classic: the tool windows and the editor), with something in it focused and a short outline.
    const panelsOnScreen = () =>
      [...document.querySelectorAll<HTMLElement>(getSettings().ui.layout === 'focus' ? '.focus-main .focus-group' : '.main .island')].filter(
        (el) => el.offsetParent !== null && !el.parentElement?.closest('.island'),
      );
    const focusPanel = (step: number) => {
      const list = panelsOnScreen();
      if (!list.length) return;
      const at = list.findIndex((el) => el.contains(document.activeElement));
      const next = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length];
      // A code editor through its own focus (focusing its hidden text area does nothing).
      const editor = monaco.editor.getEditors().find((e) => next.contains(e.getDomNode()));
      const target = next.querySelector<HTMLElement>('.xterm-helper-textarea, [role="tree"], [role="grid"], [tabindex="0"], input, textarea, button');
      if (editor) editor.focus();
      else if (target) target.focus();
      else {
        // Nothing to focus in it (the editor with no file open): the panel itself.
        next.tabIndex = -1;
        next.focus();
      }
      next.classList.remove('panel-flash');
      void next.offsetWidth;
      next.classList.add('panel-flash');
      window.setTimeout(() => next.classList.remove('panel-flash'), 700);
    };
    /** Ctrl+Shift+F12 (Focus layout): the panel with the keyboard shown alone, or everything back. */
    const toggleMaximized = () => {
      const w = latest.current.ws;
      if (w.focus.maximized) return w.maximizeFocusPanel(null);
      const group = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.focus-group');
      w.maximizeFocusPanel((group?.dataset.active as FocusPanel | undefined) ?? 'editor');
    };
    const unregister = registerCommands({
      'phpblitz.settings': () => w().openSettings(),
      'phpblitz.save': () => w().saveActive(),
      'phpblitz.closeTab': { run: () => void w().closeTab(w().activeId!), enabled: () => !!w().activeId },
      'phpblitz.reopenClosedTab': () => w().reopenClosedTab(),
      'phpblitz.findInFiles': () => w().openFindInFiles('find', selected()),
      'phpblitz.replaceInFiles': () => w().openFindInFiles('replace', selected()),
      'phpblitz.searchEverywhere': search('all'),
      'phpblitz.findAction': search('actions'),
      'phpblitz.gotoClass': search('classes'),
      'phpblitz.gotoFile': search('files'),
      'phpblitz.gotoSymbol': search('symbols'),
      'phpblitz.recentFiles': () => w().setRecentOpen(true),
      'phpblitz.recentLocations': () => w().setLocationsOpen(true),
      'phpblitz.back': () => w().navigateBack(),
      'phpblitz.forward': () => w().navigateForward(),
      'phpblitz.lastEditLocation': () => {
        const place = lastEditPlace();
        if (place) w().goToPlace(place);
      },
      'phpblitz.runTests': () => w().runTests(),
      'phpblitz.debugResume': { run: () => debug.resume(), enabled: stopped },
      'phpblitz.debugStepOver': { run: () => debug.stepOver(), enabled: stopped },
      'phpblitz.debugStepInto': { run: () => debug.stepInto(), enabled: stopped },
      'phpblitz.debugStepOut': { run: () => debug.stepOut(), enabled: stopped },
      'phpblitz.debugStop': { run: () => void debug.stop(), enabled: () => !!debug.active && debug.active.status !== 'stopped' },
      'phpblitz.commit': () => w().showLeft('commit'),
      'phpblitz.push': { run: () => w().setGitDialog({ kind: 'push' }), enabled: () => !!w().git },
      'phpblitz.updateProject': { run: () => void w().runGit('Update project', () => w().gitRepo.pull()), enabled: () => !!w().git },
      'phpblitz.newBranch': { run: () => w().setGitDialog({ kind: 'newBranch' }), enabled: () => !!w().git },
      ...Object.fromEntries(TOOL_WINDOWS.map((t) => [`phpblitz.tool.${t.label.toLowerCase()}`, () => t.run(w())])),
      'phpblitz.panel.next': () => focusPanel(1),
      'phpblitz.panel.previous': () => focusPanel(-1),
      'phpblitz.panel.maximize': { run: toggleMaximized, enabled: () => getSettings().ui.layout === 'focus' },
      'phpblitz.zoomIn': () => zoomBy(10),
      'phpblitz.zoomOut': () => zoomBy(-10),
      'phpblitz.zoomReset': () => zoomBy('reset'),
      'phpblitz.fontSizeUp': fontSize(1),
      'phpblitz.fontSizeDown': fontSize(-1),
      'phpblitz.fontSizeReset': fontSize(null),
    });
    /** Keys typed in a terminal go to the shell (Settings ▸ Tools ▸ Terminal ▸ Override IDE shortcuts). */
    const forShell = (e: KeyboardEvent) => getSettings().terminal.overrideIdeShortcuts && !!(e.target as HTMLElement | null)?.closest?.('.xterm');
    const uninstall = installDispatcher({ forShell });
    // Browser defaults that don't belong in an IDE: reload (Ctrl+R, F5) and the web view's own find
    // (Ctrl+F). After the dispatcher, which leaves keys a field already handled alone.
    const browserKeys = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if ((ctrl && (key === 'r' || key === 'f')) || e.key === 'F5') e.preventDefault();
    };
    // The mouse's back / forward side buttons.
    const mouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.button === 3) latest.current.ws.navigateBack();
      else latest.current.ws.navigateForward();
    };
    window.addEventListener('keydown', browserKeys);
    window.addEventListener('mouseup', mouse);
    return () => {
      unregister();
      uninstall();
      window.removeEventListener('keydown', browserKeys);
      window.removeEventListener('mouseup', mouse);
    };
  }, []);

  const debugState = useDebug();

  const changeCount = ws.git?.changes.length ?? 0;
  const problemCount = Object.values(ws.problems).flat().length;
  // Tool windows: their strip icons, titles and contents, wherever the layout puts them.
  const toolInfo: Record<Tool, { label: string; icon: IconName; hint?: string; dot?: boolean; count?: number }> = {
    project: { label: 'Project', icon: 'folder' },
    commit: { label: 'Commit', icon: 'commit', dot: changeCount > 0 },
    database: { label: 'Database', icon: 'database', hint: ws.backend.kind === 'sample' ? 'sample data' : '' },
    structure: { label: 'Structure', icon: 'structure' },
    notifications: { label: 'Notifications', icon: 'bell', count: ws.notices.length },
    ai: { label: 'AI', icon: 'sparkle' },
    endpoints: { label: 'Endpoints', icon: 'route', hint: `${ws.routes.length} routes` },
    composer: { label: 'Composer', icon: 'box', hint: 'composer.json', dot: !!ws.outdated && Object.keys(ws.outdated).length > 0 },
    npm: { label: 'npm', icon: 'npm', hint: 'package.json scripts' },
    tests: { label: 'Run', icon: 'run' },
    debug: { label: 'Debug', icon: 'bug', dot: debugState.sessions.some((s) => s.status === 'break') },
    terminal: { label: 'Terminal', icon: 'terminal' },
    problems: { label: 'Problems', icon: 'error', dot: problemCount > 0 },
    composerLog: { label: 'Composer Log', icon: 'box' },
    git: { label: 'Git', icon: 'git' },
    todo: { label: 'TODO', icon: 'todo' },
  };
  const stripGroup = (anchor: Anchor) => ({
    anchor,
    items: ws.toolLayout[anchor].map((id): StripItem => ({ id, ...toolInfo[id], active: ws.isToolOpen(id) })),
  });

  // ── Dragging a tool window icon to another place ──
  const [drag, setDrag] = useState<ToolDrag | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  /** Where a drop at (x, y) puts the tool: a slot in a strip, or a side of the window. */
  const dropTarget = (tool: Tool, x: number, y: number): ToolDrag['target'] => {
    for (const group of document.querySelectorAll<HTMLElement>('.strip-group[data-anchor]')) {
      const strip = group.closest('.strip')!.getBoundingClientRect();
      const r = group.getBoundingClientRect();
      if (x < strip.left - 24 || x > strip.right + 24 || y < r.top - 14 || y > r.bottom + 14) continue;
      const buttons = [...group.querySelectorAll<HTMLElement>('[data-tool]')].filter((b) => b.dataset.tool !== tool);
      return { anchor: group.dataset.anchor as Anchor, index: buttons.filter((b) => b.getBoundingClientRect().top + b.offsetHeight / 2 < y).length };
    }
    const main = mainRef.current?.getBoundingClientRect();
    if (!main || y < main.top || y > main.bottom) return null;
    const third = main.width / 3;
    const side = x < main.left + third ? 'left' : x > main.right - third ? 'right' : null;
    // The middle of the window, low down: the bottom panel.
    if (!side && y < main.top + main.height * 0.6) return null;
    const anchor = (side ? `${side}${y < main.top + main.height / 2 ? 'Top' : 'Bottom'}` : 'bottom') as Anchor;
    return { anchor, index: ws.toolLayout[anchor].filter((t) => t !== tool).length };
  };
  const startDrag = (tool: Tool, icon: IconName, x: number, y: number) => setDrag({ tool, icon, x, y, target: dropTarget(tool, x, y) });
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setDrag((d) => d && { ...d, x: e.clientX, y: e.clientY, target: dropTarget(d.tool, e.clientX, e.clientY) });
    const up = () =>
      setDrag((d) => {
        if (d?.target) ws.placeTool(d.tool, d.target.anchor, d.target.index);
        return null;
      });
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);
  /** The blue area showing where the dragged tool window will open. */
  const dropArea = (() => {
    const main = mainRef.current?.getBoundingClientRect();
    if (!drag?.target || !main) return null;
    if (drag.target.anchor === 'bottom') {
      const center = document.querySelector('.center')?.getBoundingClientRect() ?? main;
      const height = Math.min(bottomHeight, main.height / 2);
      return { left: center.left, top: center.bottom - height, width: center.width, height };
    }
    const left = drag.target.anchor.startsWith('left');
    const top = drag.target.anchor.endsWith('Top');
    const width = Math.min(left ? leftWidth : rightWidth, main.width / 2);
    return { left: left ? main.left + 40 : main.right - 40 - width, top: top ? main.top : main.top + main.height / 2, width, height: main.height / 2 };
  })();

  /** A tool window, in the place it is open; its Hide button closes that place. */
  const toolWindow = (id: Tool, style?: React.CSSProperties) => {
    if (isBottomTool(id))
      return (
        <div key={id} className="tool-slot" style={style}>
          <ToolHideContext.Provider value={() => ws.hideTool(id)}>
            <ErrorBoundary name={toolInfo[id].label}>
              <BottomPanel ws={ws} tab={tabOfTool(id)} />
            </ErrorBoundary>
          </ToolHideContext.Provider>
        </div>
      );
    return id === 'project' ? (
      // The Project tool window draws its own header.
      <section key={id} className="island side" aria-label="Project" style={{ position: 'relative', ...style }}>
        <ErrorBoundary name="Project">
          <ProjectTree ws={ws} onHide={() => ws.hideTool('project')} />
        </ErrorBoundary>
      </section>
    ) : (
      <ToolWindow key={id} title={toolInfo[id].label} hint={toolInfo[id].hint} onHide={() => ws.hideTool(id)} style={style}>
        <ErrorBoundary name={toolInfo[id].label}>
          {id === 'commit' && <CommitPanel ws={ws} />}
          {id === 'database' && <DatabasePanel ws={ws} />}
          {id === 'structure' && <StructurePanel ws={ws} />}
          {id === 'notifications' && <NotificationsPanel ws={ws} />}
          {id === 'ai' && <AiPanel ws={ws} />}
          {id === 'endpoints' && <EndpointsPanel ws={ws} />}
          {id === 'composer' && <ComposerPanel ws={ws} />}
          {id === 'npm' && <NpmPanel ws={ws} />}
        </ErrorBoundary>
      </ToolWindow>
    );
  };
  /** The bottom panel: a side tool window dragged there, or the bottom tool windows' current tab. */
  const bottomTool = toolOfTab(ws.bottomTab);
  const bottomShown = ws.bottomOpen && (!!ws.bottomSideTool || !bottomTool || ws.toolLayout.bottom.includes(bottomTool));
  /** A side's column: its top tool window over its bottom one, with a splitter between. */
  const column = (side: 'left' | 'right') => {
    const top = ws.openTools[`${side}Top`];
    const bottom = ws.openTools[`${side}Bottom`];
    if (!top && !bottom) return null;
    const height = side === 'left' ? leftTopHeight : rightTopHeight;
    return (
      <div className="column" style={{ width: side === 'left' ? leftWidth : rightWidth }}>
        {top && toolWindow(top, bottom ? { flex: `0 0 ${height}px` } : undefined)}
        {top && bottom && <Splitter dir="h" onDrag={(d) => ws.resizeClassic(side === 'left' ? 'leftTopHeight' : 'rightTopHeight', d, 120, window.innerHeight - 260)} />}
        {bottom && toolWindow(bottom)}
      </div>
    );
  };
  const leftColumn = column('left');
  const rightColumn = column('right');
  const projectColor = useProjectColor(ws.backend.root, ws.backend.name);

  // ── Focus layout ──
  // Columns of groups of panels; the editor is a panel like the others.
  const { focus } = ws;
  const isResults = (p: FocusPanel): p is 'find' | 'usages' => p === 'find' || p === 'usages';
  const panelLabel = (p: FocusPanel) => (p === 'editor' ? 'Editor' : p === 'find' ? 'Find' : p === 'usages' ? 'Usages' : toolInfo[p].label);
  const iconOf = (p: FocusPanel): IconName => (p === 'editor' ? 'code' : isResults(p) ? 'search' : toolInfo[p].icon);
  /** A panel's content: the editor, a tool window or results, with Maximize and Close in its header. */
  const panelContent = (p: FocusPanel) => {
    if (p === 'editor')
      return (
        <div className="center">
          <ErrorBoundary name="Editor">
            <EditorArea ws={ws} />
          </ErrorBoundary>
        </div>
      );
    const maximized = focus.maximized === p;
    return (
      <ToolColumnContext.Provider value={{ maximized, toggleMaximized: () => ws.maximizeFocusPanel(maximized ? null : p) }}>
        {isResults(p) ? (
          <ToolHideContext.Provider value={() => ws.hideFocusPanel(p)}>
            <ErrorBoundary name={panelLabel(p)}>
              <BottomPanel ws={ws} tab={p} />
            </ErrorBoundary>
          </ToolHideContext.Provider>
        ) : (
          toolWindow(p, { flex: '1 1 auto' })
        )}
      </ToolColumnContext.Provider>
    );
  };
  /** A group: its icons when it has several panels, the one shown, and a grip to drag it by. */
  const focusGroup = (g: FocusGroup, style: React.CSSProperties) => (
    <div key={g.active} className={`focus-group icons-${g.icons ?? 'top'}`} data-panels={g.panels.join(' ')} data-active={g.active} style={style}>
      <div className="focus-grip" title={`Drag to move ${panelLabel(g.active)}`} onPointerDown={(e) => beginFocusDrag(e, g.active)} />
      {g.panels.length > 1 && (
        <div
          className="focus-group-tabs"
          role="tablist"
          aria-label={`${panelLabel(g.active)} and ${g.panels.length - 1} more`}
          aria-orientation={g.icons === 'left' || g.icons === 'right' ? 'vertical' : 'horizontal'}
          onContextMenu={(e) => {
            e.preventDefault();
            setIconsMenu({ x: e.clientX, y: e.clientY, panel: g.active, side: g.icons ?? 'top' });
          }}
        >
          {g.panels.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              data-panel={p}
              className={'top-icon' + (g.active === p ? ' on' : '')}
              aria-selected={g.active === p}
              aria-label={panelLabel(p)}
              title={`${panelLabel(p)} (drag to move it)`}
              onPointerDown={(e) => beginFocusDrag(e, p)}
              onClick={() => ws.showFocusPanel(p)}
            >
              <Icon name={iconOf(p)} />
              {p !== 'editor' && !isResults(p) && toolInfo[p].dot && <span className="dot" />}
            </button>
          ))}
        </div>
      )}
      {panelContent(g.active)}
    </div>
  );

  /** Right-click on a group's icons: which side of the group they are on. */
  const [iconsMenu, setIconsMenu] = useState<{ x: number; y: number; panel: FocusPanel; side: IconsSide } | null>(null);

  // Dragging a panel: by a group's icon, its header or its grip. It drops beside a column, above /
  // below a group, or into a group (its middle).
  const [focusDrag, setFocusDrag] = useState<{ panel: FocusPanel; icon: IconName; x: number; y: number; target: FocusDrop | null } | null>(null);
  /** Where a drop at (x, y) puts the panel. */
  const focusDropTarget = (panel: FocusPanel, x: number, y: number): FocusDrop | null => {
    // On a group's icons: into that group, at the place between them (moved along its own row too).
    const row = [...document.querySelectorAll<HTMLElement>('.focus-main .focus-group-tabs')].find((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    const rowPanels = (row?.closest<HTMLElement>('.focus-group')?.dataset.panels ?? '').split(' ') as FocusPanel[];
    const rowRef = rowPanels.find((p) => p !== panel);
    if (row && rowRef && panel !== 'editor' && !rowPanels.includes('editor')) {
      const icons = [...row.querySelectorAll<HTMLElement>('[data-panel]')].filter((b) => b.dataset.panel !== panel);
      // Icons on a side of the group are a column: places go top to bottom.
      const vertical = row.getAttribute('aria-orientation') === 'vertical';
      const before = (b: HTMLElement) => (vertical ? b.getBoundingClientRect().top + b.offsetHeight / 2 < y : b.getBoundingClientRect().left + b.offsetWidth / 2 < x);
      return { kind: 'tab', ref: rowRef, index: icons.filter(before).length };
    }
    const over = [...document.querySelectorAll<HTMLElement>('.focus-main .focus-group')].find((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (!over) return null;
    const panels = (over.dataset.panels ?? '').split(' ') as FocusPanel[];
    // Its own group, alone in it: nowhere to go.
    const ref = panels.find((p) => p !== panel);
    if (!ref) return null;
    const r = over.getBoundingClientRect();
    const [left, right, top, bottom] = [(x - r.left) / r.width, (r.right - x) / r.width, (y - r.top) / r.height, (r.bottom - y) / r.height];
    const edge = Math.min(left, right, top, bottom);
    // The middle: into the group (nothing shares the editor's).
    if (edge > 0.25 && panel !== 'editor' && !panels.includes('editor')) return { kind: 'tab', ref };
    if (edge === left || edge === right) return { kind: 'column', ref, after: edge === right };
    return { kind: 'stack', ref, below: edge === bottom };
  };
  /** A drag starts once the mouse moves a few pixels (a click stays a click). */
  const beginFocusDrag = (e: React.PointerEvent, panel: FocusPanel) => {
    if (e.button !== 0) return;
    const [x0, y0] = [e.clientX, e.clientY];
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      stop();
      setFocusDrag({ panel, icon: iconOf(panel), x: ev.clientX, y: ev.clientY, target: focusDropTarget(panel, ev.clientX, ev.clientY) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };
  /** A header (not its buttons or tabs) is the handle of the panel shown. */
  const headerDrag = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement;
    if (!el.closest('.tw-head') || el.closest('button, input, select, textarea, a, [role="tab"]')) return;
    const group = el.closest<HTMLElement>('.focus-group');
    if (group?.dataset.active) beginFocusDrag(e, group.dataset.active as FocusPanel);
  };
  const focusDragging = !!focusDrag;
  useEffect(() => {
    if (!focusDragging) return;
    const move = (e: PointerEvent) => setFocusDrag((d) => d && { ...d, x: e.clientX, y: e.clientY, target: focusDropTarget(d.panel, e.clientX, e.clientY) });
    const up = () =>
      setFocusDrag((d) => {
        if (d?.target) ws.moveFocusPanel(d.panel, d.target);
        return null;
      });
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setFocusDrag(null);
    document.body.style.cursor = 'grabbing';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDragging]);
  /** The blue area the dropped panel will take: half of the column beside, half of the group above / below, or the group. */
  const focusDropArea = (() => {
    const target = focusDrag?.target;
    if (!target) return null;
    const group = [...document.querySelectorAll<HTMLElement>('.focus-main .focus-group')].find((el) => (el.dataset.panels ?? '').split(' ').includes(target.ref!));
    const r = (target.kind === 'column' ? group?.closest('.focus-col') : group)?.getBoundingClientRect();
    if (!r) return null;
    // A place among a group's icons: a bar between them.
    if (target.kind === 'tab' && target.index !== undefined && group) {
      const row = group.querySelector<HTMLElement>('.focus-group-tabs');
      const icons = [...(row?.querySelectorAll<HTMLElement>('[data-panel]') ?? [])].filter((b) => b.dataset.panel !== focusDrag?.panel);
      const rr = row?.getBoundingClientRect();
      if (rr) {
        const before = icons[target.index]?.getBoundingClientRect();
        const last = icons[icons.length - 1]?.getBoundingClientRect();
        if (row?.getAttribute('aria-orientation') === 'vertical') {
          const y = before ? before.top - 2 : last ? last.bottom + 1 : rr.top + 4;
          return { style: { left: rr.left + 4, top: y - 1, width: rr.width - 8, height: 3 }, label: null };
        }
        const x = before ? before.left - 2 : last ? last.right + 1 : rr.left + 4;
        return { style: { left: x - 1, top: rr.top + 4, width: 3, height: rr.height - 8 }, label: null };
      }
    }
    // What letting go does, said in the area it will take, naming the panel the group shows.
    const shown = group?.dataset.active as FocusPanel | undefined;
    const into = panelLabel(shown && shown !== focusDrag?.panel ? shown : target.ref!);
    if (target.kind === 'tab') return { style: { left: r.left, top: r.top, width: r.width, height: r.height }, label: `Add to ${into}` };
    if (target.kind === 'stack')
      return { style: { left: r.left, top: target.below ? r.top + r.height / 2 : r.top, width: r.width, height: r.height / 2 }, label: target.below ? `Below ${into}` : `Above ${into}` };
    const width = Math.min(r.width / 2, 320);
    return { style: { left: target.after ? r.right - width : r.left, top: r.top, width, height: r.height }, label: target.after ? 'New column, right' : 'New column, left' };
  })();

  const shownColumns = focus.columns.map((col, c) => ({ col, c })).filter(({ col }) => isEditorColumn(col) || columnShown(col));
  /**
   * As a splitter drag starts: columns shrunk on screen (the window short of room) take the widths
   * they show, all of them, so the edge starts under the mouse and the room a drag frees goes where
   * the mouse is. Each move then adds its distance to the width as it is (moves come faster than
   * the screen redraws: reading the screen on each would lose some).
   */
  const takeShownWidths = () => {
    for (const { col, c } of shownColumns) {
      const shown = document.querySelector<HTMLElement>(`.focus-main .focus-col[data-column="${c}"]`)?.getBoundingClientRect().width;
      if (!isEditorColumn(col) && shown !== undefined && Math.abs(shown - col.width) > 1) ws.setFocusColumnWidth(c, shown);
    }
  };
  const focusMain = (
    <div className="main focus-main" ref={mainRef} onPointerDown={headerDrag}>
      {focus.maximized ? (
        <div className="focus-col" style={{ flex: '1 1 auto' }}>
          {focusGroup({ panels: [focus.maximized], active: focus.maximized, hidden: false, weight: 1 }, { flex: '1 1 auto' })}
        </div>
      ) : (
        shownColumns.map(({ col, c }, i) => {
          const prev = shownColumns[i - 1];
          const editor = isEditorColumn(col);
          const groups = col.groups.map((g, gi) => ({ g, gi })).filter(({ g }) => !g.hidden);
          // Shares of the column's height, relative to the groups shown: together they always fill it.
          const total = groups.reduce((sum, { g }) => sum + g.weight, 0) || 1;
          return (
            <Fragment key={col.groups[0].panels[0]}>
              {prev && (
                <Splitter
                  dir="v"
                  onStart={takeShownWidths}
                  onDrag={(d) => {
                    // The editor's column takes what is left; between two others, they trade width.
                    if (!isEditorColumn(prev.col)) ws.resizeFocusColumn(prev.c, d);
                    if (!editor) ws.resizeFocusColumn(c, -d);
                  }}
                />
              )}
              {/* Short of room, the columns shrink together (to 200 px), never the editor below 360 px. */}
              <div className={'focus-col' + (editor ? ' editor' : '')} data-column={c} style={editor ? { flex: '1 1 0', minWidth: 360 } : { flex: `0 1 ${col.width}px`, minWidth: 200 }}>
                {groups.map(({ g }, j) => (
                  <Fragment key={g.active}>
                    {j > 0 && <Splitter dir="h" onDrag={(d) => ws.resizeFocusGroups(c, groups[j - 1].gi, d, mainRef.current?.clientHeight ?? 800)} />}
                    {focusGroup(g, { flex: `${g.weight / total} 1 0` })}
                  </Fragment>
                ))}
              </div>
            </Fragment>
          );
        })
      )}
    </div>
  );

  const classicMain = (
    <div className="main" ref={mainRef}>
      <ToolStrip
        side="left"
        groups={[stripGroup('leftTop'), stripGroup('leftBottom')]}
        bottomGroup={stripGroup('bottom')}
        drag={drag}
        onDragStart={startDrag}
        onPick={(id) => ws.toggleTool(id as Tool)}
      />

      {leftColumn && (
        <>
          {leftColumn}
          <Splitter dir="v" onDrag={(d) => ws.resizeClassic('leftWidth', d, 200, 700)} />
        </>
      )}

      <div className="center">
        <ErrorBoundary name="Editor">
          <EditorArea ws={ws} />
        </ErrorBoundary>
        {bottomShown && (
          <>
            <Splitter dir="h" onDrag={(d) => ws.resizeClassic('bottomHeight', -d, 90, window.innerHeight - 200)} />
            {ws.bottomSideTool ? (
              toolWindow(ws.bottomSideTool, { flex: `0 0 ${bottomHeight}px` })
            ) : (
              <ErrorBoundary name="Bottom panel">
                <BottomPanel ws={ws} height={bottomHeight} />
              </ErrorBoundary>
            )}
          </>
        )}
      </div>

      {rightColumn && (
        <>
          <Splitter dir="v" onDrag={(d) => ws.resizeClassic('rightWidth', -d, 220, 720)} />
          {rightColumn}
        </>
      )}
      <ToolStrip side="right" groups={[stripGroup('rightTop'), stripGroup('rightBottom')]} drag={drag} onDragStart={startDrag} onPick={(id) => ws.toggleTool(id as Tool)} />
    </div>
  );

  return (
    <div className={'app' + (layout === 'focus' ? ' focus' : '')} style={{ ['--project-color' as string]: projectHasNoColor(ws.backend.root) ? 'transparent' : projectColor }}>
      <ErrorBoundary name="Toolbar">
        {layout === 'focus' ? (
          <FocusTopBar ws={ws} onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onClose={onClose} onSearch={openSearch} tools={toolInfo} />
        ) : (
          <TopBar ws={ws} onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onClose={onClose} onSearch={openSearch} />
        )}
      </ErrorBoundary>
      {layout === 'focus' ? focusMain : classicMain}
      {dropArea && <div className="tool-drop-area" style={dropArea} />}
      {iconsMenu && (
        <ContextMenu
          x={iconsMenu.x}
          y={iconsMenu.y}
          items={[
            { label: 'Icons', head: true },
            ...(['top', 'bottom', 'left', 'right'] as const).map((side) => ({
              label: { top: 'On Top', bottom: 'At the Bottom', left: 'On the Left', right: 'On the Right' }[side],
              checked: iconsMenu.side === side,
              run: () => ws.setFocusIconsSide(iconsMenu.panel, side),
            })),
          ]}
          onClose={() => setIconsMenu(null)}
        />
      )}
      {focusDropArea && (
        <div className="tool-drop-area focus-drop-hint" style={focusDropArea.style}>
          {focusDropArea.label && <span>{focusDropArea.label}</span>}
        </div>
      )}
      {focusDrag && (
        // Beside the pointer, not under it: the bar between a group's icons stays in sight.
        <div className="tool-drag-ghost" style={{ left: focusDrag.x + 10, top: focusDrag.y + 12 }}>
          <Icon name={focusDrag.icon} size={17} />
        </div>
      )}
      {drag && (
        <div className="tool-drag-ghost" style={{ left: drag.x - 15, top: drag.y - 15 }}>
          <Icon name={drag.icon} size={17} />
        </div>
      )}
      <ErrorBoundary name="Status bar">
        <StatusBar ws={ws} onTrust={() => setTrusting(true)} />
        {trusting && <TrustDialog root={backend.root} onTrust={() => onOpenPath(backend.root, { trusted: true })} onRestricted={() => setTrusting(false)} />}
      </ErrorBoundary>
      <ErrorBoundary name="Notifications">
        <NotificationBalloons ws={ws} />
      </ErrorBoundary>
      {ws.findInFiles && (
        <ErrorBoundary name="Find in Files" variant="dialog" onClose={() => ws.closeFindInFiles()}>
          <FindInFiles ws={ws} />
        </ErrorBoundary>
      )}
      <ErrorBoundary name="Git" variant="dialog" onClose={() => ws.setGitDialog(null)}>
        <GitDialogs ws={ws} />
      </ErrorBoundary>
      {ws.recentOpen && (
        <ErrorBoundary name="Recent Files" variant="dialog" onClose={() => ws.setRecentOpen(false)}>
          <RecentFiles ws={ws} onClose={() => ws.setRecentOpen(false)} />
        </ErrorBoundary>
      )}
      {ws.locationsOpen && (
        <ErrorBoundary name="Recent Locations" variant="dialog" onClose={() => ws.setLocationsOpen(false)}>
          <RecentLocations ws={ws} onClose={() => ws.setLocationsOpen(false)} />
        </ErrorBoundary>
      )}
      {localHistory && (
        <ErrorBoundary name="Local History" variant="dialog" onClose={() => openLocalHistory(null)}>
          <LocalHistoryDialog ws={ws} path={localHistory} onClose={() => openLocalHistory(null)} />
        </ErrorBoundary>
      )}
      {ws.settingsPage && (
        <ErrorBoundary name="Settings" variant="dialog" onClose={ws.closeSettings}>
          <SettingsDialog ws={ws} page={ws.settingsPage} onClose={ws.closeSettings} />
        </ErrorBoundary>
      )}
      <ErrorBoundary name="AI" variant="dialog" onClose={() => setAiDialog(null)}>
        <AiDialogs />
      </ErrorBoundary>
      {presetDialog && <FocusPresetDialog dialog={presetDialog} layout={ws.focus} />}
      {perfState.open && <StartupPerformance onClose={() => perf.show(false)} />}
      {appDialog === 'errors' && <ErrorLogDialog onClose={() => openAppDialog(null)} />}
      {appDialog === 'shortcuts' && (
        <ErrorBoundary name="Keyboard Shortcuts" variant="dialog" onClose={() => openAppDialog(null)}>
          <KeyboardShortcuts ws={ws} menus={mainMenu({ ws, onOpenFolder, onOpenPath, onClose, onSearch: openSearch, onBranches: () => {} })} onClose={() => openAppDialog(null)} />
        </ErrorBoundary>
      )}
      {(appDialog === 'about' || appDialog === 'licenses') && <AboutDialog view={appDialog} onClose={() => openAppDialog(null)} />}
      {ws.searchOpen && (
        <ErrorBoundary name="Search Everywhere" variant="dialog" onClose={() => ws.setSearchOpen(false)}>
          <SearchEverywhere
            ws={ws}
            initialTab={ws.searchTab}
            onClose={() => ws.setSearchOpen(false)}
            actions={{ openFolder: onOpenFolder, closeProject: onClose }}
          />
        </ErrorBoundary>
      )}
      {ws.usagesPopup && (
        <ErrorBoundary name="Usages" variant="dialog" onClose={() => ws.closeUsagesPopup()}>
          <UsagesPopup ws={ws} />
        </ErrorBoundary>
      )}
    </div>
  );
}

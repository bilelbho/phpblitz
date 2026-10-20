import { useEffect, useRef, useState, type ReactNode } from 'react';
// The code editor and its PHP support load with the workspace, not at launch (see lazy.tsx).
import '../monaco';
import '../mago';
import type { Backend } from '../backend/types';
import { tabOfTool, toolOfTab, useWorkspace } from '../useWorkspace';
import { Icon, type IconName } from './Icon';
import { Splitter } from './Splitter';
import { TopBar } from './TopBar';
import { ToolStrip, type StripItem, type ToolDrag } from './ToolStrip';
import { isBottomTool, type Anchor, type Tool } from '../toolLayout';
import { ToolHideContext } from './toolHide';
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
import { SearchEverywhere } from './SearchEverywhere';
import { FindInFiles } from './FindInFiles';
import { AboutDialog, DatabasePanel, SettingsDialog, StartupPerformance } from './lazy';
import { openAppDialog, useAppDialog } from '../appDialogs';
import { LocalHistoryDialog, openLocalHistory, useLocalHistory } from './LocalHistoryDialog';
import { perf, usePerf } from '../perf';
import { GitDialogs } from './GitDialogs';
import { useProjectColor } from '../projectColors';
import { zoomBy } from '../uiSettings';
import { RecentFiles, TOOL_WINDOWS } from './RecentFiles';
import { DEFAULT_SETTINGS, getSettings, updateEditorSettings } from '../settings';
import { invoke } from '@tauri-apps/api/core';
import { RELEASES_URL, restartToUpdate, useUpdateState } from '../updater';
import { debug, useDebug } from '../debug/manager';
import { UsagesPopup } from './UsagesPopup';
import { registerCommands } from '../keymap/commands';
import { installDispatcher } from '../keymap/dispatcher';
import { lastEditPlace } from '../navHistory';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

interface Props {
  backend: Backend;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
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
        <button type="button" className="icon-btn small" aria-label={`Hide ${title}`} title="Hide" onClick={onHide}>
          <Icon name="minus" size={14} />
        </button>
      </div>
      {children}
    </section>
  );
}

export function WorkspaceView({ backend, onOpenFolder, onOpenPath, onClose }: Props) {
  const ws = useWorkspace(backend);
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
  const [leftWidth, setLeftWidth] = useState(330);
  const [leftTopHeight, setLeftTopHeight] = useState(430);
  const [rightTopHeight, setRightTopHeight] = useState(430);
  const [rightWidth, setRightWidth] = useState(340);
  const [bottomHeight, setBottomHeight] = useState(230);
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
    const setHeight = side === 'left' ? setLeftTopHeight : setRightTopHeight;
    return (
      <div className="column" style={{ width: side === 'left' ? leftWidth : rightWidth }}>
        {top && toolWindow(top, bottom ? { flex: `0 0 ${height}px` } : undefined)}
        {top && bottom && <Splitter dir="h" onDrag={(d) => setHeight((h) => clamp(h + d, 120, window.innerHeight - 260))} />}
        {bottom && toolWindow(bottom)}
      </div>
    );
  };
  const leftColumn = column('left');
  const rightColumn = column('right');
  const projectColor = useProjectColor(ws.backend.root, ws.backend.name);

  return (
    <div className="app" style={{ ['--project-color' as string]: projectColor }}>
      <ErrorBoundary name="Toolbar">
        <TopBar ws={ws} onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onClose={onClose} onSearch={openSearch} />
      </ErrorBoundary>
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
            <Splitter dir="v" onDrag={(d) => setLeftWidth((w) => clamp(w + d, 200, 700))} />
          </>
        )}

        <div className="center">
          <ErrorBoundary name="Editor">
            <EditorArea ws={ws} />
          </ErrorBoundary>
          {bottomShown && (
            <>
              <Splitter dir="h" onDrag={(d) => setBottomHeight((h) => clamp(h - d, 90, window.innerHeight - 200))} />
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
            <Splitter dir="v" onDrag={(d) => setRightWidth((w) => clamp(w - d, 220, 720))} />
            {rightColumn}
          </>
        )}
        <ToolStrip side="right" groups={[stripGroup('rightTop'), stripGroup('rightBottom')]} drag={drag} onDragStart={startDrag} onPick={(id) => ws.toggleTool(id as Tool)} />
      </div>
      {dropArea && <div className="tool-drop-area" style={dropArea} />}
      {drag && (
        <div className="tool-drag-ghost" style={{ left: drag.x - 15, top: drag.y - 15 }}>
          <Icon name={drag.icon} size={17} />
        </div>
      )}
      <ErrorBoundary name="Status bar">
        <StatusBar ws={ws} />
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

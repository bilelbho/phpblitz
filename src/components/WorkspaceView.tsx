import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Backend } from '../backend/types';
import { useWorkspace, type BottomTab, type LeftTool, type RightTool } from '../useWorkspace';
import { Icon } from './Icon';
import { Splitter } from './Splitter';
import { TopBar } from './TopBar';
import { ToolStrip, type StripItem } from './ToolStrip';
import { ProjectTree } from './ProjectTree';
import { CommitPanel } from './CommitPanel';
import { StructurePanel } from './StructurePanel';
import { DatabasePanel } from './DatabasePanel';
import { EditorArea } from './EditorArea';
import { BottomPanel } from './BottomPanel';
import { NotificationsPanel } from './NotificationsPanel';
import { AiPanel } from './AiPanel';
import { EndpointsPanel } from './EndpointsPanel';
import { ComposerPanel } from './ComposerPanel';
import { StatusBar } from './StatusBar';
import { SearchEverywhere, type SearchTab } from './SearchEverywhere';
import { FindInFiles } from './FindInFiles';
import { SettingsDialog } from './SettingsDialog';
import { GitDialogs } from './GitDialogs';
import { useProjectColor } from '../projectColors';
import { zoomBy } from '../uiSettings';
import { RecentFiles, TOOL_WINDOWS } from './RecentFiles';
import { getSettings } from '../settings';
import { debug, useDebug } from '../debug/manager';

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
  const [leftWidth, setLeftWidth] = useState(330);
  const [leftTopHeight, setLeftTopHeight] = useState(430);
  const [rightWidth, setRightWidth] = useState(340);
  const [bottomHeight, setBottomHeight] = useState(230);
  const openSearch = ws.openSearch;

  // Double Shift: Search Everywhere. Ctrl+N / Ctrl+Shift+N: class / file. Ctrl+K: commit. Ctrl+S outside the editor.
  const lastShift = useRef(0);
  const otherKey = useRef(false);
  const latest = useRef({ ws, openSearch });
  latest.current = { ws, openSearch };
  useEffect(() => {
    /** Keys typed in a terminal go to the shell (Settings ▸ Tools ▸ Terminal ▸ Override IDE shortcuts). */
    const forShell = (e: KeyboardEvent) => getSettings().terminal.overrideIdeShortcuts && !!(e.target as HTMLElement | null)?.closest?.('.xterm');
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') otherKey.current = true;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && e.altKey && key === 's') {
        e.preventDefault();
        latest.current.ws.openSettings('terminal');
        return;
      }
      if (e.altKey && e.shiftKey && !ctrl && (e.code === 'Equal' || e.code === 'Minus' || e.code === 'Digit0' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        zoomBy(e.code === 'Digit0' ? 'reset' : e.code === 'Equal' || e.code === 'NumpadAdd' ? 10 : -10);
        return;
      }
      if (forShell(e)) return;
      // Ctrl+E: Recent Files (inside the popup, Ctrl+E toggles "edited only").
      if (ctrl && !e.shiftKey && !e.altKey && key === 'e') {
        e.preventDefault();
        latest.current.ws.setRecentOpen(true);
        return;
      }
      // Tool window shortcuts (Alt+1 Project, Alt+0 Commit, Alt+F12 Terminal…), as listed in Recent Files.
      if (e.altKey && !ctrl && !e.shiftKey) {
        const combo = `Alt+${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
        const tool = TOOL_WINDOWS.find((t) => t.shortcut === combo);
        if (tool) {
          e.preventDefault();
          tool.run(latest.current.ws);
          return;
        }
      }
      const inEditor = (e.target as HTMLElement | null)?.closest?.('.monaco-editor');
      // Browser defaults that don't belong in an IDE: reload (Ctrl+R, F5) and the web view's own find (Ctrl+F).
      if ((ctrl && (key === 'r' || key === 'f')) || e.key === 'F5') e.preventDefault();
      if (ctrl && e.shiftKey && (key === 'f' || key === 'r') && !inEditor) {
        latest.current.ws.openFindInFiles(key === 'f' ? 'find' : 'replace', window.getSelection()?.toString().split('\n')[0] ?? '');
        return;
      }
      if (ctrl && key === 's' && !inEditor) {
        e.preventDefault();
        latest.current.ws.saveActive();
      } else if (ctrl && key === 'n') {
        e.preventDefault();
        latest.current.openSearch(e.shiftKey ? 'files' : 'classes');
      } else if (ctrl && e.shiftKey && key === 'a') {
        e.preventDefault();
        latest.current.openSearch('actions');
      } else if (ctrl && e.shiftKey && key === 'k') {
        e.preventDefault();
        if (latest.current.ws.git) latest.current.ws.setGitDialog({ kind: 'push' });
      } else if (ctrl && key === 't' && !e.shiftKey) {
        e.preventDefault();
        if (latest.current.ws.git) latest.current.ws.runGit('Update project', () => latest.current.ws.gitRepo.pull());
      } else if (ctrl && key === 'k') {
        e.preventDefault();
        latest.current.ws.showLeft('commit');
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || forShell(e)) return;
      const now = Date.now();
      if (!otherKey.current && now - lastShift.current < 350) {
        latest.current.openSearch('all');
        lastShift.current = 0;
      } else {
        lastShift.current = now;
      }
      otherKey.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const debugState = useDebug();
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const s = debug.active;
      if (!s) return;
      const stopped = s.status === 'break';
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      let action: (() => void) | null = null;
      if (e.key === 'F9' && plain && !e.shiftKey && stopped) action = debug.resume;
      else if (e.key === 'F8' && plain && !e.shiftKey && stopped) action = debug.stepOver;
      else if (e.key === 'F8' && plain && e.shiftKey && stopped) action = debug.stepOut;
      else if (e.key === 'F7' && plain && !e.shiftKey && stopped) action = debug.stepInto;
      else if (e.key === 'F2' && e.ctrlKey && !e.altKey && s.status !== 'stopped') action = () => void debug.stop();
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, []);

  const changeCount = ws.git?.changes.length ?? 0;
  const problemCount = Object.values(ws.problems).flat().length;
  const bottomActive = (t: BottomTab) => ws.bottomOpen && ws.bottomTab === t;

  const leftItems: StripItem[] = [
    { id: 'project', label: 'Project', icon: 'folder', active: ws.leftTop === 'project' },
    { id: 'commit', label: 'Commit', icon: 'commit', active: ws.leftTop === 'commit', dot: changeCount > 0 },
    { id: 'database', label: 'Database', icon: 'database', active: ws.leftTop === 'database' },
    { id: 'structure', label: 'Structure', icon: 'structure', active: ws.leftBottom === 'structure', sepBefore: true },
  ];
  const leftBottomItems: StripItem[] = [
    { id: 'tests', label: 'Run', icon: 'run', active: bottomActive('tests') },
    { id: 'debug', label: 'Debug', icon: 'bug', active: bottomActive('debug'), dot: debugState.sessions.some((s) => s.status === 'break') },
    { id: 'terminal', label: 'Terminal', icon: 'terminal', active: bottomActive('terminal') },
    { id: 'problems', label: 'Problems', icon: 'error', active: bottomActive('problems'), dot: problemCount > 0 },
    { id: 'composer', label: 'Composer Log', icon: 'box', active: bottomActive('composer') },
    { id: 'git', label: 'Git', icon: 'git', active: bottomActive('git') },
  ];
  const rightItems: StripItem[] = [
    { id: 'notifications', label: 'Notifications', icon: 'bell', active: ws.rightTool === 'notifications', count: ws.notices.length },
    { id: 'ai', label: 'AI Assistant', icon: 'sparkle', active: ws.rightTool === 'ai' },
    { id: 'endpoints', label: 'Endpoints', icon: 'route', active: ws.rightTool === 'endpoints' },
    { id: 'composer', label: 'Composer', icon: 'box', active: ws.rightTool === 'composer', dot: !!ws.outdated && Object.keys(ws.outdated).length > 0 },
  ];

  const toggleBottom = (t: string) => {
    const tab = t as BottomTab;
    if (bottomActive(tab)) ws.setBottomOpen(false);
    else ws.showBottom(tab);
  };

  const leftTitles: Record<Exclude<LeftTool, 'structure'>, [string, string]> = {
    project: ['Project', ''],
    commit: ['Commit', ''],
    database: ['Database', ws.backend.kind === 'sample' ? 'sample data' : ''],
  };
  const rightTitles: Record<RightTool, [string, string]> = {
    notifications: ['Notifications', ''],
    ai: ['AI Assistant', 'mock replies'],
    endpoints: ['Endpoints', `${ws.routes.length} routes`],
    composer: ['Composer', 'composer.json'],
  };

  const leftOpen = !!ws.leftTop || !!ws.leftBottom;
  const projectColor = useProjectColor(ws.backend.root, ws.backend.name);

  return (
    <div className="app" style={{ ['--project-color' as string]: projectColor }}>
      <TopBar ws={ws} onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onClose={onClose} onSearch={openSearch} />
      <div className="main">
        <ToolStrip side="left" items={leftItems} bottomItems={leftBottomItems} onPick={(id) => (leftBottomItems.some((b) => b.id === id) ? toggleBottom(id) : ws.toggleLeft(id as LeftTool))} />

        {leftOpen && (
          <>
            <div className="column" style={{ width: leftWidth }}>
              {ws.leftTop === 'project' && (
                // The Project tool window draws its own PhpStorm-style header.
                <section className="island side" aria-label="Project" style={{ position: 'relative', ...(ws.leftBottom ? { flex: `0 0 ${leftTopHeight}px` } : {}) }}>
                  <ProjectTree ws={ws} onHide={() => ws.toggleLeft('project')} />
                </section>
              )}
              {ws.leftTop && ws.leftTop !== 'project' && (
                <ToolWindow
                  title={leftTitles[ws.leftTop][0]}
                  hint={leftTitles[ws.leftTop][1]}
                  onHide={() => ws.toggleLeft(ws.leftTop!)}
                  style={ws.leftBottom ? { flex: `0 0 ${leftTopHeight}px` } : undefined}
                >
                  {ws.leftTop === 'commit' && <CommitPanel ws={ws} />}
                  {ws.leftTop === 'database' && <DatabasePanel ws={ws} />}
                </ToolWindow>
              )}
              {ws.leftTop && ws.leftBottom && <Splitter dir="h" onDrag={(d) => setLeftTopHeight((h) => clamp(h + d, 120, window.innerHeight - 260))} />}
              {ws.leftBottom && (
                <ToolWindow title="Structure" onHide={() => ws.toggleLeft('structure')}>
                  <StructurePanel ws={ws} />
                </ToolWindow>
              )}
            </div>
            <Splitter dir="v" onDrag={(d) => setLeftWidth((w) => clamp(w + d, 200, 700))} />
          </>
        )}

        <div className="center">
          <EditorArea ws={ws} />
          {ws.bottomOpen && (
            <>
              <Splitter dir="h" onDrag={(d) => setBottomHeight((h) => clamp(h - d, 90, window.innerHeight - 200))} />
              <BottomPanel ws={ws} height={bottomHeight} />
            </>
          )}
        </div>

        {ws.rightTool && (
          <>
            <Splitter dir="v" onDrag={(d) => setRightWidth((w) => clamp(w - d, 220, 720))} />
            <div className="column" style={{ width: rightWidth }}>
              <ToolWindow title={rightTitles[ws.rightTool][0]} hint={rightTitles[ws.rightTool][1]} onHide={() => ws.toggleRight(ws.rightTool!)}>
                {ws.rightTool === 'notifications' && <NotificationsPanel ws={ws} />}
                {ws.rightTool === 'ai' && <AiPanel ws={ws} />}
                {ws.rightTool === 'endpoints' && <EndpointsPanel ws={ws} />}
                {ws.rightTool === 'composer' && <ComposerPanel ws={ws} />}
              </ToolWindow>
            </div>
          </>
        )}
        <ToolStrip side="right" items={rightItems} onPick={(id) => ws.toggleRight(id as RightTool)} />
      </div>
      <StatusBar ws={ws} />
      {ws.findInFiles && <FindInFiles ws={ws} />}
      <GitDialogs ws={ws} />
      {ws.recentOpen && <RecentFiles ws={ws} onClose={() => ws.setRecentOpen(false)} />}
      {ws.settingsPage && <SettingsDialog ws={ws} page={ws.settingsPage} onClose={ws.closeSettings} />}
      {ws.searchOpen && (
        <SearchEverywhere
          ws={ws}
          initialTab={ws.searchTab}
          onClose={() => ws.setSearchOpen(false)}
          actions={{ openFolder: onOpenFolder, closeProject: onClose }}
        />
      )}
    </div>
  );
}

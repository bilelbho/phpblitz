import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import type { Backend } from './backend/types';
import { DiskBackend } from './backend/disk';
import { SampleBackend } from './backend/sample';
import { isTauri, pickFolder, rememberProject } from './platform';
import { useApplyUiSettings } from './uiSettings';
import { getSettings, useSettings } from './settings';
import { Welcome } from './components/Welcome';
import { WorkspaceView } from './components/lazy';
import { projectStorage } from './projectStorage';
import { perf } from './perf';
import { startUpdateChecks } from './updater';
import { ErrorBoundary } from './components/ErrorBoundary';
import { syncMcpServer } from './mcp';

const OPEN_PROJECT_KEY = 'phpblitz.openProject';

/** The project open when PHPBlitz last closed (none: it was on the welcome screen). */
function openProjectAtExit(): string | null {
  try {
    return localStorage.getItem(OPEN_PROJECT_KEY);
  } catch {
    return null;
  }
}

function setOpenProject(root: string | null) {
  try {
    if (root) localStorage.setItem(OPEN_PROJECT_KEY, root);
    else localStorage.removeItem(OPEN_PROJECT_KEY);
  } catch {
    // Only a convenience.
  }
}

/** The welcome window's size (as in tauri.conf.json). */
const WELCOME_SIZE = { width: 820, height: 620 };

export default function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  /** Startup: deciding whether to reopen the project that was open when PHPBlitz closed. */
  const [starting, setStarting] = useState(() => isTauri && getSettings().ui.reopenLastProject && !!openProjectAtExit());

  const openPath = useCallback(async (path: string) => {
    const b = new DiskBackend(path);
    rememberProject(b.root);
    perf.begin(b.root);
    // Its .blitz settings first: the workspace reads them as it opens.
    await perf.time('Project settings (.blitz)', projectStorage.open(b.root));
    // The spell checker (and with it the code editor) loads with the project, not at startup.
    void import('./editor/spelling').then((m) => m.openProjectDictionary(b.root));
    setOpenProject(b.root);
    setBackend(b);
  }, []);

  const openFolder = useCallback(async () => {
    const path = await pickFolder();
    if (path) openPath(path);
  }, [openPath]);

  const openSample = useCallback(() => {
    setOpenProject(null);
    void projectStorage.close();
    perf.begin('sample project');
    setBackend(new SampleBackend());
  }, []);

  // The project open when PHPBlitz was closed opens again (not if the welcome screen was showing).
  useEffect(() => {
    if (!starting) return;
    const root = openProjectAtExit()!;
    invoke('list_dir', { path: root })
      .then(() => openPath(root))
      .catch(() => setOpenProject(null))
      .finally(() => setStarting(false));
    // Once, at startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useApplyUiSettings();
  useEffect(startUpdateChecks, []);
  const ghostText = useSettings().ai.ghostText;
  useEffect(() => {
    if (ghostText && isTauri) void import('./ai/ghost').then((m) => m.registerGhostText());
  }, [ghostText]);
  const ai = useSettings().ai;
  useEffect(() => {
    void syncMcpServer(ai);
  }, [ai]);
  const fullPath = useSettings().ui.fullPathInTitle;
  useEffect(() => {
    const title = backend ? `${fullPath && backend.kind === 'disk' ? backend.root : backend.name} – PHPBlitz` : 'PHPBlitz';
    document.title = title;
    if (isTauri) getCurrentWindow().setTitle(title).catch(() => {});
  }, [backend, fullPath]);

  // A small centered welcome window, maximized once a project is open.
  const hasProject = !!backend;
  useEffect(() => {
    if (!isTauri || starting) return;
    const win = getCurrentWindow();
    const apply = hasProject
      ? async () => {
          await win.setMinSize(new LogicalSize(900, 600));
          await win.maximize();
        }
      : async () => {
          await win.unmaximize();
          await win.setMinSize(new LogicalSize(640, 480));
          await win.setSize(new LogicalSize(WELCOME_SIZE.width, WELCOME_SIZE.height));
          await win.center();
        };
    // The window starts hidden (tauri.conf.json): shown once it has its size, so a reopened project
    // never flashes a small empty window first.
    apply()
      .catch(() => {})
      .finally(() => void win.show().catch(() => {}));
  }, [hasProject, starting]);

  // The demo project is only for the browser preview (npm run dev), where folders cannot be opened.
  // Last resort: anything not caught closer (each panel has its own) shows a message, not a blank window.
  // Reopening the last project: nothing to show for the few milliseconds that takes.
  if (!backend && starting) return null;
  if (!backend)
    return (
      <ErrorBoundary name="PHPBlitz" variant="window">
        <Welcome onOpenFolder={openFolder} onOpenPath={openPath} onOpenSample={isTauri ? undefined : openSample} />
      </ErrorBoundary>
    );
  return (
    <ErrorBoundary name="PHPBlitz" variant="window">
      <WorkspaceView
        key={`${backend.kind}:${backend.root}`}
        backend={backend}
        onOpenFolder={openFolder}
        onOpenPath={openPath}
        onClose={() => {
          setOpenProject(null);
          void projectStorage.close();
          setBackend(null);
        }}
      />
    </ErrorBoundary>
  );
}

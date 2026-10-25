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
import { TrustDialog } from './components/TrustDialog';
import { isTrusted, restrictProject } from './trust';
import { finishOnboarding, needsOnboarding, OPEN_ONBOARDING } from './onboarding';
import { Onboarding } from './components/Onboarding';
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
/** Onboarding without a project open: room for its choices. */
const ONBOARDING_SIZE = { width: 960, height: 820 };

export default function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  /** Startup: deciding whether to reopen the project that was open when PHPBlitz closed. */
  const [starting, setStarting] = useState(() => isTauri && getSettings().ui.reopenLastProject && !!openProjectAtExit());

  /** The trust question for a project about to open: answered true (trust) or false (Restricted Mode). */
  const [asking, setAsking] = useState<{ root: string; answer: (trusted: boolean) => void } | null>(null);
  /** Counts opens: opening the same project again (after trusting it) starts it fresh. */
  const [opens, setOpens] = useState(0);
  /** The onboarding screen: on the first launch, and from Help ▸ Onboarding or Customize. */
  const [onboarding, setOnboarding] = useState(() => isTauri && needsOnboarding());
  useEffect(() => {
    const show = () => setOnboarding(true);
    window.addEventListener(OPEN_ONBOARDING, show);
    return () => window.removeEventListener(OPEN_ONBOARDING, show);
  }, []);
  const finishSetup = useCallback(() => {
    finishOnboarding();
    setOnboarding(false);
  }, []);

  const openPath = useCallback(async (path: string, opts?: { trusted?: boolean }) => {
    const b = new DiskBackend(path);
    // Asked before anything runs: a project not trusted yet opens in Restricted Mode unless trusted now.
    const trusted = opts?.trusted || isTrusted(b.root) || (await new Promise<boolean>((resolve) => setAsking({ root: b.root, answer: resolve })));
    setAsking(null);
    b.restricted = !trusted;
    await restrictProject(b.root, !trusted);
    rememberProject(b.root);
    perf.begin(b.root);
    // Its .blitz settings first: the workspace reads them as it opens.
    await perf.time('Project settings (.blitz)', projectStorage.open(b.root));
    // The spell checker (and with it the code editor) loads with the project, not at startup.
    void import('./editor/spelling').then((m) => m.openProjectDictionary(b.root));
    setOpenProject(b.root);
    setOpens((n) => n + 1);
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
      .then(() => {
        // The trust question needs the window: shown first (as the welcome window behind it).
        if (!isTrusted(root)) setStarting(false);
        return openPath(root);
      })
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
          const size = onboarding ? ONBOARDING_SIZE : WELCOME_SIZE;
          await win.unmaximize();
          await win.setMinSize(new LogicalSize(640, 480));
          await win.setSize(new LogicalSize(size.width, size.height));
          await win.center();
        };
    // The window starts hidden (tauri.conf.json): shown once it has its size, so a reopened project
    // never flashes a small empty window first.
    apply()
      .catch(() => {})
      .finally(() => void win.show().catch(() => {}));
  }, [hasProject, starting, onboarding]);

  // The demo project is only for the browser preview (npm run dev), where folders cannot be opened.
  // Last resort: anything not caught closer (each panel has its own) shows a message, not a blank window.
  // Reopening the last project: nothing to show for the few milliseconds that takes.
  const trustQuestion = asking && <TrustDialog root={asking.root} onTrust={() => asking.answer(true)} onRestricted={() => asking.answer(false)} />;
  if (!backend && starting) return null;
  if (!backend && onboarding)
    return (
      <ErrorBoundary name="PHPBlitz" variant="window">
        <Onboarding onFinish={finishSetup} />
      </ErrorBoundary>
    );
  if (!backend)
    return (
      <ErrorBoundary name="PHPBlitz" variant="window">
        <Welcome onOpenFolder={openFolder} onOpenPath={openPath} onOpenSample={isTauri ? undefined : openSample} />
        {trustQuestion}
      </ErrorBoundary>
    );
  return (
    <ErrorBoundary name="PHPBlitz" variant="window">
      {trustQuestion}
      <WorkspaceView
        key={`${backend.kind}:${backend.root}:${opens}`}
        backend={backend}
        onOpenFolder={openFolder}
        onOpenPath={openPath}
        onClose={() => {
          if (backend.restricted) void restrictProject(backend.root, false);
          setOpenProject(null);
          void projectStorage.close();
          setBackend(null);
        }}
      />
      {/* Over the open project: the workspace stays as it is underneath. */}
      {onboarding && (
        <div className="onboarding-over">
          <Onboarding onFinish={finishSetup} />
        </div>
      )}
    </ErrorBoundary>
  );
}

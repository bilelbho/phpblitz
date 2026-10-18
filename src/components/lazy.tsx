// Parts of the UI loaded the first time they are shown, so the app starts with less to parse:
// the workspace (with the code editor, three quarters of the bundle) when a project opens, the
// terminal (xterm) when a terminal opens, and tool windows when first opened.

import { lazy, Suspense, type ComponentProps, type ComponentType, type ReactNode } from 'react';

function lazyNamed<T extends ComponentType<any>>(load: () => Promise<T>, fallback: ReactNode = <div className="empty">Loading…</div>) {
  const Component = lazy(async () => ({ default: await load() }));
  return function Lazy(props: ComponentProps<T>) {
    return (
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    );
  };
}

export const WorkspaceView = lazyNamed(() => import('./WorkspaceView').then((m) => m.WorkspaceView), <div className="app-loading" />);
export const DatabasePanel = lazyNamed(() => import('./DatabasePanel').then((m) => m.DatabasePanel));
export const DebugPanel = lazyNamed(() => import('./DebugPanel').then((m) => m.DebugPanel));
export const GitToolWindow = lazyNamed(() => import('./GitToolWindow').then((m) => m.GitToolWindow));
export const TodoToolWindow = lazyNamed(() => import('./TodoToolWindow').then((m) => m.TodoToolWindow));
export const TerminalView = lazyNamed(() => import('./TerminalView').then((m) => m.TerminalView));
export const MarkdownView = lazyNamed(() => import('./MarkdownView').then((m) => m.MarkdownView));
export const StartupPerformance = lazyNamed(() => import('./StartupPerformance').then((m) => m.StartupPerformance), null);
export const AboutDialog = lazyNamed(() => import('./AboutDialog').then((m) => m.AboutDialog), null);
export const SettingsDialog = lazyNamed(() => import('./SettingsDialog').then((m) => m.SettingsDialog), null);

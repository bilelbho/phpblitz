import { ask, open } from '@tauri-apps/plugin-dialog';

/** True inside the Tauri desktop window, false in a plain browser (npm run dev). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function confirmDialog(message: string): Promise<boolean> {
  if (isTauri) return ask(message, { title: 'PHPBlitz', kind: 'warning' });
  return window.confirm(message);
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const picked = await open({ directory: true, multiple: false, title: 'Open project folder' });
  return typeof picked === 'string' ? picked : null;
}

const RECENT_KEY = 'phpblitz.recentProjects';

export function recentProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function rememberProject(root: string) {
  try {
    const list = [root, ...recentProjects().filter((r) => r !== root)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage can be unavailable; recent projects are only a convenience.
  }
}

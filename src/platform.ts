import { ask, message, open } from '@tauri-apps/plugin-dialog';

/** True inside the Tauri desktop window, false in a plain browser (npm run dev). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function confirmDialog(message: string): Promise<boolean> {
  if (isTauri) return ask(message, { title: 'PHPBlitz', kind: 'warning' });
  return window.confirm(message);
}

/** Save / Don't Save / Cancel, for unsaved files about to be left behind. */
export async function askUnsaved(text: string): Promise<'save' | 'discard' | 'cancel'> {
  if (!isTauri) return window.confirm(`${text}

OK saves them first.`) ? 'save' : 'cancel';
  const picked = await message(text, { title: 'PHPBlitz', kind: 'warning', buttons: { yes: 'Save', no: "Don't Save", cancel: 'Cancel' } });
  return picked === 'Save' ? 'save' : picked === "Don't Save" ? 'discard' : 'cancel';
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

export function forgetProject(root: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentProjects().filter((r) => r !== root)));
  } catch {
    // Only a convenience.
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

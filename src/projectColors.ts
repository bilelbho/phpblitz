import { useEffect, useReducer } from 'react';

// Project colors: each project gets one (picked from its name, or chosen in the project popup),
// shown on its badge and as a glow over the main toolbar and tool window bars.

export const PROJECT_PALETTE = ['#3d7a4b', '#3574f0', '#9b5fc0', '#c2803a', '#2a8f96', '#c25863', '#5b7cc2', '#7d8f2e', '#b0569b', '#4f8a8b'];

/** Chosen as a project's color: none (a gray badge, no glow over the toolbar). */
export const NO_PROJECT_COLOR = 'none';
const NEUTRAL = '#6f737a';

const KEY = 'phpblitz.projectColors';

function chosen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** A project's color: chosen by the user (gray for no color), else derived from its name. */
export function colorOfProject(root: string, name: string): string {
  const custom = chosen()[root];
  if (custom === NO_PROJECT_COLOR) return NEUTRAL;
  if (custom) return custom;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PROJECT_PALETTE[h % 8];
}

/** No color chosen for the project: its badge is gray, and the toolbar has no glow. */
export const projectHasNoColor = (root: string) => chosen()[root] === NO_PROJECT_COLOR;

/** `color`: a palette color, NO_PROJECT_COLOR, or null for the one derived from the name. */
export function setProjectColor(root: string, color: string | null) {
  const all = chosen();
  if (color) all[root] = color;
  else delete all[root];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Only a preference.
  }
  projectColorChanged();
}

/** "AS" for acme-shop, "BP" for billing-portal. */
export function projectInitials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean);
  return (parts.length > 1 ? parts.slice(0, 2).map((w) => w[0]) : [name.slice(0, 1)]).join('').toUpperCase() || 'P';
}

/** "~\Desktop\workspace\x" on Windows, "~/code/x" elsewhere. */
export function shortPath(path: string): string {
  const home = path.match(/^([A-Za-z]:\/Users\/[^/]+|\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/);
  const short = home ? '~' + path.slice(home[1].length) : path;
  return /^[A-Za-z]:\//.test(path) ? short.replace(/\//g, '\\') : short;
}

const EVENT = 'phpblitz:project-color';

/** Tells open views that a project color changed. */
export function projectColorChanged() {
  window.dispatchEvent(new Event(EVENT));
}

/** The color of a project, updated when it changes. */
export function useProjectColor(root: string, name: string): string {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    window.addEventListener(EVENT, bump);
    return () => window.removeEventListener(EVENT, bump);
  }, []);
  return colorOfProject(root, name);
}

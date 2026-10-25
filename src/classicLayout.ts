// The Classic layout as it was left: which tool window is open in each place, the bottom panel and
// the sizes, saved for each project as they change (.blitz/workspace.json, this machine only), and
// the last one used for projects opened the first time. Where each tool window lives (the strips)
// is kept apart, for every project (toolLayout.ts).

import { projectStorage } from './projectStorage';
import { isBottomTool, SIDE_ANCHORS, type SideAnchor, type SideTool, type Tool, type ToolLayout } from './toolLayout';

/** The bottom panel's tabs that are kept (Find and Usages results are gone after a restart). */
const BOTTOM_TABS = ['problems', 'terminal', 'tests', 'composer', 'git', 'debug', 'todo'] as const;
export type SavedBottomTab = (typeof BOTTOM_TABS)[number];

export interface ClassicSizes {
  leftWidth: number;
  rightWidth: number;
  /** The top tool window's height when a side has two. */
  leftTopHeight: number;
  rightTopHeight: number;
  bottomHeight: number;
}

export interface ClassicState {
  open: Record<SideAnchor, Tool | null>;
  bottomOpen: boolean;
  bottomTab: SavedBottomTab;
  /** A side tool window dragged into the bottom panel and open there. */
  bottomSideTool: SideTool | null;
  sizes: ClassicSizes;
}

export const CLASSIC_START: ClassicState = {
  open: { leftTop: 'project', leftBottom: null, rightTop: null, rightBottom: null },
  bottomOpen: true,
  bottomTab: 'problems',
  bottomSideTool: null,
  sizes: { leftWidth: 330, rightWidth: 340, leftTopHeight: 430, rightTopHeight: 430, bottomHeight: 230 },
};

/** A saved state read back: what still fits the tool windows' places (`layout`), the rest as at the start. */
export function classicStateFrom(saved: unknown, layout: ToolLayout): ClassicState {
  const v = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof ClassicState, unknown>>;
  const from = (v.open && typeof v.open === 'object' ? v.open : CLASSIC_START.open) as Record<string, unknown>;
  const open = { ...CLASSIC_START.open };
  // A tool window opens in a place only when it still lives there (it may have been dragged since).
  for (const anchor of SIDE_ANCHORS) {
    const t = from[anchor];
    open[anchor] = typeof t === 'string' && layout[anchor].includes(t as Tool) ? (t as Tool) : null;
  }
  const savedSizes = (v.sizes && typeof v.sizes === 'object' ? v.sizes : {}) as Record<string, unknown>;
  const sizes = { ...CLASSIC_START.sizes };
  for (const key of Object.keys(sizes) as (keyof ClassicSizes)[]) {
    const n = savedSizes[key];
    if (typeof n === 'number' && Number.isFinite(n)) sizes[key] = Math.min(3000, Math.max(80, Math.round(n)));
  }
  const side = v.bottomSideTool;
  return {
    open,
    bottomOpen: typeof v.bottomOpen === 'boolean' ? v.bottomOpen : CLASSIC_START.bottomOpen,
    bottomTab: (BOTTOM_TABS as readonly unknown[]).includes(v.bottomTab) ? (v.bottomTab as SavedBottomTab) : CLASSIC_START.bottomTab,
    bottomSideTool: typeof side === 'string' && !isBottomTool(side as Tool) && layout.bottom.includes(side as Tool) ? (side as SideTool) : null,
    sizes,
  };
}

const projectKey = (root: string) => `phpblitz.classicLayout:${root}`;
const LAST_KEY = 'phpblitz.classicLayout.last';

function read(get: () => string | null): unknown {
  try {
    const text = get();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The project's state, else the last one used anywhere, else the start. */
export function loadClassicLayout(root: string, layout: ToolLayout): ClassicState {
  const saved = read(() => projectStorage.getItem(projectKey(root))) ?? read(() => localStorage.getItem(LAST_KEY));
  return classicStateFrom(saved, layout);
}

let timer = 0;
/** Saves the state soon (a splitter drag changes it on every mouse move). */
export function saveClassicLayout(root: string, state: ClassicState) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const text = JSON.stringify(state);
    projectStorage.setItem(projectKey(root), text);
    try {
      localStorage.setItem(LAST_KEY, text);
    } catch {
      // Only a convenience.
    }
  }, 300);
}

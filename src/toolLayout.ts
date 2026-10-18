// Where each tool window lives on the tool window bars: four side places (left top, left
// bottom, right top, right bottom) and the bottom panel, each an ordered list of tools. Dragging an
// icon between the strips moves the tool; the layout is kept for every project (Window ▸ Layouts
// restores it).

/** Tool windows that open in a side column by default. */
export type SideTool = 'project' | 'commit' | 'database' | 'structure' | 'notifications' | 'ai' | 'endpoints' | 'composer' | 'npm';
/** Tool windows that open in the bottom panel by default ('composerLog' is the bottom "Composer" tab). */
export type BottomTool = 'tests' | 'debug' | 'terminal' | 'problems' | 'composerLog' | 'git' | 'todo';
export type Tool = SideTool | BottomTool;

export type SideAnchor = 'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom';
export type Anchor = SideAnchor | 'bottom';
export type ToolLayout = Record<Anchor, Tool[]>;

export const SIDE_ANCHORS: SideAnchor[] = ['leftTop', 'leftBottom', 'rightTop', 'rightBottom'];
export const ANCHORS: Anchor[] = [...SIDE_ANCHORS, 'bottom'];

export const ANCHOR_LABELS: Record<Anchor, string> = {
  leftTop: 'Left Top',
  leftBottom: 'Left Bottom',
  rightTop: 'Right Top',
  rightBottom: 'Right Bottom',
  bottom: 'Bottom',
};

export const DEFAULT_LAYOUT: ToolLayout = {
  leftTop: ['project', 'commit', 'database'],
  leftBottom: ['structure'],
  rightTop: ['notifications', 'ai', 'endpoints', 'composer', 'npm'],
  rightBottom: [],
  bottom: ['tests', 'debug', 'terminal', 'problems', 'composerLog', 'git', 'todo'],
};

export const BOTTOM_TOOLS = DEFAULT_LAYOUT.bottom as BottomTool[];
export const isBottomTool = (t: Tool): t is BottomTool => (BOTTOM_TOOLS as Tool[]).includes(t);

const ALL = Object.values(DEFAULT_LAYOUT).flat();
const KEY = 'phpblitz.toolLayout';

/** The saved layout, with tools it doesn't mention (added in a newer version) in their default place. */
export function loadToolLayout(): ToolLayout {
  let saved: Partial<ToolLayout> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    // Unreadable: the default.
  }
  const seen = new Set<Tool>();
  const layout = {} as ToolLayout;
  for (const anchor of ANCHORS) {
    layout[anchor] = (Array.isArray(saved[anchor]) ? saved[anchor]! : []).filter((t) => ALL.includes(t) && !seen.has(t) && seen.add(t));
  }
  for (const anchor of ANCHORS) for (const tool of DEFAULT_LAYOUT[anchor]) if (!seen.has(tool)) layout[anchor].push(tool);
  return layout;
}

export function saveToolLayout(layout: ToolLayout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Only a preference.
  }
}

export function anchorOf(layout: ToolLayout, tool: Tool): Anchor {
  return ANCHORS.find((a) => layout[a].includes(tool)) ?? (isBottomTool(tool) ? 'bottom' : 'leftTop');
}

/** The layout with `tool` moved to position `index` of `anchor`. */
export function moveTool(layout: ToolLayout, tool: Tool, anchor: Anchor, index: number): ToolLayout {
  const next = {} as ToolLayout;
  for (const a of ANCHORS) next[a] = layout[a].filter((t) => t !== tool);
  // Moving down within the same list: the tool's own slot no longer counts.
  const from = layout[anchor].indexOf(tool);
  const at = from >= 0 && from < index ? index - 1 : index;
  next[anchor].splice(Math.max(0, Math.min(at, next[anchor].length)), 0, tool);
  return next;
}

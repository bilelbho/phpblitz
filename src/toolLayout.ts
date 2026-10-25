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

// ── Focus layout ──────────────────────────────────────────────
// The editor tabs are in the top bar; below it, columns side by side, each a stack of groups, each
// group one or more panels shown one at a time (icons switch them). The editor is a panel like the
// others (its column takes the width left); the "sidebar" is a column of one group, Project,
// Structure and Commit. Panels are dragged anywhere: beside a column, above / below a group, or into
// a group. Closing a panel hides its group in place, so opening it again brings it back there.

/** A panel: a tool window, the editor, or the Find / Usages results. */
export type FocusPanel = Tool | 'editor' | 'find' | 'usages';

/** Tool windows with their own toggle in the top bar; the others are in its list. */
export const FOCUS_TOGGLES = ['terminal', 'database', 'ai', 'problems'] as const satisfies readonly Tool[];

/** Every tool window, in the order of the top bar's list. */
export const FOCUS_TOOLS: Tool[] = ALL;
const isTool = (t: unknown): t is Tool => typeof t === 'string' && (ALL as string[]).includes(t);

export interface FocusGroup {
  /** Its panels, in the order of its icons. */
  panels: FocusPanel[];
  /** The one shown. */
  active: FocusPanel;
  /** Closed: kept in its place, shown again when one of its panels opens. */
  hidden: boolean;
  /** Its share of the column's height. */
  weight: number;
  /** Where its icons are (several panels): top when not set. */
  icons?: IconsSide;
}

/** The side of a group its icons are on: left and right as a column. */
export type IconsSide = 'top' | 'bottom' | 'left' | 'right';
const ICON_SIDES: IconsSide[] = ['top', 'bottom', 'left', 'right'];

export interface FocusColumnState {
  groups: FocusGroup[];
  /** Px; the editor's column takes what the others leave. */
  width: number;
}

export interface FocusState {
  columns: FocusColumnState[];
  /** The panel shown alone, over everything else. */
  maximized: FocusPanel | null;
}

const group = (panels: FocusPanel[], active = panels[0], weight = 1): FocusGroup => ({ panels, active, hidden: false, weight });
export const defaultWidth = (p: FocusPanel) => (p === 'terminal' ? 480 : p === 'project' ? 280 : 380);

export const FOCUS_START: FocusState = {
  columns: [
    { width: 280, groups: [group(['project', 'structure', 'commit'])] },
    { width: 0, groups: [group(['editor'])] },
  ],
  maximized: null,
};

/** Where a panel is: its column and group, or null when it isn't placed yet. */
export function findPanel(s: FocusState, p: FocusPanel): { c: number; g: number } | null {
  for (let c = 0; c < s.columns.length; c++) {
    const g = s.columns[c].groups.findIndex((x) => x.panels.includes(p));
    if (g >= 0) return { c, g };
  }
  return null;
}

export const isEditorColumn = (column: FocusColumnState) => column.groups.some((g) => g.panels.includes('editor'));
export const columnShown = (column: FocusColumnState) => column.groups.some((g) => !g.hidden);

/** Shown: its group open, and the one it shows. */
export function panelShown(s: FocusState, p: FocusPanel): boolean {
  const at = findPanel(s, p);
  const g = at && s.columns[at.c].groups[at.g];
  return !!g && !g.hidden && g.active === p;
}

/** Edits the group of `p` (and leaves the rest as it is). */
function withGroup(s: FocusState, p: FocusPanel, change: (g: FocusGroup) => FocusGroup): FocusState {
  const at = findPanel(s, p);
  if (!at) return s;
  return {
    ...s,
    columns: s.columns.map((col, c) => (c !== at.c ? col : { ...col, groups: col.groups.map((g, i) => (i === at.g ? change(g) : g)) })),
  };
}

/** Shows a panel where it is; one not placed yet opens as a column at the right end. Another one maximized is restored. */
export function showPanel(s: FocusState, p: FocusPanel): FocusState {
  const maximized = s.maximized === p ? p : null;
  if (findPanel(s, p)) return { ...withGroup(s, p, (g) => ({ ...g, hidden: false, active: p })), maximized };
  return { columns: [...s.columns, { width: defaultWidth(p), groups: [group([p])] }], maximized };
}

/** Closes the group showing `p`; it stays in its place (the editor is never closed). */
export function hidePanel(s: FocusState, p: FocusPanel): FocusState {
  if (p === 'editor' || !panelShown(s, p)) return s;
  return { ...withGroup(s, p, (g) => ({ ...g, hidden: true })), maximized: s.maximized === p ? null : s.maximized };
}

/** The side of its group the icons are on (the group of `p`). */
export function setIconsSide(s: FocusState, p: FocusPanel, side: IconsSide): FocusState {
  return withGroup(s, p, (g) => {
    const { icons: _, ...rest } = g;
    return side === 'top' ? rest : { ...rest, icons: side };
  });
}

/** The sidebar button: the column left of the editor's closes, or opens again. */
export function toggleFirstColumn(s: FocusState): FocusState {
  const first = s.columns[0];
  if (!first || isEditorColumn(first)) return s;
  const hidden = columnShown(first);
  return { ...s, columns: [{ ...first, groups: first.groups.map((g) => ({ ...g, hidden })) }, ...s.columns.slice(1)] };
}

/** `s` without `p`: out of its group, and the group or column it was alone in gone. */
function takeOut(s: FocusState, p: FocusPanel): FocusState {
  const columns = s.columns
    .map((col) => ({
      ...col,
      groups: col.groups
        .map((g) => (g.panels.includes(p) ? { ...g, panels: g.panels.filter((x) => x !== p), active: g.active === p ? g.panels.find((x) => x !== p)! : g.active } : g))
        .filter((g) => g.panels.length > 0),
    }))
    .filter((col) => col.groups.length > 0);
  return { columns, maximized: null };
}

/**
 * Where a dragged panel goes, next to `ref` (a panel of the group it is dropped on): a column of its
 * own before or after ref's column, a group above / below ref's group, or into ref's group, at
 * `index` of its icons (counted without the dragged one; none: the end).
 */
export type FocusDrop =
  | { kind: 'column'; ref: FocusPanel | null; after: boolean }
  | { kind: 'stack'; ref: FocusPanel; below: boolean }
  | { kind: 'tab'; ref: FocusPanel; index?: number };

/** A panel dropped: open there now. Nothing goes into the editor's group. */
export function movePanel(s: FocusState, p: FocusPanel, drop: FocusDrop): FocusState {
  if (drop.ref === p || (drop.kind === 'tab' && (p === 'editor' || drop.ref === 'editor'))) return s;
  const width = (() => {
    const at = findPanel(s, p);
    const own = at && s.columns[at.c].groups.length === 1 && s.columns[at.c].groups[0].panels.length === 1 ? s.columns[at.c].width : 0;
    return own || defaultWidth(p);
  })();
  const out = takeOut(s, p);
  const at = drop.ref ? findPanel(out, drop.ref) : null;
  if (!at && drop.kind !== 'column') return s;
  const columns = out.columns.map((col) => ({ ...col, groups: col.groups.map((g) => ({ ...g })) }));
  if (drop.kind === 'tab') {
    const g = columns[at!.c].groups[at!.g];
    const panels = [...g.panels];
    panels.splice(Math.max(0, Math.min(drop.index ?? panels.length, panels.length)), 0, p);
    Object.assign(g, { panels, active: p, hidden: false });
  } else if (drop.kind === 'stack') {
    const col = columns[at!.c];
    // The two share the room the one dropped on had.
    const target = col.groups[at!.g];
    target.weight /= 2;
    col.groups.splice(at!.g + (drop.below ? 1 : 0), 0, group([p], p, target.weight));
  } else {
    const index = at ? at.c + (drop.after ? 1 : 0) : columns.length;
    columns.splice(index, 0, { width, groups: [group([p])] });
  }
  return { columns, maximized: null };
}

/** A column `width` px wide, within bounds; the editor's takes what is left. */
export function setColumnWidth(s: FocusState, c: number, width: number, max: number): FocusState {
  return { ...s, columns: s.columns.map((col, i) => (i === c ? { ...col, width: Math.round(Math.min(max, Math.max(200, width))) } : col)) };
}

/** A column `delta` px wider (narrower when negative), within bounds. */
export function resizeColumn(s: FocusState, c: number, delta: number, max: number): FocusState {
  return setColumnWidth(s, c, (s.columns[c]?.width ?? 0) + delta, max);
}

/**
 * The splitter below group `g` of column `c` moved `delta` px (`height`: the column's): the group
 * above and the one below trade their share of the height.
 */
export function resizeGroups(s: FocusState, c: number, g: number, delta: number, height: number): FocusState {
  const col = s.columns[c];
  const shown = col.groups.filter((x) => !x.hidden);
  const [a, b] = [col.groups[g], col.groups.slice(g + 1).find((x) => !x.hidden)];
  if (!a || !b || height <= 0) return s;
  const total = shown.reduce((sum, x) => sum + x.weight, 0);
  const min = (80 / height) * total;
  // Both keep 80 px; two already smaller than that together (a short column of many groups) don't move.
  const [lowest, highest] = [min - a.weight, b.weight - min];
  if (lowest > highest) return s;
  const moved = Math.max(lowest, Math.min(highest, (delta / height) * total));
  return { ...s, columns: s.columns.map((x, i) => (i !== c ? x : { ...x, groups: x.groups.map((y) => (y === a ? { ...y, weight: y.weight + moved } : y === b ? { ...y, weight: y.weight - moved } : y)) })) };
}

/**
 * A saved layout read back (workspace.json, a preset): what still makes sense of it, the rest as
 * at the start. Find / Usages aren't kept: their results are gone. Layouts saved before groups (a
 * sidebar and columns of panels) are read into columns and groups.
 */
export function focusStateFrom(saved: unknown): FocusState {
  const v = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const size = (w: unknown, fallback: number, min: number) => (typeof w === 'number' && Number.isFinite(w) ? Math.min(2000, Math.max(min, Math.round(w))) : fallback);
  const seen = new Set<FocusPanel>();
  const keep = (p: unknown): p is FocusPanel => (isTool(p) || p === 'editor') && !seen.has(p) && !!seen.add(p);
  const groupFrom = (x: unknown): FocusGroup | null => {
    const g = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    let panels = (Array.isArray(g.panels) ? g.panels : []).filter(keep);
    // The editor shares its group with nothing: it gets a column of its own below.
    if (panels.length > 1 && panels.includes('editor')) {
      panels = panels.filter((p) => p !== 'editor');
      seen.delete('editor');
    }
    if (!panels.length) return null;
    const active = panels.includes(g.active as FocusPanel) ? (g.active as FocusPanel) : panels[0];
    const read: FocusGroup = { panels, active, hidden: g.hidden === true && !panels.includes('editor'), weight: typeof g.weight === 'number' && g.weight > 0 && Number.isFinite(g.weight) ? g.weight : 1 };
    return ICON_SIDES.includes(g.icons as IconsSide) && g.icons !== 'top' ? { ...read, icons: g.icons as IconsSide } : read;
  };
  const columns: FocusColumnState[] = [];
  if (Array.isArray(v.columns) && v.columns.every((c) => c && typeof c === 'object' && !Array.isArray(c))) {
    for (const c of v.columns as Record<string, unknown>[]) {
      const groups = (Array.isArray(c.groups) ? c.groups : []).map(groupFrom).filter((g): g is FocusGroup => !!g);
      // The editor's column takes what the others leave: its own width means nothing.
      if (groups.length) columns.push({ groups, width: groups.some((g) => g.panels.includes('editor')) ? 0 : size(c.width, 380, 160) });
    }
  } else {
    // Before groups: { sidebarTools, sidebar, sidebarOpen, sidebarWidth, columns: [[panel…]…] | [panel…], widths, heights }.
    const sidebar = groupFrom({ panels: Array.isArray(v.sidebarTools) ? v.sidebarTools : FOCUS_START.columns[0].groups[0].panels, active: v.sidebar });
    if (sidebar) columns.push({ groups: [{ ...sidebar, hidden: v.sidebarOpen === false }], width: size(v.sidebarWidth, 280, 160) });
    seen.add('editor');
    columns.push({ width: 0, groups: [group(['editor'])] });
    const widths = (v.widths && typeof v.widths === 'object' ? v.widths : {}) as Record<string, unknown>;
    for (const c of Array.isArray(v.columns) ? v.columns : []) {
      const groups = (Array.isArray(c) ? c : [c]).filter(keep).map((p) => group([p]));
      if (groups.length) columns.push({ groups, width: size(widths[groups[0].panels[0]], defaultWidth(groups[0].panels[0]), 160) });
    }
  }
  // The editor is always somewhere.
  if (!seen.has('editor')) columns.splice(Math.min(1, columns.length), 0, { width: 0, groups: [group(['editor'])] });
  const maximized = (typeof v.maximized === 'string' && seen.has(v.maximized as FocusPanel) ? v.maximized : null) as FocusPanel | null;
  // Shares of a column's height as on average 1, none below a tenth of that (no group edited out of sight).
  for (const col of columns) {
    const mean = col.groups.reduce((sum, g) => sum + g.weight, 0) / col.groups.length;
    for (const g of col.groups) g.weight = Math.min(10, Math.max(0.1, g.weight / mean));
  }
  return { columns, maximized };
}

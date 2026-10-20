// Back / Forward (Ctrl+Alt+← / →), Recent Locations (Ctrl+Shift+E) and Reopen Closed Tab
// (Ctrl+Shift+T): where the caret has been, where the user edited, and which files were closed.
// Kept outside React: the caret moves on every key.

export interface Place {
  path: string;
  line: number;
  column: number;
}

export interface RecentPlace extends Place {
  /** Something was typed here (else only visited). */
  edited: boolean;
}

/** A move farther than this many lines, or to another file, is a jump worth coming back to. */
const JUMP = 10;
const MAX_HISTORY = 100;
const MAX_RECENT = 60;
const MAX_CLOSED = 30;

let back: Place[] = [];
let forward: Place[] = [];
let current: Place | null = null;
/** Where Back / Forward is taking the caret: the moves on the way there aren't jumps. */
let travelling: { to: Place; until: number } | null = null;
/** Each file's last caret position, for reopening it where it was. */
const lastIn = new Map<string, Place>();
let recent: RecentPlace[] = [];
let closed: Place[] = [];
/** Where the user edited, newest last; Last Edit Location walks it backwards. */
let edits: Place[] = [];
let editStep = 0;

const near = (a: Place, b: Place) => a.path === b.path && Math.abs(a.line - b.line) <= JUMP;

function remember(place: Place, edited: boolean) {
  const i = recent.findIndex((r) => near(r, place));
  const wasEdited = i >= 0 && recent[i].edited;
  if (i >= 0) recent.splice(i, 1);
  recent.unshift({ ...place, edited: edited || wasEdited });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
}

function pushBack(place: Place) {
  const last = back[back.length - 1];
  if (last && near(last, place)) back[back.length - 1] = place;
  else back.push(place);
  if (back.length > MAX_HISTORY) back.shift();
}

/** The caret of the active editor is at `place` (moved, or that editor got the focus). */
export function caretMoved(place: Place) {
  const prev = current;
  current = place;
  lastIn.set(place.path, place);
  if (travelling) {
    if (near(travelling.to, place) || Date.now() > travelling.until) travelling = null;
    return;
  }
  if (!prev || near(prev, place)) return;
  // A jump: Go to Declaration, a usage, a search result, a click far away, another tab.
  pushBack(prev);
  forward = [];
  remember(prev, false);
  remember(place, false);
}

/** A file's tab became the visible one: where its caret was is where the user is now. */
export function fileShown(path: string) {
  if (current?.path === path) return;
  caretMoved(lastIn.get(path) ?? { path, line: 1, column: 1 });
}

/** Text was typed or pasted at `line`. */
export function edited(path: string, line: number) {
  const place = { path, line, column: lastIn.get(path)?.column ?? 1 };
  remember(place, true);
  edits = edits.filter((e) => !near(e, place));
  edits.push(place);
  if (edits.length > MAX_RECENT) edits.shift();
  editStep = 0;
}

/** Last Edit Location: where the user last edited; pressed again, the edit before that. */
export function lastEditPlace(): Place | null {
  if (!edits.length) return null;
  // Not where the caret already is: the edit before it.
  if (editStep === 0 && current && near(current, edits[edits.length - 1]) && edits.length > 1) editStep = 1;
  const place = edits[Math.max(0, edits.length - 1 - editStep)];
  editStep = Math.min(editStep + 1, edits.length - 1);
  return place;
}

function travel(to: Place, open: (p: Place) => void) {
  travelling = { to, until: Date.now() + 2000 };
  current = to;
  open(to);
}

/** Goes back to where the caret was before the last jump; false when there's nowhere to go. */
export function goBack(open: (p: Place) => void): boolean {
  const to = back.pop();
  if (!to) return false;
  if (current) forward.push(current);
  travel(to, open);
  return true;
}

export function goForward(open: (p: Place) => void): boolean {
  const to = forward.pop();
  if (!to) return false;
  if (current) back.push(current);
  travel(to, open);
  return true;
}

/** A file's tab closed: Reopen Closed Tab brings it back where the caret was. */
export function tabClosed(path: string) {
  closed = closed.filter((p) => p.path !== path);
  closed.push(lastIn.get(path) ?? { path, line: 1, column: 1 });
  if (closed.length > MAX_CLOSED) closed.shift();
}

/** The most recently closed file that isn't open again, taken off the list. */
export function takeClosed(isOpen: (path: string) => boolean): Place | null {
  while (closed.length) {
    const p = closed.pop()!;
    if (!isOpen(p.path)) return p;
  }
  return null;
}

/** Recent Locations, newest first. */
export function recentPlaces(): RecentPlace[] {
  return recent.slice();
}

export function forgetPlace(place: Place) {
  recent = recent.filter((r) => !(r.path === place.path && r.line === place.line));
}

/** A new project: nothing of the old one's history. */
export function resetHistory() {
  back = [];
  forward = [];
  current = null;
  travelling = null;
  edits = [];
  editStep = 0;
  lastIn.clear();
  recent = [];
  closed = [];
}

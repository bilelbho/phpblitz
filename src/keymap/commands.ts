// Running a command of the catalog. In a focused code editor: its action with that id (or Monaco's
// own command); elsewhere, or when the editor has no such action: the handler the workspace
// registered. The code editor connects itself (setEditorFinder) once Monaco has loaded.

import { command } from './catalog';

interface Handler {
  run: () => void;
  /** When it can't run now (no debug session…), its keys do what they'd do without it. */
  enabled?: () => boolean;
}

const handlers = new Map<string, Handler>();

/** Registers handlers by command id; returns their removal. */
export function registerCommands(map: Record<string, Handler | (() => void)>): () => void {
  const added = Object.entries(map).map(([id, h]) => {
    const handler = typeof h === 'function' ? { run: h } : h;
    handlers.set(id, handler);
    return [id, handler] as const;
  });
  return () => {
    for (const [id, h] of added) if (handlers.get(id) === h) handlers.delete(id);
  };
}

/** A handler is registered for it and can run now (Find Action lists it). */
export function canRun(id: string): boolean {
  const h = handlers.get(id);
  return !!h && (!h.enabled || h.enabled());
}

/** What the dispatcher needs of a Monaco code editor. */
export interface KeyEditor {
  hasTextFocus(): boolean;
  getAction(id: string): unknown;
  trigger(source: string, handlerId: string, payload: unknown): void;
  /** Read-only editors (diffs, vendor files): no editing commands. */
  readOnly(): boolean;
  /** Its suggestion list or parameter hints are open (they keep their arrow keys and Enter). */
  widgetOpen(): boolean;
  /** Keys this editor keeps for an action of its own (the query console's Ctrl+Enter). */
  reserves(keys: string): boolean;
}

const reserved = new WeakMap<object, Set<string>>();

/** An editor keeps these keys (normalized) for itself, whatever the keymap says. */
export function reserveKeys(editor: object, keys: string[]) {
  reserved.set(editor, new Set([...(reserved.get(editor) ?? []), ...keys]));
}

export function reservedKeys(editor: object): Set<string> | undefined {
  return reserved.get(editor);
}

let finder: (() => KeyEditor | null) | null = null;

export function setEditorFinder(fn: () => KeyEditor | null) {
  finder = fn;
}

/** The code editor with the keyboard focus, if any. */
export function focusedEditor(): KeyEditor | null {
  return finder?.() ?? null;
}

/** Runs a command where it applies; false when it can't run here (the key does what it would otherwise). */
export function runCommand(id: string, editor: KeyEditor | null = focusedEditor()): boolean {
  const c = command(id);
  if (!c) return false;
  if (editor) {
    if (c.monaco) {
      if (c.group === 'Edit' && editor.readOnly()) return false;
      editor.trigger('keyboard', id, null);
      return true;
    }
    if (editor.getAction(id)) {
      editor.trigger('keyboard', id, null);
      return true;
    }
  }
  const h = handlers.get(id);
  if (!h || (h.enabled && !h.enabled())) return false;
  h.run();
  return true;
}

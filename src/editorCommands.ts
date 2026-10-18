// Editor actions that "Find Action" (Ctrl+Shift+A) can run. The focused code
// editor registers them; Search Everywhere lists them under Actions.

export interface EditorCommand {
  /** For the main menu, which looks commands up by id. */
  id?: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

let provider: (() => EditorCommand[]) | null = null;

/** The main code editor (the one the editor commands belong to), for the main menu. */
interface ActionTarget {
  focus(): void;
  trigger(source: string, handlerId: string, payload: unknown): void;
}
let mainEditor: ActionTarget | null = null;

export function setMainEditor(editor: ActionTarget | null) {
  mainEditor = editor;
}

/** Runs a Monaco or PHPBlitz editor action in the code editor; undefined when none is open. */
export function editorAction(id: string): (() => void) | undefined {
  const editor = mainEditor;
  if (!editor) return undefined;
  return () => {
    editor.focus();
    editor.trigger('menu', id, {});
  };
}

export function setEditorCommands(fn: (() => EditorCommand[]) | null) {
  provider = fn;
}

export function editorCommands(): EditorCommand[] {
  return provider?.() ?? [];
}

/** One command of the code editor, if one is open (the main menu disables the item otherwise). */
export function editorCommand(id: string): EditorCommand | undefined {
  return editorCommands().find((c) => c.id === id);
}

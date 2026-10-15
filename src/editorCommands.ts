// Editor actions that "Find Action" (Ctrl+Shift+A) can run. The focused code
// editor registers them; Search Everywhere lists them under Actions.

export interface EditorCommand {
  label: string;
  shortcut?: string;
  run: () => void;
}

let provider: (() => EditorCommand[]) | null = null;

export function setEditorCommands(fn: (() => EditorCommand[]) | null) {
  provider = fn;
}

export function editorCommands(): EditorCommand[] {
  return provider?.() ?? [];
}

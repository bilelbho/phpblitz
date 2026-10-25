// Which keys Vim mode answers (editor/vim.ts), kept apart from monaco-vim so the keymap can ask
// without loading Vim. The keymap dispatcher runs app shortcuts before Monaco: Vim's own Ctrl keys
// (Ctrl+R redo, Ctrl+V visual block, Ctrl+D/U scrolling…) and Escape go to Vim instead.

/** Each Vim editor's mode ("normal", "insert", "visual", "replace"). */
const modes = new WeakMap<object, string>();

/** Keys Vim answers in normal and visual mode. */
const NORMAL_KEYS = new Set(['Escape', 'Ctrl+[', 'Ctrl+R', 'Ctrl+V', 'Ctrl+D', 'Ctrl+U', 'Ctrl+O', 'Ctrl+I', 'Ctrl+E', 'Ctrl+Y', 'Ctrl+F', 'Ctrl+B', 'Ctrl+A', 'Ctrl+X']);
/** Keys Vim answers while typing (insert mode): the rest keep their PHPBlitz commands. */
const INSERT_KEYS = new Set(['Escape', 'Ctrl+[', 'Ctrl+O', 'Ctrl+W']);

export function setVimMode(editor: object, mode: string | null) {
  if (mode) modes.set(editor, mode);
  else modes.delete(editor);
}

/** Whether Vim, not the keymap, handles these keys in this editor right now. */
export function vimReserves(editor: object, keys: string): boolean {
  const mode = modes.get(editor);
  if (!mode) return false;
  return (mode === 'insert' ? INSERT_KEYS : NORMAL_KEYS).has(keys);
}

// The editor the user worked in last (the AI actions and the chat's "Insert at caret" act on it).

import type * as monaco from 'monaco-editor';

let active: monaco.editor.ICodeEditor | null = null;

export function trackActiveEditor(editor: monaco.editor.ICodeEditor) {
  active = editor;
  editor.onDidFocusEditorText(() => (active = editor));
  editor.onDidDispose(() => {
    if (active === editor) active = null;
  });
}

export function activeEditor(): monaco.editor.ICodeEditor | null {
  return active?.getModel() ? active : null;
}

/** A model's file path: `file:///c%3A/x/y.php` → `c:/x/y.php` as the workspace writes it. */
export function pathOfModel(model: monaco.editor.ITextModel): string {
  let p = decodeURIComponent(model.uri.path);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

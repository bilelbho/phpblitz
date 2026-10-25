// Reading the clipboard without the web view asking first. The web view's own read
// (navigator.clipboard.readText, and Monaco's Paste command, which uses it) shows a "wants to see
// text and images copied to the clipboard" prompt; the Rust side reads it without one. Writing
// needs no permission. Ctrl+V itself is the browser's paste event: no prompt either.

import { invoke } from '@tauri-apps/api/core';
import type * as monaco from 'monaco-editor';

/** The clipboard's text, read by the Rust side. (The browser preview has no Rust side.) */
export function readClipboard(): Promise<string> {
  return '__TAURI_INTERNALS__' in window ? invoke<string>('clipboard_read_text') : navigator.clipboard.readText();
}

/** Paste from a menu (Edit ▸ Paste, the editor's right-click menu): as Ctrl+V, several cursors included. */
export async function pasteInto(editor: monaco.editor.ICodeEditor) {
  const text = await readClipboard().catch(() => null);
  editor.focus();
  if (text) editor.trigger('keyboard', 'paste', { text });
}

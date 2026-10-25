// Vim mode (Settings ▸ Editor ▸ General ▸ Vim mode, or the onboarding screen): Vim's keys in the
// code editor, from monaco-vim (the CodeMirror Vim keymap on Monaco): modes, motions, operators,
// counts, registers, marks, macros, visual mode and : commands. Its command line and mode show in
// a bar under the editor. :w saves, :q closes the tab, through PHPBlitz's own commands. Loaded only
// when Vim mode is on; editor/vimKeys.ts tells the keymap which keys are Vim's.

import type * as monaco from 'monaco-editor';
import { initVimMode, VimMode } from 'monaco-vim';
import { runCommand } from '../keymap/commands';
import { setVimMode } from './vimKeys';

type Editor = monaco.editor.IStandaloneCodeEditor;
let exCommands = false;

/** :w, :q and friends run PHPBlitz's Save and Close Tab (once, for every editor). */
function defineExCommands() {
  if (exCommands) return;
  exCommands = true;
  const Vim = (VimMode as unknown as { Vim: { defineEx: (name: string, prefix: string, fn: () => void) => void } }).Vim;
  const save = () => runCommand('phpblitz.save');
  const close = () => runCommand('phpblitz.closeTab');
  Vim.defineEx('write', 'w', save);
  Vim.defineEx('update', 'up', save);
  Vim.defineEx('quit', 'q', close);
  Vim.defineEx('wq', 'wq', () => {
    save();
    close();
  });
  Vim.defineEx('xit', 'x', () => {
    save();
    close();
  });
}

/** Turns Vim on in an editor, with its status and command line in `bar`. Returns the way back. */
export function attachVim(editor: Editor, bar: HTMLElement): () => void {
  defineExCommands();
  const vim = initVimMode(editor, bar);
  setVimMode(editor, 'normal');
  vim.on('vim-mode-change', (e: { mode: string }) => {
    setVimMode(editor, e.mode);
    bar.dataset.mode = e.mode;
  });
  bar.dataset.mode = 'normal';
  return () => {
    setVimMode(editor, null);
    vim.dispose();
    bar.textContent = '';
    delete bar.dataset.mode;
  };
}

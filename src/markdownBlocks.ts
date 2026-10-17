// Shell code blocks in Markdown: the editor's ▷ beside them, and running them in the terminal.

import type { Workspace } from './useWorkspace';
import { isTauri } from './platform';
import { terminals } from './terminal/manager';
import { terminalStartDir } from './terminal/startDir';

export const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'ps1', 'cmd', 'bat']);

/** Runs a code block's commands in the terminal (desktop), or the simple runner (browser). */
export function runCodeBlock(ws: Workspace, code: string) {
  ws.showBottom('terminal');
  if (isTauri && ws.backend.kind === 'disk') terminals.run(code, terminalStartDir(ws));
  else code.split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => ws.runCommand(line));
}

/** Shell code blocks in Markdown source: the fence line and the code (for the editor's ▷ gutter). */
export function shellBlocks(text: string): { line: number; code: string }[] {
  const out: { line: number; code: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trimStart().startsWith(open[1])) j++;
    if (SHELL_LANGS.has(open[2].toLowerCase())) out.push({ line: i + 1, code: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  return out;
}


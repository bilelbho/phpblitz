// Keymaps in and out of files (Settings ▸ Keymap): VS Code's keybindings.json, read as changes on
// top of the VS Code keymap, and PHPBlitz's own keymap files (a keymap and its changes).

import type { KeymapSettings } from '../settings';
import { command } from './catalog';
import { KEYMAPS } from './keymaps';
import { normalizeKeys } from './keys';
import { bindingsOf, setKeysIn } from './store';

/** VS Code commands → ours (VS Code's editor commands that Monaco shares keep their ids). */
const FROM_VSCODE: Record<string, string> = {
  'workbench.action.openSettings': 'phpblitz.settings',
  'workbench.action.openSettings2': 'phpblitz.settings',
  'workbench.action.files.save': 'phpblitz.save',
  'workbench.action.closeActiveEditor': 'phpblitz.closeTab',
  'workbench.action.reopenClosedEditor': 'phpblitz.reopenClosedTab',
  'actions.find': 'phpblitz.find',
  'editor.action.startFindReplaceAction': 'phpblitz.replace',
  'editor.action.nextMatchFindAction': 'phpblitz.findNext',
  'editor.action.previousMatchFindAction': 'phpblitz.findPrev',
  'workbench.action.findInFiles': 'phpblitz.findInFiles',
  'workbench.action.replaceInFiles': 'phpblitz.replaceInFiles',
  'editor.action.goToReferences': 'phpblitz.findUsages',
  'editor.action.referenceSearch.trigger': 'phpblitz.findUsages',
  'references-view.findReferences': 'phpblitz.findUsages',
  'workbench.action.showCommands': 'phpblitz.findAction',
  'workbench.action.quickOpen': 'phpblitz.gotoFile',
  'workbench.action.showAllSymbols': 'phpblitz.gotoSymbol',
  'workbench.action.gotoLine': 'phpblitz.gotoLine',
  'workbench.action.gotoSymbol': 'phpblitz.fileStructure',
  'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup': 'phpblitz.recentFiles',
  'workbench.action.openPreviousRecentlyUsedEditorInGroup': 'phpblitz.recentFiles',
  'workbench.action.navigateBack': 'phpblitz.back',
  'workbench.action.navigateForward': 'phpblitz.forward',
  'workbench.action.navigateToLastEditLocation': 'phpblitz.lastEditLocation',
  'editor.action.revealDefinition': 'phpblitz.gotoDeclaration',
  'editor.action.goToDeclaration': 'phpblitz.gotoDeclaration',
  'editor.action.goToImplementation': 'phpblitz.gotoImplementation',
  'editor.action.goToTypeDefinition': 'phpblitz.typeDeclaration',
  'editor.action.marker.nextInFiles': 'phpblitz.nextProblem',
  'editor.action.marker.prevInFiles': 'phpblitz.prevProblem',
  'editor.action.marker.next': 'phpblitz.nextProblem',
  'editor.action.marker.prev': 'phpblitz.prevProblem',
  'editor.action.quickFix': 'phpblitz.contextActions',
  'editor.action.triggerParameterHints': 'phpblitz.paramInfo',
  'editor.action.showHover': 'phpblitz.quickDoc',
  'editor.action.formatDocument': 'phpblitz.reformat',
  'editor.action.rename': 'phpblitz.rename',
  'inlineChat.start': 'phpblitz.editWithAi',
  'copyFilePath': 'phpblitz.copyPath',
  'copyRelativeFilePath': 'phpblitz.copyReference',
  'editor.action.toggleWordWrap': 'phpblitz.softWrap',
  'editor.unfold': 'phpblitz.expand',
  'editor.fold': 'phpblitz.collapse',
  'editor.unfoldAll': 'phpblitz.expandAll',
  'editor.foldAll': 'phpblitz.collapseAll',
  'editor.action.toggleColumnSelection': 'phpblitz.columnSelection',
  'editor.debug.action.toggleBreakpoint': 'phpblitz.toggleBreakpoint',
  'editor.debug.action.runToCursor': 'phpblitz.runToCursor',
  'workbench.action.debug.continue': 'phpblitz.debugResume',
  'workbench.action.debug.stepOver': 'phpblitz.debugStepOver',
  'workbench.action.debug.stepInto': 'phpblitz.debugStepInto',
  'workbench.action.debug.stepOut': 'phpblitz.debugStepOut',
  'workbench.action.debug.stop': 'phpblitz.debugStop',
  'testing.runCurrentFile': 'phpblitz.runTests',
  'testing.runAtCursor': 'phpblitz.runTests',
  'workbench.view.explorer': 'phpblitz.tool.project',
  'workbench.action.terminal.toggleTerminal': 'phpblitz.tool.terminal',
  'workbench.actions.view.problems': 'phpblitz.tool.problems',
  'workbench.view.scm': 'phpblitz.tool.git',
  'workbench.view.debug': 'phpblitz.tool.run',
  'workbench.action.zoomIn': 'phpblitz.zoomIn',
  'workbench.action.zoomOut': 'phpblitz.zoomOut',
  'workbench.action.zoomReset': 'phpblitz.zoomReset',
  'editor.action.fontZoomIn': 'phpblitz.fontSizeUp',
  'editor.action.fontZoomOut': 'phpblitz.fontSizeDown',
  'editor.action.fontZoomReset': 'phpblitz.fontSizeReset',
};

export interface ImportResult {
  keymap: KeymapSettings;
  /** Bindings read. */
  applied: number;
  /** VS Code commands PHPBlitz has nothing for. */
  skipped: string[];
}

/** JSON with comments and trailing commas (VS Code's settings files). */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // A string: copied as it is, escapes included.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, '$1'));
}

/** VS Code's keybindings.json: the VS Code keymap with its additions and removals. */
export function importVsCode(text: string): ImportResult {
  const rules = parseJsonc(text);
  if (!Array.isArray(rules)) throw new Error('This is not a keybindings.json file (a list of key bindings).');
  let keymap: KeymapSettings = { preset: 'vscode', overrides: {} };
  let applied = 0;
  const skipped = new Set<string>();
  for (const rule of rules as { key?: unknown; command?: unknown }[]) {
    if (typeof rule?.command !== 'string') continue;
    const removal = rule.command.startsWith('-');
    const name = removal ? rule.command.slice(1) : rule.command;
    const id = FROM_VSCODE[name] ?? (command(name)?.monaco ? name : undefined);
    if (!id) {
      skipped.add(name);
      continue;
    }
    const key = typeof rule.key === 'string' ? normalizeKeys(rule.key) : null;
    const keys = bindingsOf(keymap).get(id) ?? [];
    if (removal) keymap = setKeysIn(keymap, id, key ? keys.filter((k) => k !== key) : []);
    else if (key) keymap = setKeysIn(keymap, id, keys.includes(key) ? keys : [...keys, key]);
    else continue;
    applied++;
  }
  return { keymap, applied, skipped: [...skipped].sort() };
}

const FORMAT = 'phpblitz-keymap';

/** A PHPBlitz keymap file: the keymap it starts from and the changes. */
export function exportKeymap(keymap: KeymapSettings): string {
  return JSON.stringify({ format: FORMAT, version: 1, preset: keymap.preset, overrides: keymap.overrides }, null, 2) + '\n';
}

export function importKeymap(text: string): ImportResult {
  const data = parseJsonc(text) as { format?: unknown; preset?: unknown; overrides?: unknown };
  if (data?.format !== FORMAT) throw new Error('This is not a PHPBlitz keymap file.');
  const preset = KEYMAPS.some((k) => k.id === data.preset) ? (data.preset as string) : 'phpblitz';
  const overrides: Record<string, string[]> = {};
  const skipped: string[] = [];
  for (const [id, keys] of Object.entries((data.overrides ?? {}) as Record<string, unknown>)) {
    if (!command(id)) skipped.push(id);
    else if (Array.isArray(keys)) overrides[id] = keys.filter((k): k is string => typeof k === 'string' && !!normalizeKeys(k)).map((k) => normalizeKeys(k)!);
  }
  return { keymap: { preset, overrides }, applied: Object.keys(overrides).length, skipped };
}

/** Is the text a VS Code keybindings.json (a list) rather than a PHPBlitz keymap (an object)? */
export function looksLikeVsCode(text: string): boolean {
  return /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*\[/.test(text);
}

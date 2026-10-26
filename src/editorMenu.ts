// The editor's right-click menu.
import { shortcut } from './keymap/store';
import { debug } from './debug/manager';

import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from './useWorkspace';
import { baseName, relativePath, type Problem } from './backend/types';
import { isTauri } from './platform';
import { pasteInto } from './clipboard';
import { codeActionsAt, isLspActive, type CodeAction } from './lsp/monacoBridge';
import { testMenuItems, testsOf } from './tests/gutter';
import { testAt } from './tests/discover';
import { isScriptModel, scriptQuickFixes } from './jsProjects';
import type { ContextItem } from './components/ContextMenu';
import { structureOf } from './php';
import { symbols } from './symbols';
import { magoAvailable, suppressionComment } from './mago';
import { runChatAction, startInlineEdit } from './ai/actions';
import { openLocalHistory } from './components/LocalHistoryDialog';

type Editor = monaco.editor.IStandaloneCodeEditor;

const SEP: ContextItem = { kind: 'sep' };

/** The keymap's keys for the menu's commands (Settings ▸ Keymap). */
export const SHORTCUTS = {
  get contextActions() {
    return shortcut('phpblitz.contextActions');
  },
  get copyPath() {
    return shortcut('phpblitz.copyPath');
  },
  get copyReference() {
    return shortcut('phpblitz.copyReference');
  },
  get columnSelection() {
    return shortcut('phpblitz.columnSelection');
  },
  get findUsages() {
    return shortcut('phpblitz.findUsages');
  },
  get rename() {
    return shortcut('phpblitz.rename');
  },
  get expand() {
    return shortcut('phpblitz.expand');
  },
  get collapse() {
    return shortcut('phpblitz.collapse');
  },
  get expandAll() {
    return shortcut('phpblitz.expandAll');
  },
  get collapseAll() {
    return shortcut('phpblitz.collapseAll');
  },
  get declaration() {
    return shortcut('phpblitz.gotoDeclaration');
  },
  get implementation() {
    return shortcut('phpblitz.gotoImplementation');
  },
  get typeDeclaration() {
    return shortcut('phpblitz.typeDeclaration');
  },
  get line() {
    return shortcut('phpblitz.gotoLine');
  },
  get generate() {
    return shortcut('phpblitz.generate');
  },
  get reformat() {
    return shortcut('phpblitz.reformat');
  },
  get runTests() {
    return shortcut('phpblitz.runTests');
  },
  get commit() {
    return shortcut('phpblitz.commit');
  },
  get editWithAi() {
    return shortcut('phpblitz.editWithAi');
  },
};

const isRefactor = (a: CodeAction) => a.kind.startsWith('refactor');
const isGenerate = (a: CodeAction) => a.kind.startsWith('source') || /^(generate|add|implement|create)\b/i.test(a.title);

export async function codeActionsForSelection(editor: Editor): Promise<CodeAction[]> {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return [];
  if (isScriptModel(model)) return scriptCodeActions(model, sel);
  if (!isLspActive()) return [];
  const actions = await codeActionsAt(model, sel);
  return actions.sort((a, b) => Number(b.preferred) - Number(a.preferred));
}

/** The TypeScript service's quick fixes for the problems on the caret's lines. */
async function scriptCodeActions(model: monaco.editor.ITextModel, sel: monaco.Selection): Promise<CodeAction[]> {
  const markers = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter((m) => (m.owner === 'typescript' || m.owner === 'javascript') && m.startLineNumber <= sel.endLineNumber && m.endLineNumber >= sel.startLineNumber);
  const fixes = (await Promise.all(markers.map((m) => scriptQuickFixes(model, m).catch(() => [])))).flat();
  const seen = new Set<string>();
  return fixes
    .filter((f) => !seen.has(f.title) && seen.add(f.title))
    .map((f) => ({ title: f.title, kind: 'quickfix', preferred: false, run: async () => f.run() }));
}

/** Run / Debug for the test at a line of a test file, or for the whole file. */
function testItemsAt(ws: Workspace, path: string, text: string, line: number, name: string): ContextItem[] {
  const test = testAt(testsOf(path, text), line);
  if (test) return testMenuItems(ws.runTestScope, path, test);
  return [
    { label: `Run '${name}'`, shortcut: SHORTCUTS.runTests, icon: 'run', run: () => ws.runTestScope({ kind: 'file', path }) },
    { label: `Debug '${name}'`, icon: 'bug', run: () => ws.runTestScope({ kind: 'file', path }, { debug: true }) },
  ];
}

function actionItems(actions: CodeAction[], empty: string, onError: (e: unknown) => void, uri?: string): ContextItem[] {
  if (!actions.length) return [{ label: empty, disabled: true }];
  return actions.map((a) => ({
    label: a.title,
    icon: a.kind.startsWith('quickfix') || a.preferred ? 'bulb' : undefined,
    run: () => a.run().catch(onError),
    preview: uri && a.preview ? () => a.preview!(uri) : undefined,
  }));
}

/** Mago problems on the caret's line, one per rule. */
function magoProblemsAtCaret(editor: Editor, ws: Workspace, path: string): Problem[] {
  const line = editor.getPosition()?.lineNumber ?? 0;
  const seen = new Set<string>();
  return (ws.problems[path] ?? []).filter((p) => {
    const hit = !!p.code && (p.category === 'lint' || p.category === 'analysis') && line >= p.line && line <= (p.endLine ?? p.line);
    if (!hit || seen.has(p.code!)) return false;
    seen.add(p.code!);
    return true;
  });
}

/** Fix / suppress / disable entries for the Mago problems at the caret. */
function magoProblemItems(problems: Problem[], ws: Workspace, path: string): ContextItem[] {
  const fixes: ContextItem[] = problems.flatMap((p) =>
    (p.fixes ?? []).map((f) => ({
      label: `${f.title}${f.safety === 'safe' ? '' : ' (may change behavior)'}`,
      icon: 'bulb' as const,
      run: () => ws.applyFix(path, f),
      preview: async () => f.edits.map((e) => ({ startLine: e.line, startColumn: e.column, endLine: e.endLine, endColumn: e.endColumn, text: e.text })),
    })),
  );
  // One submenu per rule ("Inspection 'X' options ▸").
  const options: ContextItem[] = problems.map((p) => ({
    label: `'${p.code}' options`,
    icon: p.severity === 'error' ? ('error' as const) : ('warning' as const),
    submenu: [
      { label: p.message, disabled: true },
      SEP,
      { label: 'Suppress for This Line', run: () => ws.suppressProblem(path, p), preview: async () => suppressPreview(path, p) },
      { label: 'Disable in mago.toml', disabled: ws.backend.kind !== 'disk', run: () => ws.disableMagoRule(p) },
    ],
  }));
  return [...fixes, ...(fixes.length ? [SEP] : []), ...options];
}

/** Right-click ▸ Mago: actions for the problems on this line, and the project's Mago setup. */
export function magoMenu(editor: Editor, ws: Workspace, path: string): ContextItem[] {
  const problems = magoProblemsAtCaret(editor, ws, path).slice(0, 4);
  const disk = ws.backend.kind === 'disk';
  return [
    ...(problems.length ? magoProblemItems(problems, ws, path) : [{ label: 'No Mago problems on this line', disabled: true }]),
    SEP,
    {
      label: 'Reformat File',
      shortcut: SHORTCUTS.reformat,
      icon: 'code',
      run: () => {
        editor.focus();
        editor.trigger('phpblitz', 'editor.action.formatDocument', {});
      },
    },
    { label: ws.magoStatus.state === 'analyzing' ? 'Restart Project Analysis' : 'Re-analyze Project', icon: 'refresh', disabled: !disk, run: ws.reanalyzeProject },
    { label: 'Show Project Errors', icon: 'error', disabled: !disk, run: () => ws.showBottom('problems') },
    SEP,
    { label: ws.magoStatus.summary?.configFile ? 'Open mago.toml' : 'Create mago.toml', disabled: !disk, run: ws.openMagoConfig },
  ];
}

/** Alt+Enter: Mago's fixes for this line first, then the language server's quick fixes and intentions. */
export function contextActionsMenu(actions: CodeAction[], ws: Workspace, mago: { editor: Editor; path: string } | null = null): ContextItem[] {
  const magoItems = mago ? magoProblemItems(magoProblemsAtCaret(mago.editor, ws, mago.path).slice(0, 4), ws, mago.path) : [];
  const lspItems = actions.filter((a) => !isGenerate(a) || a.kind.startsWith('quickfix'));
  if (!lspItems.length && magoItems.length) return magoItems;
  // Quick fixes (with a bulb) first, then a line, then intentions.
  const isFix = (a: CodeAction) => a.kind.startsWith('quickfix') || a.preferred;
  const fixes = lspItems.filter(isFix);
  const intentions = lspItems.filter((a) => !isFix(a));
  const uri = mago?.editor.getModel()?.uri.toString();
  const onError = (e: unknown) => reportError(ws, e);
  const lsp =
    fixes.length && intentions.length
      ? [...actionItems(fixes, '', onError, uri), SEP, ...actionItems(intentions, '', onError, uri)]
      : actionItems(lspItems, 'No context actions here', onError, uri);
  return magoItems.length ? [...magoItems, SEP, ...lsp] : lsp;
}

/** Alt+Insert: constructors, getters/setters, missing methods… */
export function generateMenu(actions: CodeAction[], ws: Workspace, uri?: string): ContextItem[] {
  return actionItems(actions.filter(isGenerate), 'Nothing to generate here', (e) => reportError(ws, e), uri);
}

/** The `// @mago-expect` line "Suppress for This Line" would add. */
function suppressPreview(path: string, p: Problem) {
  const comment = suppressionComment(p);
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (!comment || !model) return null;
  const text = model.getLineContent(p.line);
  const indent = text.slice(0, text.length - text.trimStart().length);
  return [{ startLine: p.line, startColumn: 1, endLine: p.line, endColumn: 1, text: `${indent}${comment}\n` }];
}

function reportError(ws: Workspace, e: unknown) {
  ws.notify({ title: 'Action failed', body: String(e instanceof Error ? e.message : e), tone: 'error' });
}

/** `App\Models\User::orders` for the class member at (or around) the caret. */
export function referenceAt(editor: Editor): string | null {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return null;
  const text = model.getValue();
  const symbols = structureOf(text);
  const cls = symbols.find((s) => s.depth === 0 && s.kind !== 'function');
  if (!cls) return null;
  const ns = text.match(/^namespace\s+([\w\\]+)\s*;/m)?.[1];
  const fqn = ns ? `${ns}\\${cls.name}` : cls.name;
  const member = [...symbols].reverse().find((s) => s.depth > 0 && s.kind !== 'use' && s.line <= pos.lineNumber);
  if (!member || pos.lineNumber < cls.line) return fqn;
  return `${fqn}::${member.kind === 'property' ? '$' : ''}${member.name}`;
}

export async function copyText(ws: Workspace, text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // The async clipboard needs a focused document; fall back to the selection-based copy.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) {
      ws.notify({ title: 'Could not copy', body: String(e), tone: 'error' });
      return;
    }
  }
  ws.setStatus(`Copied ${what}: ${text}`);
}

export function buildEditorMenu(
  editor: Editor,
  ws: Workspace,
  path: string,
  actions: CodeAction[],
  open: { contextActions: () => void; generate: () => void; gotoLine: () => void; rename: () => void },
): ContextItem[] {
  const model = editor.getModel()!;
  const lsp = isLspActive();
  const run = (id: string) => () => {
    editor.focus();
    editor.trigger('phpblitz', id, {});
  };
  const reference = referenceAt(editor);
  const outline = structureOf(model.getValue());
  const className = outline.find((s) => s.depth === 0)?.name ?? baseName(path);
  const declaresType = outline.some((s) => s.depth === 0 && ['class', 'interface', 'trait', 'enum'].includes(s.kind));
  const isTest = /Test\.php$/.test(path) || /\/tests\//i.test(path);
  const refactors = actions.filter((a) => isRefactor(a) && !isGenerate(a));
  const contextual = actions.filter((a) => !isGenerate(a) || a.kind.startsWith('quickfix'));
  const generators = actions.filter(isGenerate);
  const magoHere = magoProblemsAtCaret(editor, ws, path).length;

  return [
    { label: 'Show Context Actions', shortcut: SHORTCUTS.contextActions, icon: 'bulb', disabled: !contextual.length && !magoHere, run: open.contextActions },
    SEP,
    { label: 'Cut', shortcut: 'Ctrl+X', icon: 'cut', run: run('editor.action.clipboardCutAction') },
    { label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', run: run('editor.action.clipboardCopyAction') },
    // Not Monaco's Paste command: it reads the clipboard the way that makes the web view ask first.
    { label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', run: () => void pasteInto(editor) },
    {
      label: 'Copy Path/Reference…',
      submenu: [
        { label: 'Absolute Path', shortcut: SHORTCUTS.copyPath, run: () => copyText(ws, path, 'path') },
        { label: 'Path From Content Root', run: () => copyText(ws, relativePath(ws.backend, path), 'path') },
        { label: 'File Name', run: () => copyText(ws, baseName(path), 'file name') },
        SEP,
        { label: 'Copy Reference', shortcut: SHORTCUTS.copyReference, disabled: !reference, run: () => reference && copyText(ws, reference, 'reference') },
      ],
    },
    { label: 'Column Selection Mode', shortcut: SHORTCUTS.columnSelection, icon: 'columns', run: run('editor.action.toggleColumnSelection') },
    SEP,
    {
      label: 'Find Usages',
      shortcut: SHORTCUTS.findUsages,
      icon: 'search',
      // From the language server, or from the symbol index without one.
      disabled: !lsp && !symbols.rust,
      run: () => {
        const pos = editor.getPosition();
        if (pos) ws.findUsagesAt(model, pos);
      },
    },
    {
      label: 'Refactor',
      icon: 'pencil',
      submenu: [
        { label: 'Rename…', shortcut: SHORTCUTS.rename, run: open.rename },
        ...(refactors.length ? [SEP, ...actionItems(refactors, '', (e) => reportError(ws, e))] : []),
      ],
    },
    {
      label: 'AI',
      icon: 'sparkle',
      submenu: [
        { label: 'Edit with AI…', shortcut: SHORTCUTS.editWithAi, run: () => startInlineEdit(ws, editor) },
        SEP,
        { label: 'Explain', run: () => runChatAction(ws, editor, 'explain') },
        { label: 'Fix Problems', run: () => runChatAction(ws, editor, 'fix') },
        { label: 'Write Tests', run: () => runChatAction(ws, editor, 'tests') },
        { label: 'Add Doc Comments', run: () => runChatAction(ws, editor, 'docs') },
      ],
    },
    {
      label: 'Folding',
      submenu: [
        { label: 'Expand', shortcut: SHORTCUTS.expand, run: run('editor.unfold') },
        { label: 'Collapse', shortcut: SHORTCUTS.collapse, run: run('editor.fold') },
        { label: 'Expand Recursively', run: run('editor.unfoldRecursively') },
        { label: 'Collapse Recursively', run: run('editor.foldRecursively') },
        SEP,
        { label: 'Expand All', shortcut: SHORTCUTS.expandAll, run: run('editor.unfoldAll') },
        { label: 'Collapse All', shortcut: SHORTCUTS.collapseAll, run: run('editor.foldAll') },
        SEP,
        { label: 'Collapse Doc Comments', run: run('editor.foldAllBlockComments') },
      ],
    },
    SEP,
    {
      label: 'Go To',
      icon: 'goTo',
      submenu: [
        { label: 'Declaration or Usages', shortcut: SHORTCUTS.declaration, disabled: !lsp, run: run('editor.action.revealDefinition') },
        { label: 'Implementation(s)', shortcut: SHORTCUTS.implementation, disabled: !lsp, run: run('editor.action.goToImplementation') },
        { label: 'Type Declaration', shortcut: SHORTCUTS.typeDeclaration, disabled: !lsp, run: run('editor.action.goToTypeDefinition') },
        SEP,
        { label: 'Line:Column…', shortcut: SHORTCUTS.line, run: open.gotoLine },
      ],
    },
    { label: 'Generate…', shortcut: SHORTCUTS.generate, icon: 'plus', disabled: !generators.length, run: open.generate },
    { label: 'Reformat Code', shortcut: SHORTCUTS.reformat, icon: 'code', disabled: !magoAvailable || !path.endsWith('.php'), run: run('editor.action.formatDocument') },
    ...(magoAvailable && path.endsWith('.php')
      ? [{ label: magoHere ? `Mago (${magoHere} here)` : 'Mago', icon: 'check' as const, submenu: magoMenu(editor, ws, path) }]
      : []),
    SEP,
    // In a test file: run or debug the test at the caret (else the whole file).
    ...(isTest ? testItemsAt(ws, path, model.getValue(), editor.getPosition()?.lineNumber ?? 1, className) : []),
    // A script (routes, entry points…), not a file that only declares a class: running it does something.
    ...(path.endsWith('.php') && !isTest && !declaresType ? [{ label: `Debug '${path.split('/').pop()}'`, icon: 'bug' as const, run: () => void debug.debugScript(path) }] : []),
    ...(debug.active?.status === 'break'
      ? [
          { label: 'Run to Cursor', shortcut: 'Alt+F9', icon: 'runToCursor' as const, run: () => void debug.runToCursor(path, editor.getPosition()?.lineNumber ?? 1) },
          {
            label: 'Add to Watches',
            icon: 'eye' as const,
            run: () => {
              const model = editor.getModel();
              const sel = editor.getSelection();
              const pos = editor.getPosition();
              const text = model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : model && pos ? variableAt(model.getLineContent(pos.lineNumber), pos.column) : '';
              if (text) debug.addWatch(text);
            },
          },
        ]
      : []),
    {
      label: 'Open In',
      icon: 'folderOpen',
      submenu: [
        {
          label: 'Explorer',
          icon: 'explorer',
          disabled: !isTauri || ws.backend.kind !== 'disk',
          run: () => invoke('reveal_in_explorer', { path }).catch((e) => reportError(ws, e)),
        },
        { label: 'Terminal', icon: 'terminal', run: () => ws.showBottom('terminal') },
      ],
    },
    { label: 'Local History…', icon: 'history', disabled: !hasLocalHistory(ws), run: () => openLocalHistory(path) },
    { label: 'Git', icon: 'git', disabled: !ws.git, submenu: gitSubmenu(ws, path, false) },
  ];
}

/** Local History is kept for projects on disk, by the desktop app. */
export const hasLocalHistory = (ws: Workspace) => isTauri && ws.backend.kind === 'disk';

/** Right-click ▸ Git, in the editor and the Project tree. */
export function gitSubmenu(ws: Workspace, path: string, isDir: boolean): ContextItem[] {
  const inside = (p: string) => p === path || p.startsWith(path + '/');
  const changes = (ws.git?.changes ?? []).filter((c) => (isDir ? inside(c.path) : c.path === path) && c.status !== 'U');
  const change = !isDir ? ws.git?.changes.find((c) => c.path === path) : undefined;
  return [
    { label: isDir ? 'Commit Directory…' : 'Commit File…', shortcut: SHORTCUTS.commit, icon: 'commit', run: () => ws.showLeft('commit') },
    { kind: 'sep' },
    ...(!isDir
      ? [
          { label: 'Show Diff', icon: 'columns' as const, disabled: !change || change.status === 'U', run: () => ws.openDiff(path) },
          { label: 'Annotate with Git Blame', checked: ws.annotated.has(path), disabled: change?.status === 'U' || change?.status === 'A', run: () => (ws.openFile(path), ws.toggleAnnotate(path)) },
        ]
      : []),
    { label: 'Show History', icon: 'history', run: () => ws.showHistory(path) },
    { kind: 'sep' },
    { label: 'Rollback…', icon: 'rollback', disabled: !changes.length, run: () => ws.rollbackFiles(changes) },
    { label: 'Refresh Status', icon: 'refresh', run: ws.refreshGit },
  ];
}

/** Whether Alt+Enter has Mago fixes or options on the caret's line (for the lightbulb). */
export function hasMagoActionsAtCaret(editor: Editor, ws: Workspace, path: string): boolean {
  return magoProblemsAtCaret(editor, ws, path).length > 0;
}

export interface QuickFix {
  title: string;
  run: () => void;
}

/** Problems (markers) under a position, most severe first. */
export function markersAt(model: monaco.editor.ITextModel, pos: monaco.IPosition): monaco.editor.IMarker[] {
  return monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter((m) => monaco.Range.containsPosition(m, pos) || (m.startLineNumber === m.endLineNumber && m.startLineNumber === pos.lineNumber && m.startColumn === m.endColumn))
    .sort((a, b) => b.severity - a.severity);
}

/** Fixes for one problem: Mago's own, then the language server's quick fixes for its range. */
export async function quickFixesFor(editor: Editor, ws: Workspace, path: string, marker: monaco.editor.IMarker): Promise<QuickFix[]> {
  const model = editor.getModel();
  if (!model) return [];
  const mago: QuickFix[] = (ws.problems[path] ?? [])
    .filter((p) => p.code === marker.code && p.line <= marker.startLineNumber && (p.endLine ?? p.line) >= marker.startLineNumber)
    .flatMap((p) => p.fixes ?? [])
    .map((f) => ({ title: f.title, run: () => ws.applyFix(path, f) }));
  const lsp = isLspActive()
    ? (await codeActionsAt(model, monaco.Range.lift(marker)).catch(() => []))
        .filter((a) => a.kind.startsWith('quickfix') || a.preferred)
        .map((a) => ({ title: a.title, run: () => void a.run().catch((e) => reportError(ws, e)) }))
    : [];
  const script = isScriptModel(model) ? await scriptQuickFixes(model, marker).catch(() => []) : [];
  return [...mago, ...lsp, ...script];
}

/**
 * The `$variable` under a column, with `->property` / `::$static` parts up to the hovered one:
 * in `$user->address->city`, hovering `address` gives `$user->address`.
 */
export function variableAt(line: string, column: number): string {
  for (const m of line.matchAll(/\$[A-Za-z_]\w*(?:(?:->|\?->)[A-Za-z_]\w*)*/g)) {
    const start = (m.index ?? 0) + 1;
    if (column < start || column > start + m[0].length) continue;
    let end = 0;
    for (const part of m[0].matchAll(/(?:^\$|->|\?->)[A-Za-z_]\w*/g)) {
      end = (part.index ?? 0) + part[0].length;
      if (column <= start + end) break;
    }
    return m[0].slice(0, end).replace(/\?->/g, '->');
  }
  return '';
}

// The editor's right-click menu, modeled on PhpStorm's.

import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from './useWorkspace';
import { baseName, relativePath, type Problem } from './backend/types';
import { isTauri } from './platform';
import { codeActionsAt, isLspActive, type CodeAction } from './lsp/monacoBridge';
import type { ContextItem } from './components/ContextMenu';
import { structureOf } from './php';
import { magoAvailable, suppressionComment } from './mago';

type Editor = monaco.editor.IStandaloneCodeEditor;

const SEP: ContextItem = { kind: 'sep' };

/** Shortcuts shown in menus; each one is also bound in EditorArea. */
export const SHORTCUTS = {
  contextActions: 'Alt+Enter',
  copyPath: 'Ctrl+Shift+C',
  copyReference: 'Ctrl+Alt+Shift+C',
  columnSelection: 'Alt+Shift+Insert',
  findUsages: 'Alt+F7',
  rename: 'Shift+F6',
  expand: 'Ctrl+NumPad +',
  collapse: 'Ctrl+NumPad -',
  expandAll: 'Ctrl+Shift+NumPad +',
  collapseAll: 'Ctrl+Shift+NumPad -',
  declaration: 'Ctrl+B',
  implementation: 'Ctrl+Alt+B',
  typeDeclaration: 'Ctrl+Shift+B',
  line: 'Ctrl+G',
  generate: 'Alt+Insert',
  reformat: 'Ctrl+Alt+L',
  runTests: 'Ctrl+Shift+F10',
  commit: 'Ctrl+K',
} as const;

const isRefactor = (a: CodeAction) => a.kind.startsWith('refactor');
const isGenerate = (a: CodeAction) => a.kind.startsWith('source') || /^(generate|add|implement|create)\b/i.test(a.title);

export async function codeActionsForSelection(editor: Editor): Promise<CodeAction[]> {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel || !isLspActive()) return [];
  const actions = await codeActionsAt(model, sel);
  return actions.sort((a, b) => Number(b.preferred) - Number(a.preferred));
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
  // One submenu per rule, like PhpStorm's "Inspection 'X' options ▸".
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
    { label: 'Re-analyze Project', icon: 'refresh', disabled: !disk || ws.magoStatus.state === 'analyzing', run: ws.reanalyzeProject },
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
  // Quick fixes (with a bulb) first, then a line, then intentions, like PhpStorm.
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
  open: { contextActions: () => void; generate: () => void; gotoLine: () => void },
): ContextItem[] {
  const model = editor.getModel()!;
  const lsp = isLspActive();
  const run = (id: string) => () => {
    editor.focus();
    editor.trigger('phpblitz', id, {});
  };
  const reference = referenceAt(editor);
  const className = structureOf(model.getValue()).find((s) => s.depth === 0)?.name ?? baseName(path);
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
    { label: 'Paste', shortcut: 'Ctrl+V', icon: 'paste', run: run('editor.action.clipboardPasteAction') },
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
      disabled: !lsp,
      run: () => {
        const pos = editor.getPosition();
        if (pos) ws.findUsagesAt(model, pos);
      },
    },
    {
      label: 'Refactor',
      icon: 'pencil',
      submenu: [
        { label: 'Rename…', shortcut: SHORTCUTS.rename, disabled: !lsp, run: run('editor.action.rename') },
        ...(refactors.length ? [SEP, ...actionItems(refactors, '', (e) => reportError(ws, e))] : []),
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
    ...(isTest ? [{ label: `Run '${className}'`, shortcut: SHORTCUTS.runTests, icon: 'run' as const, run: ws.runTests }] : []),
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
    {
      label: 'Git',
      icon: 'git',
      disabled: !ws.git,
      submenu: [
        { label: 'Commit File…', shortcut: SHORTCUTS.commit, run: () => ws.showLeft('commit') },
        { label: 'Refresh Status', icon: 'refresh', run: ws.refreshGit },
      ],
    },
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
  return [...mago, ...lsp];
}

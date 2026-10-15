import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { inferType, phpIndex, structureOf } from './php';
import { isLspActive, usageCount } from './lsp/monacoBridge';
import { getSettings } from './settings';

// Bundle Monaco instead of loading it from a CDN, so the IDE works offline.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

// Color schemes and the PHP grammar they color.
import './editor/themes';
import './editor/phpGrammar';

// "N usages" on their own line above declarations, like JetBrains' code vision.
const hintsChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
export function refreshUsageHints() {
  hintsChanged.fire(usageLenses);
}

/** Clicking "N usages" runs Find Usages; EditorArea connects it to the workspace. */
let usagesHandler: ((model: monaco.editor.ITextModel, position: monaco.IPosition) => void) | null = null;
export function setUsagesHandler(fn: typeof usagesHandler) {
  usagesHandler = fn;
}
const SHOW_USAGES = monaco.editor.registerCommand('phpblitz.showUsages', (_accessor, uri: string, line: number, column: number) => {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (model) usagesHandler?.(model, { lineNumber: line, column });
});
void SHOW_USAGES;

interface UsageLens extends monaco.languages.CodeLens {
  /** Where the declared name is (1-based), to count its references. */
  at: { line: number; column: number; name: string };
}

const usageLenses: monaco.languages.CodeLensProvider = {
  onDidChange: hintsChanged.event,
  provideCodeLenses(model) {
    if (!getSettings().editor.codeVision) return { lenses: [], dispose() {} };
    const lines = model.getLinesContent();
    const lenses: UsageLens[] = structureOf(model.getValue())
      .filter((s) => ['class', 'interface', 'trait', 'enum', 'method', 'property', 'function', 'const'].includes(s.kind) && s.name !== '__construct')
      .slice(0, 200)
      .flatMap((s) => {
        const text = lines[s.line - 1] ?? '';
        const column = s.kind === 'property' ? text.indexOf('$' + s.name) + 2 : text.search(new RegExp(String.raw`\b${s.name}\b`)) + 1;
        if (column <= 0) return [];
        // Above the declaration's attributes (#[Route(...)]) and doc comment, like PhpStorm.
        let top = s.line;
        while (top > 1 && /^\s*#\[/.test(lines[top - 2])) top--;
        return [{ range: new monaco.Range(top, 1, top, 1), at: { line: s.line, column, name: s.name } }];
      });
    return { lenses, dispose() {} };
  },
  async resolveCodeLens(model, lens) {
    const { at } = lens as UsageLens;
    // With a language server: real reference counts. Without: the name-based estimate.
    const n = isLspActive() ? await usageCount(model, at.line, at.column) : phpIndex.usages(at.name);
    const title = n === null ? ' ' : n === 0 ? 'no usages' : n === 1 ? '1 usage' : `${n} usages`;
    return { ...lens, command: { id: 'phpblitz.showUsages', title, arguments: [model.uri.toString(), at.line, at.column] } };
  },
};
monaco.languages.registerCodeLensProvider('php', usageLenses);

// Remove VS Code keybindings whose popups we replace with PhpStorm ones (see EditorArea).
const { KeyMod, KeyCode } = monaco;
monaco.editor.addKeybindingRules([
  { keybinding: KeyCode.F1, command: '-editor.action.quickCommand' },
  { keybinding: KeyMod.CtrlCmd | KeyCode.KeyG, command: '-editor.action.gotoLine' },
  { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO, command: '-editor.action.quickOutline' },
  { keybinding: KeyMod.CtrlCmd | KeyCode.KeyF, command: '-actions.find' },
  { keybinding: KeyMod.CtrlCmd | KeyCode.KeyH, command: '-editor.action.startFindReplaceAction' },
  { keybinding: KeyCode.F3, command: '-editor.action.nextMatchFindAction' },
  { keybinding: KeyMod.Shift | KeyCode.F3, command: '-editor.action.previousMatchFindAction' },
  { keybinding: KeyMod.Alt | KeyCode.F12, command: '-editor.action.peekDefinition' },
  { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F12, command: '-editor.action.peekImplementation' },
  { keybinding: KeyMod.CtrlCmd | KeyCode.F12, command: '-editor.action.goToImplementation' },
  { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR, command: '-editor.action.refactor' },
  // VS Code's problem peek ("1 of 1 problem"); F2 / Shift+F2 show PhpStorm's popup instead.
  { keybinding: KeyMod.Alt | KeyCode.F8, command: '-editor.action.marker.next' },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.F8, command: '-editor.action.marker.prev' },
  { keybinding: KeyCode.F8, command: '-editor.action.marker.nextInFiles' },
  { keybinding: KeyMod.Shift | KeyCode.F8, command: '-editor.action.marker.prevInFiles' },
  { keybinding: KeyCode.F2, command: '-editor.action.rename' },
]);

const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;

// Member completion after `->` and `::`, using the project class index.
monaco.languages.registerCompletionItemProvider('php', {
  triggerCharacters: ['>', ':'],
  provideCompletionItems(model, position) {
    if (isLspActive()) return { suggestions: [] };
    const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const m = prefix.match(/(\$this->\w+|\$\w+|\b[A-Z]\w*)\s*(->|::)(\w*)$/);
    if (!m) return { suggestions: [] };
    const [, target, op, typed] = m;
    const src = model.getValue();
    const type = target.startsWith('$') ? inferType(src, target) : target === 'self' || target === 'static' ? inferType(src, '$this') : target;
    if (!type) return { suggestions: [] };

    const isStatic = op === '::';
    const ownClass = structureOf(src).find((s) => s.depth === 0)?.name;
    const canSeePrivate = target === '$this' || type === ownClass;
    const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);

    const suggestions = phpIndex
      .membersOf(type)
      .filter((s) => (isStatic ? s.isStatic || s.kind === 'const' || s.kind === 'method' : s.kind !== 'const'))
      .filter((s) => canSeePrivate || s.visibility === 'public')
      .filter((s) => s.name !== '__construct')
      .map((s, i) => {
        const isMethod = s.kind === 'method';
        return {
          label: { label: s.name, detail: isMethod ? `(${s.params ?? ''})` : '', description: s.detail || undefined },
          kind: isMethod ? CompletionItemKind.Method : s.kind === 'const' ? CompletionItemKind.Constant : CompletionItemKind.Property,
          insertText: isMethod ? `${s.name}($0)` : isStatic && s.kind === 'property' ? `$${s.name}` : s.name,
          insertTextRules: isMethod ? CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          sortText: String(i).padStart(4, '0'),
          range,
        };
      });
    return { suggestions };
  },
});

export { monaco };

// Registers Monaco providers once per page: reload fully instead of registering them twice on hot update.
import.meta.hot?.dispose(() => location.reload());

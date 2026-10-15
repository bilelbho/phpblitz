import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { inferType, phpIndex, structureOf } from './php';
import { isLspActive, usageCount } from './lsp/monacoBridge';

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

// Colors of JetBrains' "Dark" editor scheme (new UI).
monaco.editor.defineTheme('phpblitz-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'BCBEC4' },
    { token: 'keyword', foreground: 'CF8E6D' },
    { token: 'string', foreground: '6AAB73' },
    { token: 'variable', foreground: 'C77DBB' },
    { token: 'comment', foreground: '7A7E85', fontStyle: 'italic' },
    { token: 'number', foreground: '2AACB8' },
    { token: 'type', foreground: 'BCBEC4' },
    { token: 'delimiter', foreground: 'BCBEC4' },
    { token: 'metatag', foreground: 'CF8E6D' },
    { token: 'tag', foreground: 'D5B778' },
    { token: 'attribute.name', foreground: 'BABABA' },
    { token: 'string.key.json', foreground: 'C77DBB' },
    { token: 'string.value.json', foreground: '6AAB73' },
  ],
  colors: {
    'editor.background': '#1E1F22',
    'editor.foreground': '#BCBEC4',
    'editor.lineHighlightBackground': '#26282E',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#4B5059',
    'editorLineNumber.activeForeground': '#A1A3AB',
    'editorCursor.foreground': '#CED0D6',
    'editor.selectionBackground': '#214283',
    'editor.inactiveSelectionBackground': '#2B3446',
    'editor.wordHighlightBackground': '#373B39',
    'editor.wordHighlightStrongBackground': '#3B3B4A',
    'editorBracketMatch.background': '#43454A',
    'editorBracketMatch.border': '#00000000',
    'editorGutter.background': '#1E1F22',
    'editorInlayHint.foreground': '#868A91',
    'editorInlayHint.background': '#00000000',
    'editorWidget.background': '#2B2D30',
    'editorWidget.border': '#43454A',
    'editorHoverWidget.background': '#2B2D30',
    'editorHoverWidget.border': '#43454A',
    'editorSuggestWidget.background': '#2B2D30',
    'editorSuggestWidget.border': '#43454A',
    'editorSuggestWidget.foreground': '#DFE1E5',
    'editorSuggestWidget.selectedBackground': '#2E436E',
    'editorSuggestWidget.highlightForeground': '#548AF7',
    'editorStickyScroll.background': '#1E1F22',
    'editorStickyScrollHover.background': '#26282E',
    'editorIndentGuide.background1': '#313438',
    'editorIndentGuide.activeBackground1': '#43454A',
    'editorError.foreground': '#F75464',
    'editorWarning.foreground': '#E5A33D',
    'editorOverviewRuler.border': '#00000000',
    'minimap.background': '#1E1F22',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#4E515766',
    'scrollbarSlider.hoverBackground': '#5A5D63aa',
    'scrollbarSlider.activeBackground': '#5A5D63cc',
  },
});

// "N usages" after declarations, like JetBrains' code vision hints.
const hintsChanged = new monaco.Emitter<void>();
export function refreshUsageHints() {
  hintsChanged.fire();
}

monaco.languages.registerInlayHintsProvider('php', {
  onDidChangeInlayHints: hintsChanged.event,
  async provideInlayHints(model, range) {
    const declarations = structureOf(model.getValue())
      .filter((s) => s.line >= range.startLineNumber && s.line <= range.endLineNumber)
      .filter((s) => (s.kind === 'method' || s.kind === 'property' || s.kind === 'function') && s.name !== '__construct')
      .slice(0, 60);
    const hints = await Promise.all(
      declarations.map(async (s): Promise<monaco.languages.InlayHint | null> => {
        const text = model.getLineContent(s.line);
        // With a language server: real reference counts. Without: the name-based estimate.
        let n: number | null = phpIndex.usages(s.name);
        if (isLspActive()) {
          const at = s.kind === 'property' ? text.indexOf('$' + s.name) + 1 : text.search(new RegExp(String.raw`\b${s.name}\s*\(`));
          n = at >= 0 ? await usageCount(model, s.line, at + 1) : null;
          if (n === null) return null;
        }
        const brace = text.lastIndexOf('{');
        return {
          label: n === 0 ? 'no usages' : n === 1 ? '1 usage' : `${n} usages`,
          position: { lineNumber: s.line, column: brace >= 0 ? brace + 2 : model.getLineMaxColumn(s.line) },
          paddingLeft: true,
        };
      }),
    );
    return { hints: hints.filter((h): h is monaco.languages.InlayHint => !!h), dispose() {} };
  },
});

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

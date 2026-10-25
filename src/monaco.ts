import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { structureOf } from './php';
import { chainType, parseChain } from './completion/phpTypes';
import './completion/laravel';
import { symbols } from './symbols';
import { isLspActive, usageCount } from './lsp/monacoBridge';
import { getSettings } from './settings';
import { COMMANDS } from './keymap/catalog';
import { reservedKeys, setEditorFinder } from './keymap/commands';
import { vimReserves } from './editor/vimKeys';

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
import './editor/dotenv';
import './editor/csv';

// "N usages" on their own line above declarations (code vision).
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
      // Types, methods and functions. Not properties and constants: a line each, and often used
      // where references can't be counted (Eloquent attributes, $fillable, config keys).
      .filter((s) => ['class', 'interface', 'trait', 'enum', 'method', 'function'].includes(s.kind) && s.name !== '__construct')
      .slice(0, 200)
      .flatMap((s) => {
        const text = lines[s.line - 1] ?? '';
        const column = text.search(new RegExp(String.raw`\b${s.name}\b`)) + 1;
        if (column <= 0) return [];
        // Above the declaration's attributes (#[Route(...)]) and doc comment.
        let top = s.line;
        while (top > 1 && /^\s*#\[/.test(lines[top - 2])) top--;
        return [{ range: new monaco.Range(top, 1, top, 1), at: { line: s.line, column, name: s.name } }];
      });
    return { lenses, dispose() {} };
  },
  async resolveCodeLens(model, lens) {
    const { at } = lens as UsageLens;
    // With a language server: real reference counts. Without: the name-based estimate.
    const n = isLspActive() ? await usageCount(model, at.line, at.column) : await symbols.usages(at.name);
    const title = n === null ? ' ' : n === 0 ? 'no usages' : n === 1 ? '1 usage' : `${n} usages`;
    return { ...lens, command: { id: 'phpblitz.showUsages', title, arguments: [model.uri.toString(), at.line, at.column] } };
  },
};
const usageLensesRegistration = monaco.languages.registerCodeLensProvider('php', usageLenses);
// Dev reloads: the new module registers again, so the old one goes ("9 usages | 9 usages" otherwise).
import.meta.hot?.dispose(() => usageLensesRegistration.dispose());

// The keymap (keymap/) runs Monaco's editing commands it lists: their Monaco keys go, so each
// keymap has only its own (a removal without keys removes all of a command's).
monaco.editor.addKeybindingRules(COMMANDS.filter((c) => c.monaco).map((c) => ({ keybinding: 0, command: `-${c.id}` })));
setEditorFinder(() => {
  const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus());
  if (!editor) return null;
  return {
    hasTextFocus: () => editor.hasTextFocus(),
    getAction: (id) => editor.getAction(id),
    trigger: (source, id, payload) => editor.trigger(source, id, payload),
    readOnly: () => editor.getOption(monaco.editor.EditorOption.readOnly),
    // The widgets can live outside the editor's own element (overflow widgets): only one editor has the focus.
    widgetOpen: () => !!document.querySelector('.suggest-widget.visible, .parameter-hints-widget.visible'),
    reserves: (keys) => !!reservedKeys(editor)?.has(keys) || vimReserves(editor, keys),
  };
});

// Remove Monaco keybindings whose popups we replace with our own (see EditorArea).
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
  // VS Code's problem peek ("1 of 1 problem"); F2 / Shift+F2 show our popup instead.
  { keybinding: KeyMod.Alt | KeyCode.F8, command: '-editor.action.marker.next' },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.F8, command: '-editor.action.marker.prev' },
  { keybinding: KeyCode.F8, command: '-editor.action.marker.nextInFiles' },
  { keybinding: KeyMod.Shift | KeyCode.F8, command: '-editor.action.marker.prevInFiles' },
  { keybinding: KeyCode.F2, command: '-editor.action.rename' },
]);

const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;

// Member completion after `->`, `?->` and `::`: the class of the expression before it (variables,
// chains of calls and properties, `new`, function calls, `self` / `static` / `parent`), its own and
// inherited members, `@method` / `@property` docblock members and `@mixin` classes included.
monaco.languages.registerCompletionItemProvider('php', {
  triggerCharacters: ['>', ':'],
  async provideCompletionItems(model, position) {
    if (isLspActive()) return { suggestions: [] };
    const offset = model.getOffsetAt(position);
    // The code before the cursor, from a little before the statement (chains can span lines).
    const src = model.getValue();
    const before = src.slice(Math.max(0, offset - 4000), offset);
    const m = before.match(/(\??->|::)\s*(\w*)$/);
    if (!m) return { suggestions: [] };
    const [, op, typed] = m;
    const receiverText = before.slice(0, before.length - m[0].length);
    const chain = parseChain(receiverText, op === '::' ? '::' : '->');
    if (!chain) return { suggestions: [] };
    const type = await chainType(chain, src, offset);
    if (!type.cls) return { suggestions: [] };
    const info = await symbols.classInfo(type.cls);
    if (!info) return { suggestions: [] };

    const isStatic = op === '::';
    const base = chain.base;
    const fromInside = chain.steps.length === 0 && ((base.kind === 'var' && base.name === '$this') || (base.kind === 'class' && /^(self|static|parent)$/i.test(base.name)));
    const own = structureOf(src).find((s) => s.depth === 0)?.name;
    const canSeePrivate = fromInside || info.name === own;
    const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);

    const suggestions: monaco.languages.CompletionItem[] = info.allMembers
      .filter((s) => (isStatic ? s.isStatic || s.kind === 'const' || s.kind === 'method' : s.kind !== 'const' && !(s.kind === 'property' && s.isStatic)))
      .filter((s) => canSeePrivate || s.visibility === 'public' || (s.visibility === 'protected' && fromInside))
      .filter((s) => s.name !== '__construct' || (isStatic && base.kind === 'class' && /^parent$/i.test(base.name)))
      .map((s, i) => {
        const isMethod = s.kind === 'method';
        const returns = s.ty && s.ty !== 'static' ? s.ty.split('\\').pop() : s.detail;
        return {
          label: { label: s.name, detail: isMethod ? `(${s.params ?? ''})` : '', description: returns || undefined },
          kind: isMethod ? CompletionItemKind.Method : s.kind === 'const' ? CompletionItemKind.Constant : CompletionItemKind.Property,
          insertText: isMethod ? `${s.name}($0)` : isStatic && s.kind === 'property' ? `$${s.name}` : s.name,
          insertTextRules: isMethod ? CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          // The class's own members first, then inherited and mixin ones (allMembers keeps that order).
          sortText: String(i).padStart(4, '0'),
          range,
        };
      });
    if (isStatic) suggestions.push({ label: 'class', kind: CompletionItemKind.Keyword, insertText: 'class', sortText: '9999', range });
    return { suggestions };
  },
});

export { monaco };

// Registers Monaco providers once per page: reload fully instead of registering them twice on hot update.
import.meta.hot?.dispose(() => location.reload());

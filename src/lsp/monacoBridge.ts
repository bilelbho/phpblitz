// Connects Monaco's editor features to the active language server.
//
// Providers are registered once for 'php' and look up the active client on
// each call, so a server can be started, swapped or stopped at any time.
// Without an active server they return nothing, and the regex fallbacks in
// monaco.ts take over.

import * as monaco from 'monaco-editor';
import type { LspClient } from './client';
import { pathToUri, uriToPath } from './client';
import type * as L from './protocol';

export interface LspContext {
  /** Opens a file in a tab and moves the caret (1-based line and column). */
  openAt(path: string, line: number, column: number): void;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
}

let active: { client: LspClient; ctx: LspContext } | null = null;

export function setActiveLsp(client: LspClient | null, ctx?: LspContext) {
  active = client && ctx ? { client, ctx } : null;
  hintCache.clear();
}

export function isLspActive() {
  return !!active?.client.running;
}

export function activeServerName() {
  return active?.client.spec.name ?? null;
}

// ── Conversions ───────────────────────────────────────────────

const pathOf = (model: monaco.editor.ITextModel) => uriToPath(model.uri.toString());
const docOf = (model: monaco.editor.ITextModel) => ({ uri: pathToUri(pathOf(model)) });
const toPos = (p: monaco.IPosition): L.Position => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r: L.Range) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const modelUri = (uri: string) => monaco.Uri.file(uriToPath(uri));

function markdown(content: L.Hover['contents'] | L.MarkupContent | string | undefined): monaco.IMarkdownString[] {
  if (!content) return [];
  const one = (c: L.MarkedString | L.MarkupContent): monaco.IMarkdownString =>
    typeof c === 'string' ? { value: c } : 'kind' in c ? { value: c.value } : { value: '```' + c.language + '\n' + c.value + '\n```' };
  return Array.isArray(content) ? content.map(one) : [one(content as L.MarkupContent)];
}

const LSP_KIND_NAMES = [
  '', 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit',
  'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event',
  'Operator', 'TypeParameter',
] as const;

function completionKind(kind?: number): monaco.languages.CompletionItemKind {
  const name = LSP_KIND_NAMES[kind ?? 1] || 'Text';
  return (monaco.languages.CompletionItemKind as unknown as Record<string, number>)[name] ?? monaco.languages.CompletionItemKind.Text;
}

function toLocations(result: L.Location | L.Location[] | L.LocationLink[] | null): monaco.languages.Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((l) =>
    'targetUri' in l ? { uri: modelUri(l.targetUri), range: toRange(l.targetSelectionRange ?? l.targetRange) } : { uri: modelUri(l.uri), range: toRange(l.range) },
  );
}

function can(cap: keyof L.ServerCapabilities) {
  return !!active?.client.running && !!active.client.capabilities[cap];
}

// ── Providers ─────────────────────────────────────────────────

monaco.languages.registerCompletionItemProvider('php', {
  triggerCharacters: ['$', '>', ':', '\\', '@'],
  async provideCompletionItems(model, position, context) {
    if (!can('completionProvider')) return { suggestions: [] };
    const result = await active!.client.request<L.CompletionList | L.CompletionItem[] | null>('textDocument/completion', {
      textDocument: docOf(model),
      position: toPos(position),
      context: context.triggerCharacter ? { triggerKind: 2, triggerCharacter: context.triggerCharacter } : { triggerKind: 1 },
    });
    const items = Array.isArray(result) ? result : result?.items ?? [];
    const word = model.getWordUntilPosition(position);
    const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
    const suggestions = items.map((item): monaco.languages.CompletionItem => {
      let range: monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange } = fallback;
      let text = item.insertText ?? item.label;
      if (item.textEdit) {
        text = item.textEdit.newText;
        range = 'range' in item.textEdit ? toRange(item.textEdit.range) : { insert: toRange(item.textEdit.insert), replace: toRange(item.textEdit.replace) };
      }
      return {
        label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
        kind: completionKind(item.kind),
        detail: item.detail,
        documentation: item.documentation ? markdown(item.documentation)[0] : undefined,
        sortText: item.sortText,
        filterText: item.filterText,
        preselect: item.preselect,
        insertText: text,
        insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        range,
        additionalTextEdits: item.additionalTextEdits?.map((e) => ({ range: toRange(e.range), text: e.newText })),
        tags: item.deprecated || item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
      };
    });
    return { suggestions, incomplete: !Array.isArray(result) && !!result?.isIncomplete };
  },
});

monaco.languages.registerHoverProvider('php', {
  async provideHover(model, position) {
    if (!can('hoverProvider')) return null;
    const hover = await active!.client.request<L.Hover | null>('textDocument/hover', { textDocument: docOf(model), position: toPos(position) });
    if (!hover) return null;
    return { contents: markdown(hover.contents), range: hover.range ? toRange(hover.range) : undefined };
  },
});

/** The language server's documentation at a position as Markdown (PHPBlitz's own hover popup shows it). */
export async function hoverAt(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<string | null> {
  if (!can('hoverProvider')) return null;
  const hover = await active!.client.request<L.Hover | null>('textDocument/hover', { textDocument: docOf(model), position: toPos(position) }).catch(() => null);
  if (!hover) return null;
  const text = markdown(hover.contents)
    .map((m) => m.value.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
  return text || null;
}

monaco.languages.registerDefinitionProvider('php', {
  async provideDefinition(model, position) {
    if (!can('definitionProvider')) return null;
    return toLocations(await active!.client.request('textDocument/definition', { textDocument: docOf(model), position: toPos(position) }));
  },
});

monaco.languages.registerImplementationProvider('php', {
  async provideImplementation(model, position) {
    if (!can('implementationProvider')) return null;
    return toLocations(await active!.client.request('textDocument/implementation', { textDocument: docOf(model), position: toPos(position) }));
  },
});

monaco.languages.registerDocumentHighlightProvider('php', {
  async provideDocumentHighlights(model, position) {
    if (!can('documentHighlightProvider')) return null;
    const list = await active!.client.request<{ range: L.Range; kind?: number }[] | null>('textDocument/documentHighlight', {
      textDocument: docOf(model),
      position: toPos(position),
    });
    return (list ?? []).map((h) => ({ range: toRange(h.range), kind: h.kind === 3 ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Read }));
  },
});

monaco.languages.registerSignatureHelpProvider('php', {
  signatureHelpTriggerCharacters: ['(', ','],
  async provideSignatureHelp(model, position) {
    if (!can('signatureHelpProvider')) return null;
    const help = await active!.client.request<L.SignatureHelp | null>('textDocument/signatureHelp', { textDocument: docOf(model), position: toPos(position) });
    if (!help?.signatures?.length) return null;
    return {
      value: {
        signatures: help.signatures.map((s) => ({
          label: s.label,
          documentation: s.documentation ? markdown(s.documentation)[0] : undefined,
          parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: p.documentation ? markdown(p.documentation)[0] : undefined })),
        })),
        activeSignature: help.activeSignature ?? 0,
        activeParameter: help.activeParameter ?? 0,
      },
      dispose() {},
    };
  },
});

// Formatting is done by Mago, built into the Rust core (see src/mago.ts).

monaco.languages.registerInlayHintsProvider('php', {
  async provideInlayHints(model, range) {
    if (!can('inlayHintProvider')) return { hints: [], dispose() {} };
    const hints = await active!.client.request<L.InlayHint[] | null>('textDocument/inlayHint', {
      textDocument: docOf(model),
      range: { start: toPos(range.getStartPosition()), end: toPos(range.getEndPosition()) },
    });
    return {
      hints: (hints ?? []).map((h) => ({
        position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
        label: typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join(''),
        kind: h.kind === 2 ? monaco.languages.InlayHintKind.Parameter : monaco.languages.InlayHintKind.Type,
        paddingLeft: h.paddingLeft,
        paddingRight: h.paddingRight,
      })),
      dispose() {},
    };
  },
});

monaco.languages.registerRenameProvider('php', {
  async resolveRenameLocation(model, position) {
    if (!can('renameProvider')) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'Rename needs a language server' };
    const word = model.getWordAtPosition(position);
    const prepare = typeof active!.client.capabilities.renameProvider === 'object' && active!.client.capabilities.renameProvider.prepareProvider;
    if (!prepare) {
      if (!word) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'Nothing to rename here' };
      return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word };
    }
    const r = await active!.client.request<L.Range | { range: L.Range; placeholder: string } | { defaultBehavior: boolean } | null>('textDocument/prepareRename', {
      textDocument: docOf(model),
      position: toPos(position),
    });
    if (!r) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'This element can’t be renamed' };
    if ('start' in r) return { range: toRange(r), text: model.getValueInRange(toRange(r)) };
    if ('range' in r) return { range: toRange(r.range), text: r.placeholder };
    if (!word) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'Nothing to rename here' };
    return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word };
  },
  async provideRenameEdits(model, position, newName) {
    if (!can('renameProvider')) return { edits: [], rejectReason: 'Rename needs a language server' };
    const edit = await active!.client.request<L.WorkspaceEdit | null>('textDocument/rename', { textDocument: docOf(model), position: toPos(position), newName });
    return { edits: await applyWorkspaceEdit(edit) };
  },
});

/**
 * Edits for files open in Monaco are returned for Monaco to apply (so they can be
 * undone); edits for other files are written straight to disk.
 */
export async function applyWorkspaceEdit(edit: L.WorkspaceEdit | null): Promise<monaco.languages.IWorkspaceTextEdit[]> {
  if (!edit || !active) return [];
  const byUri: Record<string, L.TextEdit[]> = { ...(edit.changes ?? {}) };
  for (const dc of edit.documentChanges ?? []) if (dc.textDocument && dc.edits) byUri[dc.textDocument.uri] = dc.edits;
  const monacoEdits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [uri, edits] of Object.entries(byUri)) {
    const resource = modelUri(uri);
    if (monaco.editor.getModel(resource)) {
      for (const e of edits) monacoEdits.push({ resource, versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } });
      continue;
    }
    const path = uriToPath(uri);
    const text = await active.ctx.readText(path);
    await active.ctx.writeText(path, applyTextEdits(text, edits));
  }
  return monacoEdits;
}

function applyTextEdits(text: string, edits: L.TextEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const offset = (p: L.Position) => Math.min((lineStarts[p.line] ?? text.length) + p.character, text.length);
  // Apply from the end so earlier offsets stay valid.
  return [...edits]
    .sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce((acc, e) => acc.slice(0, offset(e.range.start)) + e.newText + acc.slice(offset(e.range.end)), text);
}

monaco.languages.registerTypeDefinitionProvider('php', {
  async provideTypeDefinition(model, position) {
    if (!can('typeDefinitionProvider')) return null;
    return toLocations(await active!.client.request('textDocument/typeDefinition', { textDocument: docOf(model), position: toPos(position) }));
  },
});

/** Applies a workspace edit now: open files through Monaco (undoable), others on disk. */
export async function applyEditNow(edit: L.WorkspaceEdit | null | undefined) {
  for (const e of await applyWorkspaceEdit(edit ?? null)) {
    if (!('textEdit' in e)) continue;
    monaco.editor.getModel(e.resource)?.pushEditOperations([], [{ range: e.textEdit.range, text: e.textEdit.text }], () => null);
  }
}

/** Renames the symbol at a position (1-based) across the project, e.g. a class before its file is renamed. */
export async function renameSymbol(path: string, line: number, column: number, newName: string) {
  if (!can('renameProvider')) throw new Error('the language server cannot rename');
  const edit = await active!.client.request<L.WorkspaceEdit | null>('textDocument/rename', {
    textDocument: { uri: pathToUri(path) },
    position: { line: line - 1, character: column - 1 },
    newName,
  });
  if (!edit) throw new Error('nothing to rename');
  await applyEditNow(edit);
}

// ── Code actions (Alt+Enter, Refactor ▸, Generate…) ───────────

/** A text change in one file, 1-based (what the Alt+Enter popup previews). */
export interface TextChange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface CodeAction {
  title: string;
  kind: string;
  preferred: boolean;
  run: () => Promise<void>;
  /** The action's changes to the file `uri`, or null when it only runs a command. */
  preview?: (uri: string) => Promise<TextChange[] | null>;
}

type LspCommand = { title: string; command: string; arguments?: unknown[] };
type LspCodeAction = { title: string; kind?: string; isPreferred?: boolean; disabled?: { reason: string }; edit?: L.WorkspaceEdit; command?: LspCommand; data?: unknown };

/** Code actions the server offers at a selection, with the problems found there as context. */
export async function codeActionsAt(model: monaco.editor.ITextModel, range: monaco.IRange): Promise<CodeAction[]> {
  if (!can('codeActionProvider')) return [];
  const markers = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter((m) => m.startLineNumber <= range.endLineNumber && m.endLineNumber >= range.startLineNumber);
  const result = await active!.client
    .request<(LspCodeAction | LspCommand)[] | null>('textDocument/codeAction', {
      textDocument: docOf(model),
      range: { start: toPos({ lineNumber: range.startLineNumber, column: range.startColumn }), end: toPos({ lineNumber: range.endLineNumber, column: range.endColumn }) },
      context: {
        diagnostics: markers.map((m) => ({
          range: { start: { line: m.startLineNumber - 1, character: m.startColumn - 1 }, end: { line: m.endLineNumber - 1, character: m.endColumn - 1 } },
          message: m.message,
          severity: m.severity === monaco.MarkerSeverity.Error ? 1 : m.severity === monaco.MarkerSeverity.Warning ? 2 : 3,
        })),
        triggerKind: 1,
      },
    })
    .catch(() => null);
  const client = active!.client;
  const execute = (cmd: LspCommand) => client.request('workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments ?? [] }).then(() => {});
  return (result ?? [])
    .filter((a) => !('disabled' in a && a.disabled))
    .map((a): CodeAction => {
      if (typeof (a as LspCommand).command === 'string') {
        const cmd = a as LspCommand;
        return { title: cmd.title, kind: '', preferred: false, run: () => execute(cmd) };
      }
      const action = a as LspCodeAction;
      // Servers may send actions without their edit and fill it in on resolve (once, shared by preview and run).
      let resolved: Promise<LspCodeAction> | null = null;
      const full = () => (resolved ??= !action.edit && !action.command && can('codeActionProvider') ? client.request<LspCodeAction>('codeAction/resolve', action) : Promise.resolve(action));
      return {
        title: action.title,
        kind: action.kind ?? '',
        preferred: !!action.isPreferred,
        run: async () => {
          const done = await full();
          await applyEditNow(done.edit);
          if (done.command) await execute(done.command);
        },
        preview: async (uri) => {
          const edit = (await full()).edit;
          if (!edit) return null;
          const same = (u: string) => modelUri(u).toString() === monaco.Uri.parse(uri).toString();
          const edits = [
            ...Object.entries(edit.changes ?? {}).filter(([u]) => same(u)).flatMap(([, list]) => list),
            ...(edit.documentChanges ?? []).filter((dc) => dc.textDocument && same(dc.textDocument.uri)).flatMap((dc) => dc.edits ?? []),
          ];
          return edits.map((e) => ({
            startLine: e.range.start.line + 1,
            startColumn: e.range.start.character + 1,
            endLine: e.range.end.line + 1,
            endColumn: e.range.end.character + 1,
            text: e.newText,
          }));
        },
      };
    });
}

// Go to definition in another file: open it in a PHPBlitz tab.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    if (!active) return false;
    const pos = selectionOrPosition
      ? 'startLineNumber' in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, col: selectionOrPosition.startColumn }
        : { line: selectionOrPosition.lineNumber, col: selectionOrPosition.column }
      : { line: 1, col: 1 };
    active.ctx.openAt(uriToPath(resource.toString()), pos.line, pos.col);
    return true;
  },
});

// ── Find usages ───────────────────────────────────────────────

export interface Usage {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  /** Without a language server: called on an untyped receiver, maybe another class's member. */
  dynamic?: boolean;
  /** Properties: read or written there. */
  access?: '' | 'read' | 'write';
}

export async function findUsages(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<{ name: string; usages: Usage[] } | null> {
  if (!can('referencesProvider')) return null;
  const name = model.getWordAtPosition(position)?.word ?? '';
  const locations = await active!.client.request<L.Location[] | null>('textDocument/references', {
    textDocument: docOf(model),
    position: toPos(position),
    context: { includeDeclaration: false },
  });
  const texts = new Map<string, string[]>();
  const linesOf = async (path: string) => {
    if (!texts.has(path)) {
      const open = monaco.editor.getModel(monaco.Uri.file(path));
      const text = open ? open.getValue() : await active!.ctx.readText(path).catch(() => '');
      texts.set(path, text.split(/\r?\n/));
    }
    return texts.get(path)!;
  };
  const usages: Usage[] = [];
  for (const loc of uniqueLocations(locations)) {
    const path = uriToPath(loc.uri);
    const lines = await linesOf(path);
    usages.push({
      path,
      line: loc.range.start.line + 1,
      column: loc.range.start.character + 1,
      endColumn: loc.range.end.character + 1,
      preview: (lines[loc.range.start.line] ?? '').trim(),
    });
  }
  usages.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { name, usages };
}

/** Some servers report the same location twice; count each place once. */
export function uniqueLocations(list: L.Location[] | null | undefined): L.Location[] {
  const seen = new Set<string>();
  return (list ?? []).filter((l) => {
    const key = `${l.uri}:${l.range.start.line}:${l.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── "N usages" hints from real references ─────────────────────

const hintCache = new Map<string, number>();

/** Number of references to the symbol at a position, cached per document version. */
export async function usageCount(model: monaco.editor.ITextModel, line: number, column: number): Promise<number | null> {
  if (!can('referencesProvider')) return null;
  const path = pathOf(model);
  const key = `${path}:${active!.client.version(path)}:${line}:${column}`;
  if (hintCache.has(key)) return hintCache.get(key)!;
  try {
    const refs = await active!.client.request<L.Location[] | null>('textDocument/references', {
      textDocument: docOf(model),
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: false },
    });
    const n = uniqueLocations(refs).length;
    if (hintCache.size > 2000) hintCache.clear();
    hintCache.set(key, n);
    return n;
  } catch {
    return null;
  }
}

// Registers Monaco providers once per page: reload fully instead of registering them twice on hot update.
import.meta.hot?.dispose(() => location.reload());

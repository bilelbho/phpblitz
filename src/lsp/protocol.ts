// The subset of LSP types PHPBlitz uses (https://microsoft.github.io/language-server-protocol/).

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
  originSelectionRange?: Range;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: { textDocument: { uri: string }; edits: TextEdit[] }[];
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
}

export type MarkupContent = { kind: 'markdown' | 'plaintext'; value: string };
export type MarkedString = string | { language: string; value: string };

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

export interface CompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: TextEdit | { newText: string; insert: Range; replace: Range };
  additionalTextEdits?: TextEdit[];
  preselect?: boolean;
  deprecated?: boolean;
  tags?: number[];
}

export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

export interface SignatureHelp {
  signatures: {
    label: string;
    documentation?: string | MarkupContent;
    parameters?: { label: string | [number, number]; documentation?: string | MarkupContent }[];
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface InlayHint {
  position: Position;
  label: string | { value: string }[];
  kind?: 1 | 2;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export interface ServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: boolean | object;
  signatureHelpProvider?: { triggerCharacters?: string[] };
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentHighlightProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  workspaceSymbolProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
  renameProvider?: boolean | { prepareProvider?: boolean };
  inlayHintProvider?: boolean | object;
  codeActionProvider?: boolean | object;
  codeLensProvider?: object;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

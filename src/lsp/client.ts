// Minimal Language Server Protocol client.
//
// The Rust side (src-tauri/src/lsp.rs) only moves bytes; this class speaks
// JSON-RPC: requests with ids, notifications, document sync and the few
// server→client requests servers commonly send.

import { Channel, invoke } from '@tauri-apps/api/core';
import type * as L from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };
type Handler = (params: any) => void;

export interface ServerSpec {
  /** Display name, e.g. "PHPantom". */
  name: string;
  command: string;
  args: string[];
}

export class LspClient {
  readonly spec: ServerSpec;
  readonly root: string;
  capabilities: L.ServerCapabilities = {};
  private server = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Handler[]>();
  private versions = new Map<string, number>();
  private exited = false;

  constructor(spec: ServerSpec, root: string) {
    this.spec = spec;
    this.root = root;
  }

  /** Starts the process and performs the initialize handshake. */
  async start(): Promise<void> {
    // This server's own channel: its messages, stderr lines and exit, in order (and none lost
    // before its id is known).
    const events = new Channel<{ kind: 'message'; message: string } | { kind: 'log'; line: string } | { kind: 'exit' }>();
    events.onmessage = (e) => {
      if (e.kind === 'message') this.receive(e.message);
      else if (e.kind === 'log') this.emit('$log', e.line);
      else {
        this.exited = true;
        for (const p of this.pending.values()) p.reject(new Error('Language server exited'));
        this.pending.clear();
        this.emit('$exit', null);
      }
    };
    this.server = await invoke<number>('lsp_start', { command: this.spec.command, args: this.spec.args, cwd: this.root, onEvent: events });

    const rootUri = pathToUri(this.root);
    const result = await this.request<L.InitializeResult>('initialize', {
      processId: null,
      clientInfo: { name: 'PHPBlitz', version: '0.1.0' },
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: this.root.split('/').pop() }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: {},
    });
    this.capabilities = result.capabilities ?? {};
    this.notify('initialized', {});
  }

  async stop() {
    if (!this.exited && this.server) {
      try {
        await withTimeout(this.request('shutdown', null), 1500);
        this.notify('exit', null);
      } catch {
        // The process is killed below either way.
      }
      await invoke('lsp_stop', { server: this.server }).catch(() => {});
    }
  }

  get running() {
    return !this.exited && this.server > 0;
  }

  on(method: string, handler: Handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error('Language server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params: unknown) {
    if (this.exited) return;
    this.send({ jsonrpc: '2.0', method, params }).catch(() => {});
  }

  // ── Document sync (full text; valid for both full and incremental servers) ──

  didOpen(path: string, languageId: string, text: string) {
    this.versions.set(path, 1);
    this.notify('textDocument/didOpen', { textDocument: { uri: pathToUri(path), languageId, version: 1, text } });
  }

  didChange(path: string, text: string) {
    if (!this.versions.has(path)) return;
    const version = this.versions.get(path)! + 1;
    this.versions.set(path, version);
    this.notify('textDocument/didChange', { textDocument: { uri: pathToUri(path), version }, contentChanges: [{ text }] });
  }

  /** Whether the server takes edits as ranges (TextDocumentSyncKind.Incremental). */
  get incremental(): boolean {
    const sync = this.capabilities.textDocumentSync;
    return (typeof sync === 'number' ? sync : sync?.change) === 2;
  }

  /**
   * An editor edit: only the changed ranges when the server takes them, so a keystroke in a big
   * file doesn't send the whole file; else the full text (asked for only then).
   * `changes`: Monaco's, 1-based, in the order they apply.
   */
  didEdit(path: string, changes: readonly { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[], fullText: () => string) {
    if (!this.versions.has(path)) return;
    if (!this.incremental) return this.didChange(path, fullText());
    const version = this.versions.get(path)! + 1;
    this.versions.set(path, version);
    const contentChanges = changes.map((c) => ({
      range: { start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 }, end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 } },
      text: c.text,
    }));
    this.notify('textDocument/didChange', { textDocument: { uri: pathToUri(path), version }, contentChanges });
  }

  didSave(path: string, text: string) {
    if (!this.versions.has(path)) return;
    this.notify('textDocument/didSave', { textDocument: { uri: pathToUri(path) }, text });
  }

  didClose(path: string) {
    if (!this.versions.delete(path)) return;
    this.notify('textDocument/didClose', { textDocument: { uri: pathToUri(path) } });
  }

  isOpen(path: string) {
    return this.versions.has(path);
  }

  version(path: string) {
    return this.versions.get(path) ?? 0;
  }

  // ── Internals ──

  private send(message: object) {
    return invoke('lsp_send', { server: this.server, message: JSON.stringify(message) });
  }

  private emit(method: string, params: unknown) {
    for (const h of this.handlers.get(method) ?? []) h(params);
  }

  private receive(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    // Request from the server: answer so it never waits on us.
    if (msg.id !== undefined) {
      this.respond(msg.id, this.answerServerRequest(msg.method, msg.params));
      return;
    }
    this.emit(msg.method, msg.params);
  }

  private answerServerRequest(method: string, params: any): unknown {
    switch (method) {
      case 'workspace/configuration':
        return (params?.items ?? []).map(() => null);
      case 'workspace/workspaceFolders':
        return [{ uri: pathToUri(this.root), name: this.root.split('/').pop() }];
      case 'workspace/applyEdit':
        this.emit('$applyEdit', params.edit);
        return { applied: true };
      default:
        // window/workDoneProgress/create, client/registerCapability, …
        return null;
    }
  }

  private respond(id: number | string, result: unknown) {
    this.send({ jsonrpc: '2.0', id, result }).catch(() => {});
  }
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: false },
    configuration: true,
    workspaceFolders: true,
    symbol: {},
  },
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: {
      completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], labelDetailsSupport: true },
      contextSupport: true,
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rename: { prepareSupport: true },
    publishDiagnostics: { relatedInformation: false },
    inlayHint: {},
    codeAction: {
      dataSupport: true,
      resolveSupport: { properties: ['edit', 'command'] },
      isPreferredSupport: true,
      disabledSupport: true,
      codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.rewrite', 'source', 'source.organizeImports'] } } },
  },
  window: { workDoneProgress: true },
};

// ── Paths ⇄ URIs ──────────────────────────────────────────────

/** `C:/Users/me/a.php` → `file:///C:/Users/me/a.php` (drive colon kept, segments encoded). */
export function pathToUri(path: string): string {
  const parts = path.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  const joined = parts.join('/');
  return joined.startsWith('/') ? `file://${joined}` : `file:///${joined}`;
}

/** Inverse of pathToUri; also accepts `file:///c%3A/...` as Monaco writes it. */
export function uriToPath(uri: string): string {
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  p = p.replace(/\\/g, '/');
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  return p;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

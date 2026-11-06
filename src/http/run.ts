// The editor's way into the HTTP Client: the ▶ beside a request, Ctrl+Enter, Run All.

import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { parseHttpFile, requestAt } from './parse';
import { runRequest } from './client';

export const isHttpFile = (path: string) => /\.(http|rest)$/i.test(path);

/** Where new requests go: a scratch file in the project's .blitz folder (not part of the project). */
export const SCRATCH = '.blitz/http/requests.http';
const SCRATCH_TEXT = `# Requests: Ctrl+Enter or the ▶ sends the one at the caret. Variables come from
# http-client.env.json next to this file (and http-client.private.env.json for secrets).

### Example
GET {{host}}/
Accept: application/json
`;
const SCRATCH_ENV = `{
  "dev": {
    "host": "http://localhost:8000"
  }
}
`;

/** The scratch requests file (made, with an env file, the first time); its path. */
export async function ensureScratch(ws: Workspace): Promise<string> {
  const path = `${ws.backend.root}/${SCRATCH}`;
  const dir = path.slice(0, path.lastIndexOf('/'));
  await ws.backend.createDir(dir).catch(() => {});
  await ws.backend.createFile(path, SCRATCH_TEXT).catch(() => {});
  await ws.backend.createFile(`${dir}/http-client.env.json`, SCRATCH_ENV).catch(() => {});
  return path;
}

/** Endpoints ▸ Open in HTTP Client: a request for the route in the scratch file (once), opened there. */
export async function openRouteRequest(ws: Workspace, route: { method: string; uri: string }) {
  const path = await ensureScratch(ws);
  const method = route.method.split('|')[0].toUpperCase();
  const uri = route.uri.startsWith('/') ? route.uri : `/${route.uri}`;
  const title = `${method} ${uri}`;
  // The open document when there is one (unsaved edits stay), else the file.
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  const text = model?.getValue() ?? (await ws.backend.readFile(path).catch(() => ''));
  const existing = text.split('\n').findIndex((l) => l.trim() === `### ${title}`);
  if (existing >= 0) return ws.openFile(path, { line: existing + 2, column: 1 });
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? 'Content-Type: application/json\n\n{\n}\n' : '';
  // Route parameters ({id}, {post?}) as variables, each with a value to change (unless the file has one).
  const params = [...new Set([...uri.matchAll(/\{(\w+)\??\}/g)].map((m) => m[1]))];
  const vars = params.filter((p) => !new RegExp(`^@${p}\\s*=`, 'm').test(text)).map((p) => `@${p} = 1\n`).join('');
  const url = uri.replace(/\{(\w+)\??\}/g, '{{$1}}');
  const block = `${text.endsWith('\n') || !text ? '' : '\n'}\n### ${title}\n${vars}${method} {{host}}${url}\nAccept: application/json\n${body}`;
  const line = (text + block).split('\n').findIndex((l) => l.trim() === `### ${title}`) + 2;
  if (model) model.pushEditOperations([], [{ range: model.getFullModelRange().collapseToEnd(), text: block }], () => null);
  else await ws.backend.writeFile(path, text + block);
  return ws.openFile(path, { line, column: 1 });
}

/** Sends the request at this line (1-based) of a .http file's text, and shows its response. */
export async function runHttpAt(ws: Workspace, path: string, text: string, line: number) {
  const request = requestAt(parseHttpFile(text), line);
  if (!request) {
    ws.setStatus('No request here: a request starts with METHOD URL (or just a URL).');
    return;
  }
  ws.showBottom('http');
  await runRequest(ws.backend, path, request);
}

/** Every request of the file, one after another (a later one may use an earlier one's response). */
export async function runHttpFile(ws: Workspace, path: string, text: string) {
  const requests = parseHttpFile(text);
  if (!requests.length) return;
  ws.showBottom('http');
  for (const r of requests) await runRequest(ws.backend, path, r);
}

/** .http files: ▶ beside each request line, Ctrl+Enter sends the one at the caret. */
export function setupHttpEditor(editor: monaco.editor.IStandaloneCodeEditor, ws: () => Workspace, path: () => string) {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== 'http') return;
  const decorations = editor.createDecorationsCollection();
  const update = () =>
    decorations.set(
      parseHttpFile(model.getValue()).map((r) => ({
        range: new monaco.Range(r.line, 1, r.line, 1),
        options: { glyphMarginClassName: 'md-run-glyph http-run-glyph', glyphMarginHoverMessage: { value: `Send ${r.title} (Ctrl+Enter)` } },
      })),
    );
  update();
  let timer = 0;
  const sub = model.onDidChangeContent(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 200);
  });
  editor.addAction({
    id: 'phpblitz.http.send',
    label: 'HTTP Client: Send Request',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 0,
    run: (ed) => void runHttpAt(ws(), path(), ed.getModel()?.getValue() ?? '', ed.getPosition()?.lineNumber ?? 1),
  });
  editor.addAction({
    id: 'phpblitz.http.sendAll',
    label: 'HTTP Client: Send All Requests',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1,
    run: (ed) => void runHttpFile(ws(), path(), ed.getModel()?.getValue() ?? ''),
  });
  editor.onDidDispose(() => {
    window.clearTimeout(timer);
    sub.dispose();
  });
}

/** A click on a request's ▶: true when it was one (and it's sent). */
export function httpGlyphClick(ws: Workspace, path: string, model: monaco.editor.ITextModel, line: number): boolean {
  if (!isHttpFile(path)) return false;
  if (!parseHttpFile(model.getValue()).some((r) => r.line === line)) return false;
  void runHttpAt(ws, path, model.getValue(), line);
  return true;
}

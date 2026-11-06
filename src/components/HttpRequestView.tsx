// .http files in two views: the text, and a form (the file's requests in a list; method, URL,
// params, headers, body and settings as fields; the response below). The text stays the source:
// each change in the form is an edit of the request's lines (undo with Ctrl+Z in the text).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { confirmDialog } from '../platform';
import { copyText } from '../editorMenu';
import { parseHttpFile, requestAt, type ParsedRequest } from '../http/parse';
import { chooseEnv, chosenEnv, curlOf, environmentsFor, runRequest, useHttpClient } from '../http/client';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { appendRequest, boundaryOf, DEFAULT_BOUNDARY, draftOf, duplicateRequest, filePathFrom, formBody, formOf, header, linesOf, mimeOf, multipartBody, multipartOf, queryOf, removeRequest, setHeader, withQuery, writeRequest, type LineEdit, type RequestDraft, type Row } from '../http/edit';
import { ICON_TEXT, ModeBar, savedMode, saveMode } from './FileViews';
import { HeaderTable, languageOf, ResponseBody, sizeText, statusClass } from './HttpClientPanel';
import { Icon } from './Icon';

type OnEditor = (e: monaco.editor.IStandaloneCodeEditor) => void;
type Mode = 'form' | 'editor';
const MODE_KEY = 'phpblitz.httpMode';
const ICON_FORM = <path d="M2.5 3.5h11v2.5h-11zM2.5 8h7M2.5 10.5h11M2.5 13h9M11.5 4.75h.01" />;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
type RequestTab = 'params' | 'headers' | 'body' | 'settings';
type ResponseTab = 'body' | 'headers' | 'request';

const BODY_TYPES: { id: string; label: string; type: string | null }[] = [
  { id: 'none', label: 'None', type: null },
  { id: 'json', label: 'JSON', type: 'application/json' },
  { id: 'multipart', label: 'Multipart form', type: `multipart/form-data; boundary=${DEFAULT_BOUNDARY}` },
  { id: 'form', label: 'Form URL-encoded', type: 'application/x-www-form-urlencoded' },
  { id: 'xml', label: 'XML', type: 'application/xml' },
  { id: 'text', label: 'Text', type: 'text/plain' },
  { id: 'file', label: 'File', type: 'application/octet-stream' },
];

/** The body is one file: its path (after `<`). */
const singleFile = (body: string | null) => body?.trim().match(/^<\s+(\S[^\n]*)$/)?.[1].trim() ?? null;

function bodyKind(d: RequestDraft): string {
  const t = header(d, 'content-type').toLowerCase();
  if (t.startsWith('multipart/')) return 'multipart';
  if (singleFile(d.body) !== null || (t === 'application/octet-stream' && !d.body)) return 'file';
  if (t.includes('json')) return 'json';
  if (t.includes('x-www-form-urlencoded')) return 'form';
  if (t.includes('xml')) return 'xml';
  if (d.body === null && !t) return 'none';
  return 'text';
}

export function HttpView({ ws, path, children }: { ws: Workspace; path: string; children: (onEditor: OnEditor) => ReactNode }) {
  const [mode, setMode] = useState<Mode>(() => savedMode(MODE_KEY, ['form', 'editor'] as const, 'editor'));
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [text, setText] = useState(() => ws.liveTextOf(path) ?? ws.loaded[path] ?? '');
  const [selected, setSelected] = useState(0);

  // The form follows the text as it changes (no delay: the fields are written from it).
  useEffect(() => {
    const model = editor?.getModel();
    if (!model || mode !== 'form') return;
    setText(model.getValue());
    const sub = model.onDidChangeContent(() => setText(model.getValue()));
    return () => sub.dispose();
  }, [editor, mode]);

  const pick = (m: Mode) => {
    if (m === mode) return;
    const model = editor?.getModel();
    if (m === 'form' && editor && model) {
      // The request the caret is in.
      const rs = parseHttpFile(model.getValue());
      const at = requestAt(rs, editor.getPosition()?.lineNumber ?? 1);
      setSelected(Math.max(0, at ? rs.indexOf(at) : 0));
    }
    setMode(m);
    saveMode(MODE_KEY, m);
    if (m === 'editor' && editor && model) {
      const r = parseHttpFile(model.getValue())[selected];
      if (r) {
        editor.setPosition({ lineNumber: r.line, column: 1 });
        editor.revealLineInCenter(r.line);
      }
      requestAnimationFrame(() => editor.focus());
    }
  };

  return (
    <div className={'md-split mode-' + (mode === 'form' ? 'preview' : 'editor')}>
      <ModeBar
        label="HTTP view"
        mode={mode}
        onPick={pick}
        modes={[
          { id: 'form', label: 'Requests', icon: ICON_FORM },
          { id: 'editor', label: 'Text', icon: ICON_TEXT },
        ]}
      />
      <div className="md-editor-pane">{children(setEditor)}</div>
      {mode === 'form' && <HttpForm ws={ws} path={path} text={text} editor={editor} selected={selected} onSelect={setSelected} />}
    </div>
  );
}

function HttpForm({ ws, path, text, editor, selected, onSelect }: { ws: Workspace; path: string; text: string; editor: monaco.editor.IStandaloneCodeEditor | null; selected: number; onSelect: (i: number) => void }) {
  const lines = useMemo(() => linesOf(text), [text]);
  const requests = useMemo(() => parseHttpFile(text), [text]);
  const index = Math.min(selected, Math.max(0, requests.length - 1));
  const request: ParsedRequest | undefined = requests[index];
  const draft = useMemo(() => (request ? draftOf(lines, request) : null), [lines, request]);
  const { history, running } = useHttpClient();
  const [envs, setEnvs] = useState<string[]>([]);
  const env = chosenEnv(ws.backend.root);
  useEffect(() => {
    void environmentsFor(ws.backend, path).then((e) => setEnvs(Object.keys(e)));
  }, [ws.backend, path]);
  const [sending, setSending] = useState(false);

  /** The file's lines changed: through the editor's model, so it's an edit like any other (dirty, undo). */
  const apply = (e: LineEdit) => {
    const model = editor?.getModel();
    if (!model) return;
    const count = model.getLineCount();
    const start = Math.min(e.startLine, count + 1);
    const range =
      e.endLine < e.startLine
        ? start > count
          ? new monaco.Range(count, model.getLineMaxColumn(count), count, model.getLineMaxColumn(count))
          : new monaco.Range(start, 1, start, 1)
        : new monaco.Range(start, 1, Math.min(e.endLine, count), model.getLineMaxColumn(Math.min(e.endLine, count)));
    // Inserting after the last line: the text goes after a line break.
    const insertText = e.endLine < e.startLine && start > count ? `\n${e.text.replace(/\n$/, '')}` : e.text;
    model.pushEditOperations([], [{ range, text: insertText }], () => null);
  };
  const change = (d: RequestDraft) => request && apply(writeRequest(lines, request, d));

  const send = async () => {
    // As the file has it now (the form wrote it there).
    const model = editor?.getModel();
    const current = model ? parseHttpFile(model.getValue())[index] : request;
    if (!current || sending) return;
    setSending(true);
    try {
      await runRequest(ws.backend, path, current);
    } finally {
      setSending(false);
    }
  };

  const add = () => {
    const { edit, line } = appendRequest(lines);
    apply(edit);
    const model = editor?.getModel();
    const rs = parseHttpFile(model?.getValue() ?? '');
    const i = rs.findIndex((r) => r.start === line);
    onSelect(i >= 0 ? i : rs.length - 1);
  };

  const exchange = request ? history.find((x) => x.file === path && (x.line === request.line || x.title === request.title)) : undefined;

  return (
    <div
      className="file-view-pane hf"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          void send();
        }
      }}
    >
      <div className="hf-wrap">
        <div className="hf-list" role="listbox" aria-label="Requests">
          <div className="hf-list-head">
            <span className="muted">Requests</span>
            <span className="grow" />
            <button type="button" className="icon-btn" aria-label="New request" title="New Request" onClick={add}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {requests.map((r, i) => (
            <div
              key={`${r.start}`}
              role="option"
              aria-selected={i === index}
              className={'hf-item' + (i === index ? ' selected' : '')}
              onClick={() => onSelect(i)}
              title={`${r.method} ${r.url}`}
            >
              <span className={'hf-method m-' + r.method.toLowerCase()}>{r.method}</span>
              <span className="hf-title">{r.title}</span>
            </div>
          ))}
          {!requests.length && <div className="muted hf-none">No requests in this file yet.</div>}
          <div className="hf-list-foot">
            <label className="http-env" title="Environment: the variables of http-client.env.json (and .private.env.json) next to this file">
              <span className="muted">Env</span>
              <select aria-label="Environment" value={env && envs.includes(env) ? env : ''} onChange={(e) => chooseEnv(ws.backend.root, e.target.value || null)}>
                <option value="">{envs.length ? 'None' : 'No env file'}</option>
                {envs.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {request && draft ? (
          <div className="hf-main">
            <div className="hf-title-row">
              <Field className="hf-name" aria-label="Request title" placeholder={`${draft.method} ${draft.url}`} value={draft.title} onCommit={(title) => change({ ...draft, title })} />
              <span className="grow" />
              <button type="button" className="icon-btn" aria-label="Copy as cURL" title="Copy as cURL (variables as written)" onClick={() => void copyText(ws, curlOf({ method: draft.method, url: draft.url, headers: draft.headers.filter((h) => h.enabled).map((h) => [h.name, h.value]), body: draft.body }), 'cURL command')}>
                <Icon name="copy" size={14} />
              </button>
              <button type="button" className="icon-btn" aria-label="Duplicate request" title="Duplicate" onClick={() => (apply(duplicateRequest(lines, request)), onSelect(index + 1))}>
                <Icon name="layers" size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Delete request"
                title="Delete"
                onClick={async () => {
                  if (!(await confirmDialog(`Delete the request “${request.title}” from ${path.split('/').pop()}?`))) return;
                  apply(removeRequest(lines, requests, request));
                  onSelect(Math.max(0, index - 1));
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            <div className="hf-url-row">
              <select className={'hf-method-select m-' + draft.method.toLowerCase()} aria-label="Method" value={draft.method} onChange={(e) => change({ ...draft, method: e.target.value })}>
                {[...new Set([...METHODS, draft.method])].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <Field className="hf-url mono" aria-label="URL" placeholder="{{host}}/path" value={draft.url} onCommit={(url) => change({ ...draft, url })} />
              <button type="button" className="btn primary hf-send" disabled={sending} title="Send (Ctrl+Enter)" onClick={() => void send()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
            <RequestTabs path={path} draft={draft} change={change} onSend={send} />
            <ResponsePane ws={ws} exchange={exchange} running={running > 0 || sending} />
          </div>
        ) : (
          <div className="hf-main empty">
            <div>No request selected</div>
            <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={add}>
              New Request
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RequestTabs({ path, draft, change, onSend }: { path: string; draft: RequestDraft; change: (d: RequestDraft) => void; onSend: () => void }) {
  const [tab, setTab] = useState<RequestTab>(() => (draft.body !== null ? 'body' : 'params'));
  const params = queryOf(draft.url);
  const kind = bodyKind(draft);
  const boundary = boundaryOf(header(draft, 'content-type')) ?? DEFAULT_BOUNDARY;
  /** A file picked in the system's dialog, as the .http file writes its path. */
  const browse = async () => {
    const picked = await openDialog({ multiple: false, title: 'File to send', defaultPath: path.slice(0, path.lastIndexOf('/')) }).catch(() => null);
    return typeof picked === 'string' ? filePathFrom(path, picked) : null;
  };
  /** The whole body is this file; its Content-Type follows from its name. */
  const setFile = (p: string) => change({ ...setHeader(draft, 'Content-Type', p.trim() ? mimeOf(p.trim()) : 'application/octet-stream'), body: p.trim() ? `< ${p.trim()}` : null });
  const optionCount = [draft.options.name, draft.options.noRedirect, draft.options.noCookieJar, draft.options.noCertCheck, draft.options.timeoutMs].filter(Boolean).length;
  const counts: Record<RequestTab, number> = { params: params.length, headers: draft.headers.filter((h) => h.enabled).length, body: draft.body !== null ? 1 : 0, settings: optionCount };
  const setKind = (id: string) => {
    const t = BODY_TYPES.find((b) => b.id === id)!;
    if (id === 'multipart' || id === 'file') {
      // Starts empty: the old body isn't a form or a file.
      change({ ...setHeader(draft, 'Content-Type', t.type), body: null });
      return;
    }
    let d = setHeader(draft, 'Content-Type', t.type);
    if (t.id === 'none' || kind === 'multipart' || kind === 'file') d = { ...d, body: null };
    if (t.id === 'json' && !d.body) d = { ...d, body: '{\n}' };
    change(d);
  };
  return (
    <div className="hf-request">
      <div className="http-tabs" role="tablist">
        {(['params', 'headers', 'body', 'settings'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={'tw-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t === 'params' ? 'Params' : t === 'headers' ? 'Headers' : t === 'body' ? 'Body' : 'Settings'}
            {counts[t] > 0 && t !== 'body' && <span className="hf-count">{counts[t]}</span>}
            {t === 'body' && counts.body > 0 && <span className="hf-dot" />}
          </button>
        ))}
      </div>
      <div className="hf-request-body">
        {tab === 'params' && <RowsTable rows={params} what="parameter" onChange={(rows) => change({ ...draft, url: withQuery(draft.url, rows) })} />}
        {tab === 'headers' && <RowsTable rows={draft.headers} what="header" toggles onChange={(headers) => change({ ...draft, headers })} />}
        {tab === 'body' && (
          <div className="hf-body">
            <div className="hf-body-kinds" role="radiogroup" aria-label="Body type">
              {BODY_TYPES.map((b) => (
                <label key={b.id} className="hf-radio">
                  <input type="radio" name="hf-body-kind" checked={kind === b.id} onChange={() => setKind(b.id)} />
                  {b.label}
                </label>
              ))}
            </div>
            {kind === 'none' ? (
              <div className="muted hf-none">This request has no body.</div>
            ) : kind === 'form' ? (
              <RowsTable rows={formOf(draft.body)} what="field" onChange={(rows) => change({ ...draft, body: formBody(rows) })} />
            ) : kind === 'multipart' ? (
              <RowsTable
                rows={multipartOf(draft.body, boundary)}
                what="field"
                browse={browse}
                onChange={(rows) => change({ ...draft, body: multipartBody(rows, boundary) })}
              />
            ) : kind === 'file' ? (
              <div className="hf-file">
                <Field className="mono" aria-label="File to send" placeholder="./photo.png" value={singleFile(draft.body) ?? ''} onCommit={(p) => setFile(p)} />
                <button type="button" className="btn small" onClick={async () => { const p = await browse(); if (p) setFile(p); }}>
                  Browse…
                </button>
                <div className="muted hf-file-note">
                  Sent as the whole body, its bytes as they are{header(draft, 'content-type') ? `, as ${header(draft, 'content-type')}` : ''}. A path relative to this file’s folder, or a full one.
                </div>
              </div>
            ) : (
              <BodyEditor value={draft.body ?? ''} language={languageOf(header(draft, 'content-type'), draft.body ?? '')} onChange={(body) => change({ ...draft, body })} onSend={onSend} />
            )}
          </div>
        )}
        {tab === 'settings' && <Settings draft={draft} change={change} />}
      </div>
    </div>
  );
}

function Settings({ draft, change }: { draft: RequestDraft; change: (d: RequestDraft) => void }) {
  const o = draft.options;
  const set = (patch: Partial<RequestDraft['options']>) => change({ ...draft, options: { ...o, ...patch } });
  return (
    <div className="hf-settings">
      <label className="hf-setting">
        <span>Name</span>
        <Field className="mono" aria-label="Name" placeholder="login" value={o.name ?? ''} onCommit={(v) => set({ name: v.trim() || undefined })} />
        <span className="muted">Later requests use its response: {`{{${o.name || 'name'}.response.body.token}}`}</span>
      </label>
      <label className="hf-setting">
        <span>Timeout</span>
        <Field
          className="mono hf-short"
          aria-label="Timeout in seconds"
          placeholder="default"
          value={o.timeoutMs ? String(o.timeoutMs / 1000) : ''}
          onCommit={(v) => {
            const n = parseFloat(v);
            set({ timeoutMs: n > 0 ? Math.round(n * 1000) : undefined });
          }}
        />
        <span className="muted">seconds</span>
      </label>
      <label className="hf-check">
        <input type="checkbox" checked={!o.noRedirect} onChange={(e) => set({ noRedirect: !e.target.checked || undefined })} /> Follow redirects
      </label>
      <label className="hf-check">
        <input type="checkbox" checked={!o.noCookieJar} onChange={(e) => set({ noCookieJar: !e.target.checked || undefined })} /> Send and keep cookies
      </label>
      <label className="hf-check">
        <input type="checkbox" checked={!o.noCertCheck} onChange={(e) => set({ noCertCheck: !e.target.checked || undefined })} /> Check the server’s certificate
      </label>
    </div>
  );
}

/** Key / value rows (query, headers, form fields); a last empty row adds one. */
function RowsTable({ rows, what, toggles, browse, onChange }: { rows: Row[]; what: string; toggles?: boolean; browse?: () => Promise<string | null>; onChange: (rows: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <table className="hf-rows">
      <thead>
        <tr>
          {toggles && <th className="hf-toggle" />}
          <th>Key</th>
          {browse && <th className="hf-kind">Type</th>}
          <th>Value</th>
          <th className="hf-del" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.enabled ? '' : 'off'}>
            {toggles && (
              <td className="hf-toggle">
                <input type="checkbox" aria-label={`Send ${r.name}`} checked={r.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} />
              </td>
            )}
            <td>
              <Field className="mono" aria-label={`${what} name`} value={r.name} onCommit={(name) => (name ? set(i, { name }) : onChange(rows.filter((_, k) => k !== i)))} />
            </td>
            {browse && (
              <td className="hf-kind">
                <select aria-label={`${r.name} type`} value={r.file ? 'file' : 'text'} onChange={(e) => set(i, { file: e.target.value === 'file', value: '' })}>
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
              </td>
            )}
            <td>
              <div className="hf-value">
                <Field className="mono" aria-label={`${what} value`} placeholder={r.file ? './photo.png' : undefined} value={r.value} onCommit={(value) => set(i, { value })} />
                {browse && r.file && (
                  <button
                    type="button"
                    className="btn small"
                    title="Choose the file"
                    onClick={async () => {
                      const p = await browse();
                      if (p) set(i, { value: p });
                    }}
                  >
                    Browse…
                  </button>
                )}
              </div>
            </td>
            <td className="hf-del">
              <button type="button" className="icon-btn" aria-label={`Remove ${what} ${r.name}`} title="Remove" onClick={() => onChange(rows.filter((_, k) => k !== i))}>
                <Icon name="close" size={12} />
              </button>
            </td>
          </tr>
        ))}
        <tr key={rows.length} className="hf-new">
          {toggles && <td className="hf-toggle" />}
          <td>
            <Field className="mono" aria-label={`New ${what} name`} placeholder={`Add ${what}`} value="" onCommit={(name) => name && onChange([...rows, { name, value: '', enabled: true }])} />
          </td>
          {browse && <td className="hf-kind" />}
          <td>
            <input className="hf-input mono" aria-label={`New ${what} value`} disabled placeholder="Value" />
          </td>
          <td className="hf-del" />
        </tr>
      </tbody>
    </table>
  );
}

/**
 * An input that writes each change through `onCommit`, but shows what's typed while it has the focus:
 * the value read back from the file is trimmed ("Bearer " comes back "Bearer").
 */
function Field({ value, onCommit, className, ...props }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string; 'aria-label': string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...props}
      className={'hf-input ' + (className ?? '')}
      spellCheck={false}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
    />
  );
}

/** The body in a small editor of its own (syntax colors, Ctrl+Enter sends). */
function BodyEditor({ value, language, onChange, onSend }: { value: string; language: string; onChange: (v: string) => void; onSend: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({ onChange, onSend });
  latest.current = { onChange, onSend };
  /** Set while the value is put in from outside: not a change to write back. */
  const quiet = useRef(false);
  useEffect(() => {
    if (!host.current) return;
    const model = monaco.editor.createModel(value, language);
    const editor = monaco.editor.create(host.current, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      folding: true,
      wordWrap: 'on',
      renderLineHighlight: 'none',
      fontSize: 12.5,
      glyphMargin: false,
    });
    ed.current = editor;
    const sub = model.onDidChangeContent(() => {
      if (!quiet.current) latest.current.onChange(model.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => latest.current.onSend());
    return () => {
      sub.dispose();
      editor.dispose();
      model.dispose();
      ed.current = null;
    };
    // The editor is made once; value and language follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const editor = ed.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);
    // Changed elsewhere (the text view, the body type): shown, unless it's being typed here.
    if (!editor.hasTextFocus() && model.getValue() !== value) {
      quiet.current = true;
      model.setValue(value);
      quiet.current = false;
    }
  }, [value, language]);
  return <div ref={host} className="hf-body-editor" />;
}

function ResponsePane({ ws, exchange, running }: { ws: Workspace; exchange: ReturnType<typeof useHttpClient>['history'][number] | undefined; running: boolean }) {
  const [tab, setTab] = useState<ResponseTab>('body');
  if (!exchange) {
    return (
      <div className="hf-response empty">
        {running ? 'Sending…' : 'Send the request to see its response here (Ctrl+Enter).'}
      </div>
    );
  }
  const r = exchange.response;
  return (
    <div className="hf-response">
      <div className="http-summary">
        <span className="muted">Response</span>
        {r ? (
          <>
            <span className={'http-status big ' + statusClass(r.status)}>
              {r.status} {r.statusText}
            </span>
            <span className="muted">
              {r.timeMs} ms · {sizeText(r.size)}
              {exchange.env ? ` · ${exchange.env}` : ''} · {new Date(exchange.at).toLocaleTimeString()}
            </span>
          </>
        ) : (
          <span className="http-status big error">Not sent</span>
        )}
        <span className="grow" />
        {running && <span className="muted">Sending…</span>}
        <button type="button" className="btn small ghost" onClick={() => void copyText(ws, curlOf(exchange.request), 'cURL command')}>
          Copy as cURL
        </button>
      </div>
      {exchange.error && <div className="te-error http-error">{exchange.error}</div>}
      <div className="http-tabs" role="tablist">
        {(['body', 'headers', 'request'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={'tw-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t === 'body' ? 'Body' : t === 'headers' ? `Headers${r ? ` (${r.headers.length})` : ''}` : 'Sent'}
          </button>
        ))}
      </div>
      <div className="http-tab-body">
        {tab === 'body' && r && <ResponseBody key={exchange.id} exchange={exchange} />}
        {tab === 'headers' && r && <HeaderTable headers={r.headers} />}
        {tab === 'request' && (
          <>
            <div className="mono http-request-line">
              {exchange.request.method} {exchange.request.url}
            </div>
            <HeaderTable headers={exchange.request.headers} />
            {exchange.request.body !== null && <pre className="mono hf-sent-body">{exchange.request.body}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

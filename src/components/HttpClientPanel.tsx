// HTTP Client tool window: the requests sent from .http files, newest first; the selected one's
// response (body pretty-printed, headers) and the request as it went (variables filled in).

import { useEffect, useMemo, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { copyText } from '../editorMenu';
import { chooseEnv, chosenEnv, clearCookies, clearHistory, curlOf, environmentsFor, selectExchange, useHttpClient, type HttpExchange } from '../http/client';
import { ensureScratch, isHttpFile, runHttpAt, SCRATCH } from '../http/run';
import { HideToolButton, useHideTool } from './toolHide';
import { Icon } from './Icon';
import { CodeView } from './CodeView';

type Tab = 'body' | 'headers' | 'request';

export const header = (headers: [string, string][], name: string) => headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? '';
export const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
export const statusClass = (s: number) => (s < 300 ? 'ok' : s < 400 ? 'redirect' : 'error');

export function HttpClientPanel({ ws }: { ws: Workspace }) {
  const hide = useHideTool(() => ws.setBottomOpen(false));
  const { history, selected, running } = useHttpClient();
  const current = history.find((x) => x.id === selected) ?? history[0] ?? null;
  const [tab, setTab] = useState<Tab>('body');
  const [envs, setEnvs] = useState<string[]>([]);
  const env = chosenEnv(ws.backend.root);
  // The environments of the open .http file (its folder's env files), else the project's.
  const envFile = ws.activePath && isHttpFile(ws.activePath) ? ws.activePath : `${ws.backend.root}/${SCRATCH}`;
  useEffect(() => {
    void environmentsFor(ws.backend, envFile).then((e) => setEnvs(Object.keys(e)));
  }, [ws.backend, envFile, history.length]);

  const openScratch = async () => void ws.openFile(await ensureScratch(ws));

  const rerun = async (x: HttpExchange) => {
    const text = ws.liveTextOf(x.file) ?? (await ws.backend.readFile(x.file).catch(() => null));
    if (text !== null) void runHttpAt(ws, x.file, text, x.line);
  };

  return (
    <>
      <div className="tw-head">
        <span className="tw-title">HTTP Client</span>
        <span className="grow" />
        {running > 0 && <span className="muted http-running">Sending…</span>}
        <label className="http-env" title="Environment: the variables of http-client.env.json (and .private.env.json) next to the .http file">
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
        <button type="button" className="icon-btn" aria-label="New request" title="Open the requests scratch file (.blitz/http)" onClick={() => void openScratch()}>
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Clear cookies"
          title="Clear Cookies (servers' Set-Cookie, sent back on later requests)"
          onClick={() => (clearCookies(), ws.setStatus('Cookies cleared'))}
        >
          <Icon name="close" size={13} />
        </button>
        <button type="button" className="icon-btn" aria-label="Clear history" title="Clear History" disabled={!history.length} onClick={clearHistory}>
          <Icon name="trash" size={14} />
        </button>
        <HideToolButton onHide={hide} />
      </div>
      {!history.length ? (
        <div className="empty http-empty">
          No requests sent yet
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Open a <code>.http</code> file and press Ctrl+Enter on a request (or click its ▶).
          </div>
          <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={() => void openScratch()}>
            New Request File
          </button>
        </div>
      ) : (
        <div className="http-wrap">
          <div className="http-panel">
            <div className="http-history" role="listbox" aria-label="Requests sent">
              {history.map((x) => {
                let path = x.request.url;
                try {
                  const u = new URL(x.request.url);
                  path = u.pathname + u.search;
                } catch {
                  // As written.
                }
                return (
                  <div
                    key={x.id}
                    role="option"
                    aria-selected={current?.id === x.id}
                    className={'http-row' + (current?.id === x.id ? ' selected' : '')}
                    onClick={() => selectExchange(x.id)}
                    onDoubleClick={() => void ws.openFile(x.file, { line: x.line, column: 1 })}
                    title={`${x.title}\n${x.request.method} ${x.request.url}\n${new Date(x.at).toLocaleTimeString()} · ${baseName(x.file)}:${x.line}\nDouble-click to go to the request`}
                  >
                    <span className={'http-status ' + (x.response ? statusClass(x.response.status) : 'error')}>{x.response ? x.response.status : '✕'}</span>
                    <span className="http-method">{x.request.method}</span>
                    <span className="http-path">{path}</span>
                    <span className="muted http-time">{x.response ? `${x.response.timeMs} ms` : ''}</span>
                  </div>
                );
              })}
            </div>
            {current && (
              <div className="http-details">
                <div className="http-summary">
                  {current.response ? (
                    <>
                      <span className={'http-status big ' + statusClass(current.response.status)}>
                        {current.response.status} {current.response.statusText}
                      </span>
                      <span className="muted">
                        {current.response.timeMs} ms · {sizeText(current.response.size)}
                        {current.env ? ` · ${current.env}` : ''}
                      </span>
                    </>
                  ) : (
                    <span className="http-status big error">Not sent</span>
                  )}
                  <span className="grow" />
                  <button type="button" className="btn small ghost" title="Send it again (as the file has it now)" onClick={() => void rerun(current)}>
                    <Icon name="run" size={12} /> Send Again
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => void copyText(ws, curlOf(current.request), 'cURL command')}>
                    Copy as cURL
                  </button>
                  <button type="button" className="btn small ghost" title={relativePath(ws.backend, current.file)} onClick={() => void ws.openFile(current.file, { line: current.line, column: 1 })}>
                    <Icon name="goTo" size={12} /> {baseName(current.file)}:{current.line}
                  </button>
                </div>
                {current.error && <div className="te-error http-error">{current.error}</div>}
                <div className="http-tabs" role="tablist">
                  {(['body', 'headers', 'request'] as const).map((t) => (
                    <button key={t} type="button" role="tab" aria-selected={tab === t} className={'tw-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
                      {t === 'body' ? 'Response' : t === 'headers' ? `Headers${current.response ? ` (${current.response.headers.length})` : ''}` : 'Request'}
                    </button>
                  ))}
                </div>
                <div className="http-tab-body">
                  {tab === 'body' && current.response && <ResponseBody key={current.id} exchange={current} />}
                  {tab === 'headers' && current.response && <HeaderTable headers={current.response.headers} />}
                  {tab === 'request' && (
                    <>
                      <div className="mono http-request-line">
                        {current.request.method} {current.request.url}
                      </div>
                      <HeaderTable headers={current.request.headers} />
                      {current.request.body !== null && <CodeView text={current.request.body} language={languageOf(header(current.request.headers, 'content-type'), current.request.body)} />}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function HeaderTable({ headers }: { headers: [string, string][] }) {
  if (!headers.length) return <div className="muted gl-pad">No headers.</div>;
  return (
    <table className="http-headers">
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}>
            <td className="mono http-header-name">{k}</td>
            <td className="mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The editor language for a body: from its content type, else from how it looks. */
export function languageOf(contentType: string, body: string): string {
  const t = contentType.toLowerCase();
  if (t.includes('json')) return 'json';
  if (t.includes('html')) return 'html';
  if (t.includes('xml')) return 'xml';
  if (t.includes('javascript')) return 'javascript';
  if (t.includes('css')) return 'css';
  const s = body.trimStart();
  if (s.startsWith('{') || s.startsWith('[')) return 'json';
  if (s.startsWith('<')) return 'html';
  return 'plaintext';
}

export function ResponseBody({ exchange }: { exchange: HttpExchange }) {
  const r = exchange.response!;
  const type = header(r.headers, 'content-type');
  const [preview, setPreview] = useState(false);
  const language = languageOf(type, r.binary ? '' : r.body);
  const text = useMemo(() => {
    if (r.binary || language !== 'json') return r.body;
    try {
      return JSON.stringify(JSON.parse(r.body), null, 2);
    } catch {
      return r.body;
    }
  }, [r, language]);
  if (r.binary) {
    if (type.startsWith('image/') && r.body) return <img className="http-image" alt="Response" src={`data:${type.split(';')[0]};base64,${r.body}`} />;
    return <div className="muted gl-pad">{`Binary response (${type || 'no content type'}, ${sizeText(r.size)}).`}</div>;
  }
  if (!r.body) return <div className="muted gl-pad">Empty body.</div>;
  return (
    <div className="http-body">
      {(language === 'html' || r.truncated) && (
        <div className="http-body-bar">
          {r.truncated && (
            <span className="muted">
              Showing the first {sizeText(r.body.length)} of {sizeText(r.size)}.
            </span>
          )}
          {language === 'html' && (
            <button type="button" className={'btn small ghost' + (preview ? ' on' : '')} onClick={() => setPreview((p) => !p)}>
              {preview ? 'Source' : 'Preview'}
            </button>
          )}
        </div>
      )}
      {/* The page as a picture of it: no scripts, no forms, nothing it links to loads in here. */}
      {preview ? <iframe className="http-preview" title="Response preview" sandbox="" srcDoc={r.body} /> : <CodeView text={text} language={language} />}
    </div>
  );
}

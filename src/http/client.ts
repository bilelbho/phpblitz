// Running .http requests: variables filled in (http/variables.ts), files included in bodies, a
// cookie jar per host, then sent by the Rust side (http.rs). Every exchange goes into the HTTP
// Client tool window's history; a named one's response is there for later requests.

import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import type { Backend } from '../backend/types';
import { isTauri } from '../platform';
import { readCache, writeCache } from '../blitzCache';
import type { ParsedRequest } from './parse';
import { boundaryOf, multipartOf } from './edit';
import { parseEnvironments, resolveVariables, type NamedResponse } from './variables';

export interface SentRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  url: string;
  headers: [string, string][];
  body: string;
  binary: boolean;
  truncated: boolean;
  size: number;
  timeMs: number;
}

export interface HttpExchange {
  id: number;
  /** ISO 8601. */
  at: string;
  /** The .http file and the request's line in it. */
  file: string;
  line: number;
  title: string;
  env: string | null;
  request: SentRequest;
  response?: HttpResponse;
  error?: string;
}

const ENV_FILE = 'http-client.env.json';
const PRIVATE_ENV_FILE = 'http-client.private.env.json';
const MAX_HISTORY = 100;

const listeners = new Set<() => void>();
let state: { history: HttpExchange[]; selected: number | null; running: number } = { history: [], selected: null, running: 0 };
const named = new Map<string, NamedResponse>();
/** Cookies by host, as Set-Cookie gave them (name → value). */
const cookies = new Map<string, Map<string, string>>();
let nextId = 1;

function update(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useHttpClient() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function selectExchange(id: number | null) {
  update({ selected: id });
}

export function clearHistory() {
  update({ history: [], selected: null });
  persist();
}

// ── Kept between sessions ─────────────────────────────────────
// The history, the named responses and the cookies, in the project's .blitz/cache/http-client.json
// (git-ignored, readable by this user only: it holds tokens and cookies).

/** A response body kept bigger than this is cut (a binary one is dropped). */
const KEEP_BODY = 256 * 1024;

interface Kept {
  version: 1;
  history: HttpExchange[];
  named: [string, NamedResponse][];
  cookies: [string, [string, string][]][];
}

let project: Backend | null = null;
let saveTimer = 0;

function persist() {
  const backend = project;
  if (!backend) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const kept: Kept = {
      version: 1,
      history: state.history.map(keepable),
      named: [...named].map(([k, v]) => [k, { ...v, body: v.body.length > KEEP_BODY ? v.body.slice(0, KEEP_BODY) : v.body }]),
      cookies: [...cookies].map(([host, jar]) => [host, [...jar]]),
    };
    void writeCache(backend, 'http-client.json', kept);
  }, 500);
}

function keepable(x: HttpExchange): HttpExchange {
  const r = x.response;
  if (!r || r.body.length <= KEEP_BODY) return x;
  return { ...x, response: { ...r, body: r.binary ? '' : r.body.slice(0, KEEP_BODY), truncated: true } };
}

/** The project's HTTP Client as it was last time (or empty); null: no project. */
export async function openHttpClient(backend: Backend | null) {
  window.clearTimeout(saveTimer);
  project = backend;
  named.clear();
  cookies.clear();
  update({ history: [], selected: null });
  if (!backend) return;
  const kept = await readCache<Kept>(backend, 'http-client.json');
  // Another project opened meanwhile, or nothing kept.
  if (project !== backend || kept?.version !== 1) return;
  for (const [k, v] of kept.named ?? []) named.set(k, v);
  for (const [host, jar] of kept.cookies ?? []) cookies.set(host, new Map(jar));
  const history = (kept.history ?? []).filter((x) => x && typeof x.id === 'number').slice(0, MAX_HISTORY);
  nextId = Math.max(nextId, ...history.map((x) => x.id + 1));
  update({ history, selected: history[0]?.id ?? null });
}

// ── Environments ──────────────────────────────────────────────

const envKey = (root: string) => `phpblitz.httpEnv:${root}`;

/** The environment chosen for the project's requests (null: none). */
export function chosenEnv(root: string): string | null {
  try {
    return localStorage.getItem(envKey(root));
  } catch {
    return null;
  }
}

export function chooseEnv(root: string, env: string | null) {
  try {
    if (env) localStorage.setItem(envKey(root), env);
    else localStorage.removeItem(envKey(root));
  } catch {
    // Only a preference.
  }
  // A new state object, so the windows showing the choice draw again.
  update({});
}

/** The env files next to the .http file, else the project's: environments by name. */
export async function environmentsFor(backend: Backend, file: string): Promise<Record<string, Record<string, string>>> {
  const read = (p: string) =>
    backend.readFile(p).then(
      (t) => t,
      () => null,
    );
  for (const dir of [file.slice(0, file.lastIndexOf('/')), backend.root]) {
    const [pub, priv] = await Promise.all([read(`${dir}/${ENV_FILE}`), read(`${dir}/${PRIVATE_ENV_FILE}`)]);
    if (pub !== null || priv !== null) return parseEnvironments(pub, priv);
  }
  return {};
}

// ── Running ───────────────────────────────────────────────────

/** Sends one request of a .http file; the exchange goes into the history (and is returned). */
export async function runRequest(backend: Backend, file: string, request: ParsedRequest): Promise<HttpExchange> {
  const envs = await environmentsFor(backend, file);
  const names = Object.keys(envs);
  const chosen = chosenEnv(backend.root);
  const env = chosen && chosen in envs ? chosen : names.length === 1 ? names[0] : null;
  const scope = { file: request.variables, env: env ? envs[env] : {}, responses: named };
  const missing = new Set<string>();
  const fill = (s: string) => {
    const r = resolveVariables(s, scope);
    r.missing.forEach((m) => missing.add(m));
    return r.text;
  };
  const url = fill(request.url);
  const headers = request.headers.map(([k, v]) => [fill(k), fill(v)] as [string, string]);
  const dir = file.slice(0, file.lastIndexOf('/'));
  let body: string | null = null;
  let bodyBase64: string | undefined;
  const contentType = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (request.body !== null && /^multipart\//i.test(contentType)) {
    // Parts may be files of any kind: put together as bytes, line breaks as CRLF.
    const parts = await multipartBytes(backend, dir, request.body, fill);
    bodyBase64 = parts.base64;
    body = parts.shown;
  } else if (request.body !== null) {
    const included = await includeFiles(backend, dir, request.body);
    if (included.base64 !== undefined) bodyBase64 = included.base64;
    else body = fill(included.text);
  }

  const exchange: HttpExchange = {
    id: nextId++,
    at: new Date().toISOString(),
    file,
    line: request.line,
    title: request.title,
    env,
    request: { method: request.method, url, headers, body: bodyBase64 !== undefined ? (body ?? '(file)') : body },
  };
  if (missing.size) {
    const where = names.length ? (env ? ` (environment ${env})` : ' (no environment chosen)') : '';
    exchange.error = `No value for ${[...missing].map((m) => `{{${m}}}`).join(', ')}${where}.`;
    return record(exchange);
  }
  if (!/^https?:\/\//i.test(url)) {
    exchange.error = `Not an http(s) URL: ${url}`;
    return record(exchange);
  }
  if (!isTauri) {
    exchange.error = 'Requests are sent by the desktop app.';
    return record(exchange);
  }
  // Cookies the server set before, unless the request has a Cookie header or says not to.
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    // Checked above; a URL the browser can't parse fails in Rust with its reason.
  }
  const jar = cookies.get(host);
  if (!request.options.noCookieJar && jar?.size && !headers.some(([k]) => k.toLowerCase() === 'cookie')) {
    headers.push(['Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; ')]);
  }
  update({ running: state.running + 1 });
  try {
    const response = await invoke<HttpResponse>('http_send', {
      request: { method: request.method, url, headers, body: bodyBase64 !== undefined ? null : body, bodyBase64, timeoutMs: request.options.timeoutMs, followRedirects: !request.options.noRedirect, insecure: !!request.options.noCertCheck },
    });
    exchange.response = response;
    if (!request.options.noCookieJar) keepCookies(host, response.headers);
    if (request.options.name) named.set(request.options.name, { status: response.status, headers: response.headers, body: response.binary ? '' : response.body });
  } catch (e) {
    exchange.error = String(e instanceof Error ? e.message : e);
  } finally {
    update({ running: state.running - 1 });
  }
  return record(exchange);
}

function record(exchange: HttpExchange): HttpExchange {
  update({ history: [exchange, ...state.history].slice(0, MAX_HISTORY), selected: exchange.id });
  persist();
  return exchange;
}

function keepCookies(host: string, headers: [string, string][]) {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const [pair, ...attrs] = v.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const jar = cookies.get(host) ?? new Map<string, string>();
    // Max-Age=0 or an expiry in the past: the server removes it.
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now()));
    if (expired) jar.delete(name);
    else jar.set(name, value);
    cookies.set(host, jar);
  }
}

/** Forgets the cookies servers set (Clear Cookies in the tool window). */
export function clearCookies() {
  cookies.clear();
  persist();
}

/**
 * `< ./file` lines in a body: the file's text in their place. A body that's only one such line of
 * a file that isn't text (an image…) is sent as its bytes.
 */
async function includeFiles(backend: Backend, dir: string, body: string): Promise<{ text: string; base64?: string }> {
  const lines = body.split('\n');
  const resolvePath = (p: string) => resolveFile(dir, p);
  const only = lines.length === 1 && lines[0].match(/^<\s+(\S.*)$/);
  if (only && !/\.(json|xml|txt|html?|csv|graphql|ya?ml|md)$/i.test(only[1].trim())) {
    return { text: '', base64: base64Of(new Uint8Array(await backend.readBinary(resolvePath(only[1])))) };
  }
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^<\s+(\S.*)$/);
    out.push(m ? (await backend.readFile(resolvePath(m[1]))).replace(/\r\n/g, '\n').replace(/\n$/, '') : line);
  }
  return { text: out.join('\n') };
}

/** A path after `<`: absolute, or relative to the .http file's folder. */
const resolveFile = (dir: string, p: string) => {
  const path = p.trim().replace(/\\/g, '/');
  return /^([a-zA-Z]:)?\//.test(path) ? path : `${dir}/${path.replace(/^\.\//, '')}`;
};

function base64Of(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A multipart body as the bytes to send: its lines (variables filled in) joined with CRLF, each
 * `< ./file` line replaced by the file's bytes. `shown`: the body as the history shows it.
 */
export async function multipartBytes(backend: Pick<Backend, 'readBinary'>, dir: string, body: string, fill: (s: string) => string): Promise<{ base64: string; shown: string }> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const shown: string[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^<\s+(\S.*)$/);
    if (m) {
      const bytes = new Uint8Array(await backend.readBinary(resolveFile(dir, fill(m[1]))));
      chunks.push(bytes);
      shown.push(lines[i]);
    } else {
      const text = fill(lines[i]);
      chunks.push(enc.encode(text));
      shown.push(text);
    }
    if (i < lines.length - 1) chunks.push(enc.encode('\r\n'));
  }
  // The closing boundary ends with a line break.
  chunks.push(enc.encode('\r\n'));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { base64: base64Of(all), shown: shown.join('\n') };
}

/** The request as a cURL command line (Copy as cURL). */
export function curlOf(r: SentRequest): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = ['curl'];
  if (r.method !== 'GET') parts.push('-X', r.method);
  parts.push(q(r.url));
  const type = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const boundary = /^multipart\//i.test(type) ? boundaryOf(type) : null;
  // Multipart: each part a -F (curl makes its own boundary and Content-Type).
  for (const [k, v] of r.headers) if (!(boundary && k.toLowerCase() === 'content-type')) parts.push('-H', q(`${k}: ${v}`));
  if (boundary && r.body !== null) for (const p of multipartOf(r.body, boundary)) parts.push('-F', q(`${p.name}=${p.file ? `@${p.value}` : p.value}`));
  else if (r.body !== null && r.body !== '(file)') parts.push('--data-raw', q(r.body));
  return parts.join(' ');
}

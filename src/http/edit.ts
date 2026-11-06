// The request form of a .http file: a request read into fields (headers with the commented-out
// ones as disabled), and each change written back as a change of its lines, so the text stays the
// source and what's around a request (comments, variables, response handlers) is kept.

import type { HttpOptions, ParsedRequest } from './parse';

export interface Row {
  name: string;
  /** For a file (multipart): its path, as written after `<`. */
  value: string;
  enabled: boolean;
  /** Multipart: the value is a file to send. */
  file?: boolean;
}

export interface RequestDraft {
  /** After ###; '' for none. */
  title: string;
  method: string;
  url: string;
  headers: Row[];
  /** null: no body. */
  body: string | null;
  options: HttpOptions;
}

/** A change of the file: these lines (1-based, inclusive) become `text`. endLine < startLine inserts before startLine. */
export interface LineEdit {
  startLine: number;
  endLine: number;
  text: string;
}

export const linesOf = (text: string) => text.replace(/\r\n/g, '\n').split('\n');

const DISABLED_HEADER = /^\s*(#|\/\/)\s*([\w-]+)\s*:\s?(.*)$/;
const OPTION = /^\s*(#|\/\/)\s*@(name|no-redirect|no-cookie-jar|no-cert-check|timeout)\b/;
const HANDLER = /^\s*(<>|>)\s/;

const hasTitleLine = (lines: string[], r: ParsedRequest) => lines[r.start - 1]?.startsWith('###') ?? false;

/** Line numbers (1-based) of the request's header lines (after the request line and its query lines, up to the blank line). */
function headerLines(lines: string[], r: ParsedRequest): number[] {
  let n = r.line + 1;
  while (n <= lines.length && /^\s+[?&]/.test(lines[n - 1])) n++;
  const out: number[] = [];
  for (; n <= r.endLine && lines[n - 1].trim(); n++) out.push(n);
  return out;
}

/** The request as the form shows it. */
export function draftOf(lines: string[], r: ParsedRequest): RequestDraft {
  const headers: Row[] = [];
  for (const n of headerLines(lines, r)) {
    const line = lines[n - 1];
    const off = line.match(DISABLED_HEADER);
    if (off) {
      if (!line.match(OPTION)) headers.push({ name: off[2], value: off[3].trim(), enabled: false });
      continue;
    }
    if (/^\s*(#|\/\/)/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon > 0) headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim(), enabled: true });
  }
  return {
    title: hasTitleLine(lines, r) ? lines[r.start - 1].slice(3).trim() : '',
    method: r.method,
    url: r.url,
    headers,
    body: r.body,
    options: { ...r.options },
  };
}

/** Each option the draft sets, as its comment line. */
function optionLines(o: HttpOptions): Map<string, string> {
  const out = new Map<string, string>();
  if (o.name) out.set('name', `# @name ${o.name}`);
  if (o.noRedirect) out.set('no-redirect', '# @no-redirect');
  if (o.noCookieJar) out.set('no-cookie-jar', '# @no-cookie-jar');
  if (o.noCertCheck) out.set('no-cert-check', '# @no-cert-check');
  if (o.timeoutMs) out.set('timeout', `# @timeout ${o.timeoutMs % 1000 ? `${o.timeoutMs} ms` : o.timeoutMs / 1000}`);
  return out;
}

/** The request's lines rewritten from the form: its ### line to its last line. */
export function writeRequest(lines: string[], r: ParsedRequest, d: RequestDraft): LineEdit {
  const titled = hasTitleLine(lines, r);
  const out: string[] = [];
  if (titled || d.title.trim()) out.push(d.title.trim() ? `### ${d.title.trim()}` : '###');
  // Comments and variables before the request line stay; the options are the form's, each where it was.
  const options = optionLines(d.options);
  const prelude: string[] = [];
  for (const l of lines.slice(titled ? r.start : r.start - 1, r.line - 1)) {
    const key = l.match(OPTION)?.[2];
    if (!key) prelude.push(l);
    else if (options.has(key)) {
      prelude.push(options.get(key)!);
      options.delete(key);
    }
  }
  while (prelude.length && !prelude[prelude.length - 1].trim()) prelude.pop();
  out.push(...prelude, ...options.values());
  out.push(`${d.method} ${d.url.trim()}`);
  // Comments between the headers (not headers turned off) stay, first.
  const hl = headerLines(lines, r);
  out.push(...hl.map((n) => lines[n - 1]).filter((l) => /^\s*(#|\/\/)/.test(l) && !DISABLED_HEADER.test(l)));
  for (const h of d.headers) if (h.name.trim()) out.push(`${h.enabled ? '' : '# '}${h.name.trim()}: ${h.value}`);
  if (d.body !== null && d.body !== '') out.push('', ...linesOf(d.body));
  // Response handlers at the end stay.
  const afterHeaders = (hl.length ? hl[hl.length - 1] : r.line) + 1;
  const tail: string[] = [];
  for (let n = r.endLine; n > afterHeaders && (HANDLER.test(lines[n - 1]) || !lines[n - 1].trim()); n--) if (lines[n - 1].trim()) tail.unshift(lines[n - 1]);
  if (tail.length) out.push('', ...tail);
  return { startLine: r.start, endLine: r.endLine, text: out.join('\n') };
}

/** A new request at the end of the file; its edit and the line its ### will be on. */
export function appendRequest(lines: string[], title = 'New Request', url = '{{host}}/'): { edit: LineEdit; line: number } {
  let last = lines.length;
  while (last > 0 && !lines[last - 1].trim()) last--;
  const block = [...(last ? [''] : []), `### ${title}`, `GET ${url}`];
  return { edit: { startLine: last + 1, endLine: lines.length, text: block.join('\n') + '\n' }, line: last + (last ? 2 : 1) };
}

/** Removes the request, up to the next one; file variables before it stay. */
export function removeRequest(lines: string[], requests: ParsedRequest[], r: ParsedRequest): LineEdit {
  const next = requests.find((x) => x.start > r.start);
  const end = next ? next.start - 1 : lines.length;
  const keep = lines.slice(r.start - 1, r.line - 1).filter((l) => /^@[\w.-]+\s*=/.test(l));
  return { startLine: r.start, endLine: end, text: keep.length ? keep.join('\n') + '\n' : '' };
}

/** A copy of the request right after it (without its @name: names are unique). */
export function duplicateRequest(lines: string[], r: ParsedRequest): LineEdit {
  const d = draftOf(lines, r);
  const copy = writeRequest(lines, r, { ...d, title: `${d.title || `${d.method} ${d.url}`} (copy)`, options: { ...d.options, name: undefined } });
  return { startLine: r.endLine + 1, endLine: r.endLine, text: `\n${copy.text}\n` };
}

// ── Query parameters ──────────────────────────────────────────

/** The URL's query as rows (as written: variables and escapes left alone). */
export function queryOf(url: string): Row[] {
  const q = url.indexOf('?');
  if (q < 0) return [];
  return url
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return { name: eq < 0 ? part : part.slice(0, eq), value: eq < 0 ? '' : part.slice(eq + 1), enabled: true };
    });
}

/** The URL with this query. */
export function withQuery(url: string, rows: Row[]): string {
  const q = url.indexOf('?');
  const base = q < 0 ? url : url.slice(0, q);
  const query = rows
    .filter((r) => r.name)
    .map((r) => (r.value === '' ? r.name : `${r.name}=${r.value}`))
    .join('&');
  return base + (query ? `?${query}` : '');
}

// ── Bodies ────────────────────────────────────────────────────

/** A form-urlencoded body as rows. */
export const formOf = (body: string | null): Row[] => queryOf(`?${(body ?? '').replace(/\s*\n\s*/g, '')}`);
export const formBody = (rows: Row[]) => withQuery('', rows).slice(1);

// Multipart (form-data): parts between --boundary lines, each with its Content-Disposition (name,
// filename for a file), a blank line, then its value; a file part's value is `< ./path`.

export const DEFAULT_BOUNDARY = 'boundary';

/** The boundary a multipart Content-Type names. */
export const boundaryOf = (contentType: string) => contentType.match(/boundary=("?)([^";]+)\1/i)?.[2] ?? null;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const mimeOf = (path: string) => MIME[path.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

/** A multipart body's parts as rows. */
export function multipartOf(body: string | null, boundary: string): Row[] {
  const rows: Row[] = [];
  for (const part of (body ?? '').replace(/\r\n/g, '\n').split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*$`, 'm'))) {
    const blank = part.indexOf('\n\n');
    if (blank < 0) continue;
    const head = part.slice(0, blank);
    const name = head.match(/name="([^"]*)"/i)?.[1];
    if (name === undefined) continue;
    const value = part.slice(blank + 2).replace(/\n$/, '');
    // A part with a filename is a file (its path after `<`, or none chosen yet).
    if (/filename=/i.test(head)) rows.push({ name, value: value.match(/^<\s*(.*)$/)?.[1].trim() ?? '', enabled: true, file: true });
    else rows.push({ name, value, enabled: true });
  }
  return rows;
}

/** Rows as a multipart body. */
export function multipartBody(rows: Row[], boundary: string): string {
  const parts = rows
    .filter((r) => r.name)
    .map((r) =>
      r.file
        ? `--${boundary}\nContent-Disposition: form-data; name="${r.name}"; filename="${r.value.split(/[\\/]/).pop() ?? ''}"\nContent-Type: ${mimeOf(r.value)}\n\n< ${r.value}`
        : `--${boundary}\nContent-Disposition: form-data; name="${r.name}"\n\n${r.value}`,
    );
  return parts.length ? `${parts.join('\n')}\n--${boundary}--` : '';
}

/** A picked file's path as the .http file writes it: relative to its folder when inside it. */
export function filePathFrom(httpFile: string, picked: string): string {
  const p = picked.replace(/\\/g, '/');
  const dir = httpFile.slice(0, httpFile.lastIndexOf('/') + 1);
  return p.toLowerCase().startsWith(dir.toLowerCase()) ? `./${p.slice(dir.length)}` : p;
}

export const header = (d: RequestDraft, name: string) => d.headers.find((h) => h.enabled && h.name.toLowerCase() === name)?.value ?? '';

/** The draft with this header set (the first of that name, else a new one); value null removes it. */
export function setHeader(d: RequestDraft, name: string, value: string | null): RequestDraft {
  const i = d.headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
  const headers = d.headers.slice();
  if (value === null) {
    if (i >= 0) headers.splice(i, 1);
  } else if (i >= 0) headers[i] = { ...headers[i], value, enabled: true };
  else headers.push({ name, value, enabled: true });
  return { ...d, headers };
}

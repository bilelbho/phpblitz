// .http / .rest files: requests separated by ### lines. A request is its comments and options
// (# @name login, # @no-redirect…), the request line (METHOD URL, or just the URL for GET, the query
// may go on over lines starting with ? or &), headers up to a blank line, then the body. Lines
// `@name = value` before it are variables for the rest of the file.

export interface HttpOptions {
  /** `# @name login`: its response is {{login.response…}} in later requests. */
  name?: string;
  noRedirect?: boolean;
  noCookieJar?: boolean;
  noCertCheck?: boolean;
  /** `# @timeout 30` (seconds). */
  timeoutMs?: number;
}

export interface ParsedRequest {
  /** The title after ###, or the request line. */
  title: string;
  /** 1-based: where its block starts (its ### line), where the request line is (the ▶ goes there), and its last line. */
  start: number;
  line: number;
  endLine: number;
  method: string;
  /** As written, variables unresolved; a multi-line query joined. */
  url: string;
  headers: [string, string][];
  /** null: no body. A body that's only `< ./file` lines sends those files. */
  body: string | null;
  options: HttpOptions;
  /** File variables (`@host = …`) set up to this request. */
  variables: Record<string, string>;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
const REQUEST_LINE = new RegExp(`^(${METHODS.join('|')})\\s+(\\S.*?)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`, 'i');
const BARE_URL = /^(https?:\/\/|\{\{)\S*\s*$/i;
const VARIABLE_LINE = /^@([\w.-]+)\s*=\s*(.*?)\s*$/;
const COMMENT = /^\s*(#|\/\/)/;

/** Every request in the file, in order. */
export function parseHttpFile(text: string): ParsedRequest[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ParsedRequest[] = [];
  const variables: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    // One block: from here to the next ### (exclusive).
    const blockStart = i + 1;
    let title = '';
    if (lines[i].startsWith('###')) {
      title = lines[i].slice(3).trim();
      i++;
    }
    const start = i;
    while (i < lines.length && !lines[i].startsWith('###')) i++;
    const block = lines.slice(start, i);
    const request = parseBlock(block, start, variables);
    if (request) out.push({ ...request, start: blockStart, title: title || `${request.method} ${request.url}` });
  }
  return out;
}

function parseBlock(block: string[], offset: number, variables: Record<string, string>): Omit<ParsedRequest, 'title' | 'start'> | null {
  const options: HttpOptions = {};
  let k = 0;
  // Comments, options and variables before the request line.
  for (; k < block.length; k++) {
    const line = block[k];
    if (!line.trim()) continue;
    const v = line.match(VARIABLE_LINE);
    if (v) {
      variables[v[1]] = v[2];
      continue;
    }
    if (COMMENT.test(line)) {
      readOption(line.replace(COMMENT, '').trim(), options);
      continue;
    }
    break;
  }
  if (k >= block.length) return null;
  const first = block[k].trim();
  const m = first.match(REQUEST_LINE);
  let method: string;
  let url: string;
  if (m) {
    method = m[1].toUpperCase();
    url = m[2];
  } else if (BARE_URL.test(first)) {
    method = 'GET';
    url = first.trim();
  } else {
    return null;
  }
  const line = offset + k + 1;
  k++;
  // The query going on over indented lines starting with ? or &.
  while (k < block.length && /^\s+[?&]/.test(block[k])) url += block[k++].trim();

  const headers: [string, string][] = [];
  for (; k < block.length && block[k].trim(); k++) {
    if (COMMENT.test(block[k])) continue;
    const colon = block[k].indexOf(':');
    if (colon > 0) headers.push([block[k].slice(0, colon).trim(), block[k].slice(colon + 1).trim()]);
  }
  // The body: after the blank line, up to the block's end; response handlers (> …) and response
  // references (<> …) at its end aren't part of it.
  let rest = block.slice(k + 1);
  while (rest.length && (!rest[rest.length - 1].trim() || /^\s*(<>|>)\s/.test(rest[rest.length - 1]))) rest = rest.slice(0, -1);
  // The request ends where its text does (blank lines after it belong to nobody).
  let end = offset + block.length;
  while (end > line && !block[end - offset - 1]?.trim()) end--;
  return { line, endLine: Math.max(line, end), method, url, headers, body: rest.length ? rest.join('\n') : null, options, variables: { ...variables } };
}

function readOption(text: string, options: HttpOptions) {
  const m = text.match(/^@([\w-]+)(?:\s+(.*))?$/);
  if (!m) return;
  const [, key, value = ''] = m;
  if (key === 'name' && value.trim()) options.name = value.trim();
  else if (key === 'no-redirect') options.noRedirect = true;
  else if (key === 'no-cookie-jar') options.noCookieJar = true;
  else if (key === 'no-cert-check') options.noCertCheck = true;
  else if (key === 'timeout') {
    const n = parseFloat(value);
    if (n > 0) options.timeoutMs = Math.round(n * (/ms\s*$/.test(value) ? 1 : 1000));
  }
}

/** The request the caret (1-based line) is in: the last one whose block starts at or before it. */
export function requestAt(requests: ParsedRequest[], line: number): ParsedRequest | null {
  let found: ParsedRequest | null = null;
  for (const r of requests) if (r.start <= line) found = r;
  return found ?? requests[0] ?? null;
}

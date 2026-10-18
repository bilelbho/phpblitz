// The DBGp protocol (what Xdebug speaks), on top of a transport that sends one command and
// delivers each XML packet. Commands are `name -i <transaction id> -x value … -- base64(data)`;
// every response carries the transaction id it answers.

import { child, childrenNamed, fromBase64, parseXml, toBase64, type XmlNode } from './xml';

export interface Property {
  name: string;
  /** What to pass to property_get / eval to reach it again: `$user->name`, `$items[0]`. */
  fullname: string;
  type: string;
  classname?: string;
  /** Scalar value, decoded; null for arrays / objects / null. */
  value: string | null;
  /** public / protected / private / static, from Xdebug's facet. */
  facet?: string;
  hasChildren: boolean;
  numChildren: number;
  page: number;
  pageSize: number;
  /** Children that came with this packet (depth > 0, or one page of them). */
  children?: Property[];
}

export interface StackFrame {
  level: number;
  /** Remote file URI as Xdebug reports it (file:///var/www/html/app.php). */
  fileUri: string;
  line: number;
  /** Function or method: `App\Http\Controllers\UserController->invoice`, `{main}`. */
  where: string;
}

export type Status = 'starting' | 'stopping' | 'stopped' | 'running' | 'break';

export interface Continuation {
  status: Status;
  reason: string;
  /** Where it stopped (break), when Xdebug says. */
  fileUri?: string;
  line?: number;
  /** Uncaught exception / error that broke. */
  exception?: string;
  message?: string;
}

export class DbgpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** One debugging connection. `send` writes a command to the socket; `handle` receives packets. */
export class DbgpConnection {
  private tid = 0;
  private pending = new Map<number, { resolve: (n: XmlNode) => void; reject: (e: Error) => void }>();
  init: XmlNode | null = null;
  private initWaiters: ((n: XmlNode) => void)[] = [];
  onStream: (type: string, text: string) => void = () => {};
  onNotify: (n: XmlNode) => void = () => {};

  constructor(private send: (command: string) => Promise<void>) {}

  /** A packet from Xdebug. */
  handle(xml: string) {
    const n = parseXml(xml);
    if (n.name === 'init') {
      this.init = n;
      this.initWaiters.splice(0).forEach((w) => w(n));
    } else if (n.name === 'stream') {
      this.onStream(n.attrs.type ?? 'stdout', n.attrs.encoding === 'base64' ? safeBase64(n.text) : n.text);
    } else if (n.name === 'notify') {
      this.onNotify(n);
    } else if (n.name === 'response') {
      const id = Number(n.attrs.transaction_id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      const err = child(n, 'error');
      if (err) p.reject(new DbgpError(Number(err.attrs.code), (child(err, 'message')?.text ?? `error ${err.attrs.code}`).trim()));
      else p.resolve(n);
    }
  }

  /** The connection closed: fail whatever is still waiting. */
  closed() {
    for (const p of this.pending.values()) p.reject(new Error('The debug session ended'));
    this.pending.clear();
  }

  waitInit(): Promise<XmlNode> {
    return this.init ? Promise.resolve(this.init) : new Promise((r) => this.initWaiters.push(r));
  }

  command(name: string, args: Record<string, string | number | undefined> = {}, data?: string): Promise<XmlNode> {
    const id = ++this.tid;
    return new Promise<XmlNode>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(formatCommand(name, id, args, data)).catch((e) => {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  async featureSet(name: string, value: string | number) {
    return this.command('feature_set', { n: name, v: value }).catch(() => null); // unsupported features are fine
  }

  /** Sets a line breakpoint; returns its id. */
  async breakpointSet(fileUri: string, line: number, opts: { condition?: string; temporary?: boolean } = {}): Promise<string> {
    const r = await this.command('breakpoint_set', { t: opts.condition ? 'conditional' : 'line', f: fileUri, n: line, r: opts.temporary ? 1 : undefined }, opts.condition);
    return r.attrs.id;
  }

  /** Breaks on uncaught exceptions / errors of this class (`*` for all). */
  async exceptionBreakpoint(name = '*'): Promise<string> {
    const r = await this.command('breakpoint_set', { t: 'exception', x: name });
    return r.attrs.id;
  }

  async breakpointRemove(id: string) {
    await this.command('breakpoint_remove', { d: id }).catch(() => null);
  }

  /** run / step_into / step_over / step_out / stop / detach: resolves when PHP stops again (or ends). */
  async continuation(cmd: 'run' | 'step_into' | 'step_over' | 'step_out' | 'stop' | 'detach'): Promise<Continuation> {
    return parseContinuation(await this.command(cmd));
  }

  async stack(): Promise<StackFrame[]> {
    const r = await this.command('stack_get');
    return childrenNamed(r, 'stack').map((s) => ({
      level: Number(s.attrs.level),
      fileUri: s.attrs.filename ?? '',
      line: Number(s.attrs.lineno),
      where: s.attrs.where ?? '',
    }));
  }

  /** Locals, Superglobals, User defined constants… */
  async contextNames(depth = 0): Promise<{ id: number; name: string }[]> {
    const r = await this.command('context_names', { d: depth });
    return childrenNamed(r, 'context').map((c) => ({ id: Number(c.attrs.id), name: c.attrs.name }));
  }

  async contextGet(context: number, depth = 0): Promise<Property[]> {
    const r = await this.command('context_get', { c: context, d: depth });
    return childrenNamed(r, 'property').map(parseProperty);
  }

  /** A property with (one page of) its children. */
  async propertyGet(fullname: string, depth = 0, context = 0, page = 0): Promise<Property | null> {
    const r = await this.command('property_get', { n: fullname, d: depth, c: context, p: page });
    const p = child(r, 'property');
    return p ? parseProperty(p) : null;
  }

  async evaluate(expression: string): Promise<Property | null> {
    const r = await this.command('eval', {}, expression);
    const p = child(r, 'property');
    return p ? parseProperty(p) : null;
  }
}

function safeBase64(s: string) {
  try {
    return fromBase64(s);
  } catch {
    return s;
  }
}

/** DBGp argument quoting: values with spaces or quotes are double-quoted, with \" and \\ escaped. */
export function formatCommand(name: string, id: number, args: Record<string, string | number | undefined>, data?: string): string {
  const parts = [name, '-i', String(id)];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const s = String(v);
    parts.push(`-${k}`, /[\s"\\]/.test(s) || s === '' ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s);
  }
  if (data !== undefined) parts.push('--', toBase64(data));
  return parts.join(' ');
}

export function parseContinuation(r: XmlNode): Continuation {
  const msg = child(r, 'message');
  return {
    status: (r.attrs.status as Status) ?? 'stopped',
    reason: r.attrs.reason ?? 'ok',
    fileUri: msg?.attrs.filename,
    line: msg?.attrs.lineno ? Number(msg.attrs.lineno) : undefined,
    exception: msg?.attrs.exception,
    message: msg?.text.trim() || undefined,
  };
}

export function parseProperty(n: XmlNode): Property {
  const nameNode = child(n, 'name');
  const fullNode = child(n, 'fullname');
  const valueNode = child(n, 'value');
  const text = (node: XmlNode | undefined, attr: string) => {
    if (node) return node.attrs.encoding === 'base64' ? safeBase64(node.text) : node.text;
    return n.attrs[attr] ?? '';
  };
  const type = n.attrs.type ?? 'undefined';
  const raw = valueNode ? (valueNode.attrs.encoding === 'base64' ? safeBase64(valueNode.text) : valueNode.text) : n.attrs.encoding === 'base64' ? safeBase64(n.text) : n.text;
  const children = childrenNamed(n, 'property').map(parseProperty);
  return {
    name: text(nameNode, 'name'),
    fullname: text(fullNode, 'fullname'),
    type,
    classname: n.attrs.classname,
    value: type === 'array' || type === 'object' || type === 'null' || type === 'uninitialized' ? null : raw,
    facet: n.attrs.facet,
    hasChildren: n.attrs.children === '1',
    numChildren: Number(n.attrs.numchildren ?? children.length),
    page: Number(n.attrs.page ?? 0),
    pageSize: Number(n.attrs.pagesize ?? 0),
    children: children.length ? children : undefined,
  };
}

/** How a value is shown: "text", 42, true, null, array(3), {App\Models\User}. */
export function displayValue(p: Property): string {
  switch (p.type) {
    case 'string':
      return `"${p.value ?? ''}"`;
    case 'bool':
      return p.value === '1' ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'uninitialized':
      return 'uninitialized';
    case 'array':
      return `array(${p.numChildren})`;
    case 'object':
      return `{${p.classname ?? 'object'}}${p.numChildren ? ` [${p.numChildren}]` : ''}`;
    default:
      return p.value ?? '';
  }
}

// ── File URIs ──────────────────────────────────────────────────

/** file:///C:/x/y.php → C:/x/y.php ; file:///var/www/a.php → /var/www/a.php */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let p = decodeURIComponent(uri.slice('file://'.length));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p.replace(/\\/g, '/');
}

export function pathToUri(path: string): string {
  const p = path.replace(/\\/g, '/');
  const encoded = p
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return /^[A-Za-z]:/.test(p) ? `file:///${encoded}` : `file://${encoded}`;
}

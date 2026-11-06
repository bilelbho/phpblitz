// {{variables}} in a request: the file's own (@host = …), the chosen environment's
// (http-client.env.json, and http-client.private.env.json for secrets), an earlier named request's
// response ({{login.response.body.token}}, {{login.response.headers.Location}}), and built-ins
// ({{$uuid}}, {{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}).

/** What a named request answered, for later requests. */
export interface NamedResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

export interface Scope {
  file: Record<string, string>;
  env: Record<string, string>;
  responses: ReadonlyMap<string, NamedResponse>;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The text with its variables filled in; the names that had no value are listed (and left as written). */
export function resolveVariables(text: string, scope: Scope): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const fill = (s: string, depth: number): string =>
    s.replace(PLACEHOLDER, (whole, name: string) => {
      const value = lookup(name, scope);
      if (value === undefined) {
        missing.add(name);
        return whole;
      }
      // A variable's value may use variables too (@url = {{host}}/api).
      return depth < 8 ? fill(value, depth + 1) : value;
    });
  return { text: fill(text, 0), missing: [...missing] };
}

function lookup(name: string, scope: Scope): string | undefined {
  if (name.startsWith('$')) return dynamic(name);
  if (name in scope.file) return scope.file[name];
  if (name in scope.env) return scope.env[name];
  const m = name.match(/^([\w-]+)\.response\.(status|body|headers)(?:\.(.+))?$/);
  if (m) {
    const r = scope.responses.get(m[1]);
    if (!r) return undefined;
    if (m[2] === 'status') return String(r.status);
    if (m[2] === 'headers') {
      if (!m[3]) return undefined;
      return r.headers.find(([k]) => k.toLowerCase() === m[3].toLowerCase())?.[1];
    }
    if (!m[3]) return r.body;
    return jsonAt(r.body, m[3]);
  }
  return undefined;
}

/** A value in a JSON text: `token`, `data.items[0].id`, or the same with a leading `$.`. */
export function jsonAt(json: string, path: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const steps = path
    .replace(/^\$\.?/, '')
    .split(/\.|\[(\d+)\]/)
    .filter((s) => s !== undefined && s !== '');
  for (const step of steps) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[step];
  }
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function dynamic(name: string): string | undefined {
  switch (name) {
    case '$uuid':
    case '$random.uuid':
      return crypto.randomUUID();
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000));
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$randomInt':
      return String(Math.floor(Math.random() * 1000));
  }
  return undefined;
}

/**
 * Environments from an env file's text, with a private one's on top (its values win). Values are
 * strings for the requests (numbers and booleans as written); nested objects (settings) are left out.
 */
export function parseEnvironments(publicText: string | null, privateText: string | null): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const text of [publicText, privateText]) {
    if (!text) continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    for (const [env, values] of Object.entries(data as Record<string, unknown>)) {
      if (!values || typeof values !== 'object') continue;
      const into = (out[env] ??= {});
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') into[k] = String(v);
      }
    }
  }
  return out;
}

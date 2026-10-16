// A small XML parser for DBGp packets (Xdebug's responses): elements, attributes, text and CDATA.
// No DOMParser so the protocol code also runs (and is tested) outside the browser.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Parses one XML document; returns its root element. Namespaces prefixes are dropped (`xdebug:message` → `message`). */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += decode(xml.slice(i, lt));
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      stack[stack.length - 1].text += xml.slice(lt + 9, end < 0 ? xml.length : end);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.startsWith('<!--', lt) ? xml.indexOf('-->', lt) + 3 : xml.indexOf('>', lt) + 1;
      i = end <= 0 ? xml.length : end;
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? xml.length : end + 1;
    } else {
      const end = findTagEnd(xml, lt);
      const body = xml.slice(lt + 1, end);
      const selfClosing = body.endsWith('/');
      const m = /^([^\s/>]+)/.exec(body);
      const node: XmlNode = { name: (m?.[1] ?? '').replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
      for (const a of body.matchAll(/([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) node.attrs[a[1].replace(/^.*:/, '')] = decode(a[3] ?? a[4] ?? '');
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  return root.children[0] ?? root;
}

/** The `>` closing a start tag, skipping `>` inside quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return xml.length;
}

export const child = (n: XmlNode, name: string) => n.children.find((c) => c.name === name);
export const childrenNamed = (n: XmlNode, name: string) => n.children.filter((c) => c.name === name);

/** Base64 (as Xdebug encodes values and output) to text, as UTF-8. */
export function fromBase64(s: string): string {
  const bin = atob(s.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

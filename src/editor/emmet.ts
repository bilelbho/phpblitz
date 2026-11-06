// Emmet-style HTML abbreviations, expanded with Tab in HTML, Blade, Twig and the HTML parts of PHP
// files: `ul>li.item*3>a{Item $}` becomes the list, as a snippet (Tab goes through the empty
// attributes and contents). The syntax:
//   tag.class#id[attr=value attr2="a b"]{text}*n      an element (tag left out: div, li in a list…)
//   a>b  child    a+b  sibling    a^b  up a level    (a+b)*2  group    $ $$  the number (01) in *n
//   !  an HTML5 page

interface Node {
  tag: string;
  classes: string[];
  id: string;
  attrs: [string, string | null][];
  text: string | null;
  count: number;
  /** A group's children are written without an element around them. */
  group: boolean;
  children: Node[];
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'input', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'textarea', 'time', 'u', 'var', 'wbr']);
/** HTML elements: a plain word expands only when it's one of these (else it's just text). */
const TAGS = new Set([
  ...VOID,
  ...INLINE,
  ...'address article aside audio blockquote body canvas caption colgroup datalist dd del details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup html iframe ins legend li main map menu meter nav noscript object ol optgroup option output p picture pre progress script section slot style summary table tbody td template tfoot th thead title tr ul video svg'.split(' '),
]);
/** Attributes an element gets even when the abbreviation doesn't name them. */
const DEFAULT_ATTRS: Record<string, [string, string | null][]> = {
  a: [['href', null]],
  img: [
    ['src', null],
    ['alt', null],
  ],
  input: [['type', 'text']],
  link: [
    ['rel', 'stylesheet'],
    ['href', null],
  ],
  script: [['src', null]],
  form: [['action', null]],
  label: [['for', null]],
  iframe: [['src', null]],
  option: [['value', null]],
  meta: [['content', null]],
};
/** The tag of an element without one, by its parent's. */
const IMPLICIT: Record<string, string> = { ul: 'li', ol: 'li', table: 'tr', tbody: 'tr', thead: 'tr', tfoot: 'tr', tr: 'td', select: 'option', optgroup: 'option', dl: 'dt', map: 'area' };

const PAGE = `<!DOCTYPE html>
<html lang="\${1:en}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>\${2:Document}</title>
</head>
<body>
    $0
</body>
</html>`;

class Parser {
  i = 0;
  constructor(private s: string) {}
  peek() {
    return this.s[this.i];
  }
  done() {
    return this.i >= this.s.length;
  }
  /** a>b+c^d…: the top-level nodes. */
  sequence(close?: string): Node[] {
    const top: Node[] = [];
    // The list new nodes go into, and the chain of lists above it (for ^).
    let list = top;
    const stack: Node[][] = [];
    let last: Node | null = null;
    for (;;) {
      const node = this.item();
      list.push(node);
      last = node;
      if (this.done() || this.peek() === close) return top;
      const op = this.s[this.i++];
      if (op === '>') {
        stack.push(list);
        list = last.children;
      } else if (op === '^') {
        list = stack.pop() ?? top;
        while (this.peek() === '^') {
          this.i++;
          list = stack.pop() ?? top;
        }
      } else if (op !== '+') throw new Error(`unexpected ${op}`);
    }
  }
  item(): Node {
    let node: Node;
    if (this.peek() === '(') {
      this.i++;
      node = blank('');
      node.group = true;
      node.children = this.sequence(')');
      if (this.s[this.i++] !== ')') throw new Error('unclosed (');
    } else node = this.element();
    if (this.peek() === '*') {
      this.i++;
      const m = /^\d+/.exec(this.s.slice(this.i));
      if (!m) throw new Error('* needs a number');
      node.count = Number(m[0]);
      this.i += m[0].length;
    }
    return node;
  }
  element(): Node {
    const name = /^[A-Za-z][\w:-]*/.exec(this.s.slice(this.i))?.[0] ?? '';
    this.i += name.length;
    const node = blank(name);
    for (;;) {
      const c = this.peek();
      if (c === '.' || c === '#') {
        this.i++;
        const v = /^[\w$@-]+/.exec(this.s.slice(this.i))?.[0];
        if (!v) throw new Error(`empty ${c}`);
        this.i += v.length;
        if (c === '.') node.classes.push(v);
        else node.id = v;
      } else if (c === '[') {
        const end = this.s.indexOf(']', this.i);
        if (end < 0) throw new Error('unclosed [');
        for (const m of this.s.slice(this.i + 1, end).matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?/g)) node.attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
        this.i = end + 1;
      } else if (c === '{') {
        const end = this.s.indexOf('}', this.i);
        if (end < 0) throw new Error('unclosed {');
        node.text = this.s.slice(this.i + 1, end);
        this.i = end + 1;
      } else break;
    }
    if (!name && !node.classes.length && !node.id && !node.attrs.length && node.text === null) throw new Error('empty element');
    return node;
  }
}

const blank = (tag: string): Node => ({ tag, classes: [], id: '', attrs: [], text: null, count: 1, group: false, children: [] });

/** Text as snippet text: $, } and \ escaped. */
const esc = (s: string) => s.replace(/[\\$}]/g, (c) => `\\${c}`);

/** In a *n repeat: `$` → the number, `$$` → 01… (as many digits as $). Elsewhere $ is a $. */
const numbered = (s: string, n: number) => (n ? s.replace(/\$+/g, (m) => String(n).padStart(m.length, '0')) : s);

/** Is this text an abbreviation to expand (not a word of prose)? */
export function isAbbreviation(abbr: string): boolean {
  if (!abbr || /^\d/.test(abbr)) return false;
  if (abbr === '!') return true;
  if (/^[A-Za-z][\w-]*$/.test(abbr)) return TAGS.has(abbr.toLowerCase());
  return /^[\w.#[({!]/.test(abbr);
}

/** The snippet for an abbreviation (null: not one). `unit`: one level of indentation. */
export function expandAbbreviation(abbr: string, unit = '    '): string | null {
  if (abbr === '!' || abbr === 'html:5') return PAGE.replace(/ {4}/g, unit);
  if (!isAbbreviation(abbr)) return null;
  let nodes: Node[];
  try {
    const p = new Parser(abbr);
    nodes = p.sequence();
    if (!p.done()) return null;
  } catch {
    return null;
  }
  let stop = 0;
  const field = (initial = '') => `\${${++stop}${initial ? `:${initial}` : ''}}`;

  /** Lines for these nodes inside `parent`, numbered `n` by the nearest * (0: none). */
  const render = (list: Node[], parent: string, n: number): string[] => {
    const out: string[] = [];
    for (const node of list) {
      for (let k = 1; k <= node.count; k++) {
        const num = node.count > 1 ? k : n;
        if (node.group) {
          out.push(...render(node.children, parent, num));
          continue;
        }
        // Text alone: {Hello}
        if (!node.tag && node.text !== null && !node.classes.length && !node.id && !node.attrs.length) {
          out.push(esc(numbered(node.text, num)));
          continue;
        }
        const tag = node.tag || IMPLICIT[parent] || (INLINE.has(parent) ? 'span' : 'div');
        // Attributes: null is a field to fill in; a bare one ([disabled]) has no value.
        const attrs: { name: string; value: string | null; bare?: boolean }[] = [];
        if (node.id) attrs.push({ name: 'id', value: numbered(node.id, num) });
        if (node.classes.length) attrs.push({ name: 'class', value: node.classes.map((c) => numbered(c, num)).join(' ') });
        const named = new Set([...node.attrs.map(([a]) => a), ...attrs.map((a) => a.name)]);
        for (const [name, value] of DEFAULT_ATTRS[tag] ?? []) if (!named.has(name)) attrs.push({ name, value });
        for (const [name, value] of node.attrs) attrs.push(value === null ? { name, value, bare: true } : { name, value: numbered(value, num) });
        const open = `<${tag}${attrs.map((a) => (a.bare ? ` ${a.name}` : ` ${a.name}="${a.value ? esc(a.value) : field()}"`)).join('')}>`;
        if (VOID.has(tag)) {
          out.push(open);
          continue;
        }
        const text = node.text !== null ? esc(numbered(node.text, num)) : '';
        const inner = render(node.children, tag, num);
        const childTag = (c: Node) => c.tag || IMPLICIT[tag] || (INLINE.has(tag) ? 'span' : 'div');
        const isText = (c: Node) => !c.tag && c.text !== null && !c.classes.length && !c.id && !c.attrs.length;
        const block = inner.length > 1 || node.children.some((c) => c.group || (!isText(c) && !INLINE.has(childTag(c))));
        if (!inner.length) out.push(`${open}${text || field()}</${tag}>`);
        else if (!block) out.push(`${open}${text}${inner.join('')}</${tag}>`);
        else out.push(open, ...(text ? [unit + text] : []), ...inner.flatMap((l) => l.split('\n')).map((l) => unit + l), `</${tag}>`);
      }
    }
    return out;
  };
  return render(nodes, '', 0).join('\n');
}

/**
 * The abbreviation that ends at `column` (1-based) of this line, and where it starts; null when
 * there's none (the caret in a word of text, in a tag…).
 */
export function abbreviationBefore(line: string, column: number): { text: string; start: number } | null {
  const before = line.slice(0, column - 1);
  // After the last whole tag (<p>ul>li) and outside spaces that aren't inside [] {} or quotes.
  let start = 0;
  for (const m of before.matchAll(/<\/?[A-Za-z][^<>]*>/g)) start = m.index! + m[0].length;
  let depth = 0;
  let i = before.length - 1;
  for (; i >= start; i--) {
    const c = before[i];
    if (c === ']' || c === '}' || c === ')') depth++;
    else if (c === '[' || c === '{' || c === '(') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s<"'`=;,]/.test(c)) break;
  }
  const text = before.slice(i + 1);
  // Inside a tag being typed (<div cla|), or right after a word character of a tag: not ours.
  if (!text || /<[A-Za-z][^>]*$/.test(before.slice(start, i + 1))) return null;
  return isAbbreviation(text) ? { text, start: i + 2 } : null;
}

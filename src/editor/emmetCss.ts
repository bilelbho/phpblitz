// Emmet-style CSS shorthands, expanded with Tab inside a rule of a CSS, SCSS or Less file:
//   m10 → margin: 10px;      m10-auto → margin: 10px auto;   m-5 → margin: -5px;   p10--5 → padding: 10px -5px;
//   w50p → width: 50%;       fz1.5r → font-size: 1.5rem;     lh1.4 → line-height: 1.4;
//   d:f → display: flex;     jc:sb → justify-content: space-between;   c#f → color: #fff;
//   m → margin: |;           pos:a! → position: absolute !important;
// Units: p %, e em, r rem, x ex; others as written (vh, deg, ms…); none: px (unitless properties stay bare).

const PROPS: Record<string, string> = {
  m: 'margin', mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom', ml: 'margin-left',
  p: 'padding', pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left',
  w: 'width', h: 'height', maw: 'max-width', mah: 'max-height', miw: 'min-width', mih: 'min-height',
  t: 'top', r: 'right', b: 'bottom', l: 'left', ins: 'inset', z: 'z-index',
  d: 'display', pos: 'position', fl: 'float', cl: 'clear', v: 'visibility', ov: 'overflow', ovx: 'overflow-x', ovy: 'overflow-y',
  fz: 'font-size', fw: 'font-weight', ff: 'font-family', fs: 'font-style', lh: 'line-height', lts: 'letter-spacing',
  c: 'color', ta: 'text-align', td: 'text-decoration', tt: 'text-transform', ti: 'text-indent', tov: 'text-overflow',
  va: 'vertical-align', ws: 'white-space', wob: 'word-break',
  bg: 'background', bgc: 'background-color', bgi: 'background-image', bgsz: 'background-size', bgp: 'background-position', bgr: 'background-repeat',
  bd: 'border', bdt: 'border-top', bdr: 'border-right', bdb: 'border-bottom', bdl: 'border-left', bdc: 'border-color', bdw: 'border-width', bds: 'border-style', bdrs: 'border-radius',
  ol: 'outline', op: 'opacity', bxsh: 'box-shadow', bxz: 'box-sizing', cur: 'cursor', ct: 'content',
  fx: 'flex', fxd: 'flex-direction', fxw: 'flex-wrap', fxg: 'flex-grow', fxsh: 'flex-shrink', fxb: 'flex-basis', ord: 'order',
  jc: 'justify-content', ji: 'justify-items', js: 'justify-self', ai: 'align-items', ac: 'align-content', as: 'align-self',
  g: 'gap', rg: 'row-gap', cg: 'column-gap', gtc: 'grid-template-columns', gtr: 'grid-template-rows', gc: 'grid-column', gr: 'grid-row',
  trf: 'transform', trs: 'transition', ani: 'animation', ar: 'aspect-ratio', obf: 'object-fit', us: 'user-select', pe: 'pointer-events',
};

const ALIGN = { c: 'center', s: 'start', e: 'end', fs: 'flex-start', fe: 'flex-end', sb: 'space-between', sa: 'space-around', se: 'space-evenly', st: 'stretch', b: 'baseline' };
const OVERFLOW = { h: 'hidden', a: 'auto', s: 'scroll', v: 'visible', c: 'clip' };
const NONE_AUTO = { n: 'none', a: 'auto' };

/** Keyword values: `d:f` → flex. */
const KEYWORDS: Record<string, Record<string, string>> = {
  display: { n: 'none', b: 'block', i: 'inline', ib: 'inline-block', f: 'flex', if: 'inline-flex', g: 'grid', ig: 'inline-grid', t: 'table', c: 'contents' },
  position: { a: 'absolute', r: 'relative', f: 'fixed', s: 'static', st: 'sticky' },
  float: { l: 'left', r: 'right', n: 'none' },
  clear: { l: 'left', r: 'right', n: 'none', b: 'both' },
  visibility: { v: 'visible', h: 'hidden', c: 'collapse' },
  overflow: OVERFLOW,
  'overflow-x': OVERFLOW,
  'overflow-y': OVERFLOW,
  'font-weight': { b: 'bold', n: 'normal', l: 'lighter', bd: 'bolder' },
  'font-style': { i: 'italic', n: 'normal', o: 'oblique' },
  'text-align': { l: 'left', r: 'right', c: 'center', j: 'justify', s: 'start', e: 'end' },
  'text-decoration': { n: 'none', u: 'underline', o: 'overline', l: 'line-through' },
  'text-transform': { u: 'uppercase', l: 'lowercase', c: 'capitalize', n: 'none' },
  'text-overflow': { e: 'ellipsis', c: 'clip' },
  'vertical-align': { m: 'middle', t: 'top', b: 'bottom', bl: 'baseline', s: 'super', sub: 'sub' },
  'white-space': { n: 'nowrap', p: 'pre', pw: 'pre-wrap', pl: 'pre-line', nm: 'normal' },
  'word-break': { ba: 'break-all', ka: 'keep-all', bw: 'break-word', n: 'normal' },
  'box-sizing': { bb: 'border-box', cb: 'content-box' },
  cursor: { p: 'pointer', d: 'default', t: 'text', m: 'move', na: 'not-allowed', h: 'help', w: 'wait', g: 'grab' },
  'flex-direction': { r: 'row', rr: 'row-reverse', c: 'column', cr: 'column-reverse' },
  'flex-wrap': { w: 'wrap', n: 'nowrap', wr: 'wrap-reverse' },
  'justify-content': ALIGN,
  'justify-items': ALIGN,
  'justify-self': ALIGN,
  'align-items': ALIGN,
  'align-content': ALIGN,
  'align-self': { ...ALIGN, a: 'auto' },
  'object-fit': { c: 'cover', cn: 'contain', f: 'fill', n: 'none', sd: 'scale-down' },
  'user-select': { ...NONE_AUTO, t: 'text', al: 'all' },
  'pointer-events': NONE_AUTO,
  'border-style': { n: 'none', s: 'solid', d: 'dashed', dt: 'dotted', db: 'double' },
  'background-repeat': { n: 'no-repeat', x: 'repeat-x', y: 'repeat-y', r: 'repeat' },
  'background-size': { c: 'cover', cn: 'contain', a: 'auto' },
};

/** Properties whose plain numbers have no unit. */
const UNITLESS = new Set(['z-index', 'opacity', 'line-height', 'font-weight', 'flex', 'flex-grow', 'flex-shrink', 'order', 'aspect-ratio']);
const UNITS: Record<string, string> = { p: '%', e: 'em', r: 'rem', x: 'ex' };

/** `#f` → #fff, `#fc` → #fcfcfc; three or six digits as written. */
function color(hex: string): string {
  const h = hex.slice(1);
  if (h.length === 1) return `#${h.repeat(3)}`;
  if (h.length === 2) return `#${h.repeat(3)}`;
  return hex;
}

/** Numbers like `10-20`, `10--5`, `-5`, `1.5r`, `50p`, `10-auto` → "10px 20px" … */
function values(text: string, property: string): string | null {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    // A '-' between values separates them; a second one makes the next negative.
    if (out.length) {
      if (text[i] !== '-') return null;
      i++;
    }
    const m = /^(-?\d*\.?\d+)([a-z%]*)|^([a-z]+)/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    if (m[3]) {
      // A word (auto, inherit…).
      out.push(m[3]);
      continue;
    }
    const [, num, unit] = m;
    if (unit) out.push(num + (UNITS[unit] ?? unit));
    else out.push(Number(num) === 0 || UNITLESS.has(property) ? num : `${num}px`);
  }
  return out.join(' ');
}

/** The declaration for a shorthand, as a snippet; null when it isn't one. */
export function expandCss(abbr: string): string | null {
  let a = abbr;
  const important = a.endsWith('!');
  if (important) a = a.slice(0, -1);
  const tail = important ? ' !important' : '';
  // prop:keyword
  const kw = /^([a-z]+):([a-z-]*)$/.exec(a);
  if (kw) {
    const property = PROPS[kw[1]];
    if (!property) return null;
    const value = KEYWORDS[property]?.[kw[2]] ?? kw[2];
    return value ? `${property}: ${value}${tail};` : `${property}: \${1}${tail};`;
  }
  // prop#color
  const hex = /^([a-z]+)(#[0-9a-f]{1,6})$/i.exec(a);
  if (hex) {
    const property = PROPS[hex[1].toLowerCase()];
    return property ? `${property}: ${color(hex[2].toLowerCase())}${tail};` : null;
  }
  // prop, prop10, prop-10, prop10-20…: the longest property name the text starts with.
  const m = /^([a-z]+?)((?:-?\d|-?\.\d)[\w.%-]*|-[a-z][\w.%-]*)?$/.exec(a);
  if (!m) return null;
  for (let n = a.length; n > 0; n--) {
    const name = a.slice(0, n);
    const property = PROPS[name];
    if (!property) continue;
    const rest = a.slice(n);
    if (!rest) return `${property}: \${1}${tail};`;
    if (!/^-?[\d.]|^-[a-z]/.test(rest)) continue;
    const v = values(rest, property);
    if (v === null) continue;
    return `${property}: ${v}${tail};`;
  }
  return null;
}

/** The shorthand before the caret (1-based column): a word that starts the declaration. */
export function cssAbbreviationBefore(line: string, column: number): { text: string; start: number } | null {
  const before = line.slice(0, column - 1);
  const m = /(^|[\s{;])([a-z][a-z0-9:#.%!-]*)$/i.exec(before);
  if (!m) return null;
  return { text: m[2], start: before.length - m[2].length + 1 };
}

/** Inside a rule's braces (not a selector, a comment or a string): where declarations go. */
export function inCssDeclarations(text: string, offset: number): boolean {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0 || end + 2 > offset) return false;
      i = end + 1;
    } else if (ch === '/' && text[i + 1] === '/' && text[i - 1] !== ':') {
      // SCSS / Less line comment (not the // of a URL).
      const end = text.indexOf('\n', i);
      if (end < 0 || end >= offset) return false;
      i = end;
    } else if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end < 0 || end >= offset) return false;
      i = end;
    } else if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

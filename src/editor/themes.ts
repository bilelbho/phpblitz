// Editor color schemes (Settings ▸ Editor ▸ Color Scheme). Each one is a small palette turned
// into a Monaco theme; token names come from the PHP grammar in phpGrammar.ts.

import * as monaco from 'monaco-editor';

interface Palette {
  name: string;
  dark: boolean;
  bg: string;
  fg: string;
  lineHighlight: string;
  selection: string;
  lineNumber: string;
  lineNumberActive: string;
  widget: string;
  widgetBorder: string;
  keyword: string;
  string: string;
  escape: string;
  variable: string;
  property: string;
  number: string;
  comment: string;
  docComment: string;
  docTag: string;
  funcDecl: string;
  funcCall: string;
  constant: string;
  attribute: string;
  namedArg: string;
  type: string;
  tag: string;
  hintFg: string;
  hintBg: string;
  indentGuide: string;
  error: string;
  warning: string;
}

const strip = (c: string) => c.replace('#', '');

export const SCHEMES = {
  'islands-dark': {
    name: 'Islands Dark',
    dark: true,
    bg: '#1E1F22',
    fg: '#BCBEC4',
    lineHighlight: '#26282E',
    selection: '#214283',
    lineNumber: '#4B5059',
    lineNumberActive: '#A1A3AB',
    widget: '#2B2D30',
    widgetBorder: '#43454A',
    keyword: '#CF8E6D',
    string: '#6AAB73',
    escape: '#CF8E6D',
    variable: '#C77DBB',
    property: '#C77DBB',
    number: '#2AACB8',
    comment: '#7A7E85',
    docComment: '#5F826B',
    docTag: '#67A37C',
    funcDecl: '#56A8F5',
    funcCall: '#56A8F5',
    constant: '#C77DBB',
    attribute: '#B3AE60',
    namedArg: '#56A8F5',
    type: '#BCBEC4',
    tag: '#D5B778',
    hintFg: '#8C8F94',
    hintBg: '#2B2D30',
    indentGuide: '#313438',
    error: '#F75464',
    warning: '#E5A33D',
  },
  darcula: {
    name: 'Darcula',
    dark: true,
    bg: '#2B2B2B',
    fg: '#A9B7C6',
    lineHighlight: '#323232',
    selection: '#214283',
    lineNumber: '#606366',
    lineNumberActive: '#A4A3A3',
    widget: '#3C3F41',
    widgetBorder: '#515658',
    keyword: '#CC7832',
    string: '#6A8759',
    escape: '#CC7832',
    variable: '#9876AA',
    property: '#9876AA',
    number: '#6897BB',
    comment: '#808080',
    docComment: '#629755',
    docTag: '#77B767',
    funcDecl: '#FFC66D',
    funcCall: '#A9B7C6',
    constant: '#9876AA',
    attribute: '#BBB529',
    namedArg: '#467CDA',
    type: '#A9B7C6',
    tag: '#E8BF6A',
    hintFg: '#8C8C8C',
    hintBg: '#3B3B3B',
    indentGuide: '#393939',
    error: '#FF6B68',
    warning: '#BE9117',
  },
  'high-contrast': {
    name: 'High Contrast',
    dark: true,
    bg: '#000000',
    fg: '#FFFFFF',
    lineHighlight: '#1A1A1A',
    selection: '#1F4ACC',
    lineNumber: '#8C8C8C',
    lineNumberActive: '#FFFFFF',
    widget: '#0F0F0F',
    widgetBorder: '#FFFFFF',
    keyword: '#FFB86B',
    string: '#7EE787',
    escape: '#FFB86B',
    variable: '#E59CFF',
    property: '#E59CFF',
    number: '#5FD7FF',
    comment: '#B0B0B0',
    docComment: '#8FD19E',
    docTag: '#B7F5C4',
    funcDecl: '#79C0FF',
    funcCall: '#79C0FF',
    constant: '#E59CFF',
    attribute: '#F2E35B',
    namedArg: '#79C0FF',
    type: '#FFFFFF',
    tag: '#F2E35B',
    hintFg: '#C8C8C8',
    hintBg: '#262626',
    indentGuide: '#404040',
    error: '#FF5C5C',
    warning: '#FFD24D',
  },
  'one-dark': {
    name: 'One Dark',
    dark: true,
    bg: '#282C34',
    fg: '#ABB2BF',
    lineHighlight: '#2C313C',
    selection: '#3E4451',
    lineNumber: '#495162',
    lineNumberActive: '#ABB2BF',
    widget: '#21252B',
    widgetBorder: '#3E4451',
    keyword: '#C678DD',
    string: '#98C379',
    escape: '#56B6C2',
    variable: '#E06C75',
    property: '#E06C75',
    number: '#D19A66',
    comment: '#5C6370',
    docComment: '#5C6370',
    docTag: '#C678DD',
    funcDecl: '#61AFEF',
    funcCall: '#61AFEF',
    constant: '#D19A66',
    attribute: '#E5C07B',
    namedArg: '#56B6C2',
    type: '#E5C07B',
    tag: '#E06C75',
    hintFg: '#7F848E',
    hintBg: '#2F343E',
    indentGuide: '#3B4048',
    error: '#E06C75',
    warning: '#D19A66',
  },
  monokai: {
    name: 'Monokai',
    dark: true,
    bg: '#272822',
    fg: '#F8F8F2',
    lineHighlight: '#3E3D32',
    selection: '#49483E',
    lineNumber: '#90908A',
    lineNumberActive: '#F8F8F2',
    widget: '#1E1F1C',
    widgetBorder: '#49483E',
    keyword: '#F92672',
    string: '#E6DB74',
    escape: '#AE81FF',
    variable: '#F8F8F2',
    property: '#F8F8F2',
    number: '#AE81FF',
    comment: '#75715E',
    docComment: '#75715E',
    docTag: '#F92672',
    funcDecl: '#A6E22E',
    funcCall: '#66D9EF',
    constant: '#AE81FF',
    attribute: '#A6E22E',
    namedArg: '#FD971F',
    type: '#66D9EF',
    tag: '#F92672',
    hintFg: '#A59F85',
    hintBg: '#3E3D32',
    indentGuide: '#3B3A32',
    error: '#F92672',
    warning: '#FD971F',
  },
  'solarized-dark': {
    name: 'Solarized Dark',
    dark: true,
    bg: '#002B36',
    fg: '#839496',
    lineHighlight: '#073642',
    selection: '#274642',
    lineNumber: '#586E75',
    lineNumberActive: '#93A1A1',
    widget: '#00212B',
    widgetBorder: '#2B4F5A',
    keyword: '#859900',
    string: '#2AA198',
    escape: '#DC322F',
    variable: '#268BD2',
    property: '#268BD2',
    number: '#D33682',
    comment: '#586E75',
    docComment: '#586E75',
    docTag: '#859900',
    funcDecl: '#B58900',
    funcCall: '#B58900',
    constant: '#CB4B16',
    attribute: '#6C71C4',
    namedArg: '#6C71C4',
    type: '#CB4B16',
    tag: '#268BD2',
    hintFg: '#657B83',
    hintBg: '#073642',
    indentGuide: '#0E3E4A',
    error: '#DC322F',
    warning: '#B58900',
  },
  light: {
    name: 'IntelliJ Light',
    dark: false,
    bg: '#FFFFFF',
    fg: '#080808',
    lineHighlight: '#FCFAED',
    selection: '#A6D2FF',
    lineNumber: '#ADADAD',
    lineNumberActive: '#767A8A',
    widget: '#FFFFFF',
    widgetBorder: '#D3D5DB',
    keyword: '#0033B3',
    string: '#067D17',
    escape: '#0037A6',
    variable: '#871094',
    property: '#871094',
    number: '#1750EB',
    comment: '#8C8C8C',
    docComment: '#8C8C8C',
    docTag: '#3D3D3D',
    funcDecl: '#00627A',
    funcCall: '#00627A',
    constant: '#871094',
    attribute: '#9E880D',
    namedArg: '#4A86C7',
    type: '#080808',
    tag: '#0033B3',
    hintFg: '#6E6E6E',
    hintBg: '#EDEEF0',
    indentGuide: '#EBECF0',
    error: '#E55765',
    warning: '#C29E4A',
  },
  'github-light': {
    name: 'GitHub Light',
    dark: false,
    bg: '#FFFFFF',
    fg: '#24292F',
    lineHighlight: '#F6F8FA',
    selection: '#B6D5FF',
    lineNumber: '#8C959F',
    lineNumberActive: '#24292F',
    widget: '#FFFFFF',
    widgetBorder: '#D0D7DE',
    keyword: '#CF222E',
    string: '#0A3069',
    escape: '#116329',
    variable: '#953800',
    property: '#0550AE',
    number: '#0550AE',
    comment: '#6E7781',
    docComment: '#6E7781',
    docTag: '#CF222E',
    funcDecl: '#8250DF',
    funcCall: '#8250DF',
    constant: '#0550AE',
    attribute: '#8250DF',
    namedArg: '#116329',
    type: '#953800',
    tag: '#116329',
    hintFg: '#57606A',
    hintBg: '#EFF1F3',
    indentGuide: '#E4E7EB',
    error: '#CF222E',
    warning: '#9A6700',
  },
} satisfies Record<string, Palette>;

export type SchemeId = keyof typeof SCHEMES;

export const themeId = (scheme: string) => `pb-${scheme in SCHEMES ? scheme : 'islands-dark'}`;

export function schemeOf(scheme: string): Palette {
  return SCHEMES[(scheme in SCHEMES ? scheme : 'islands-dark') as SchemeId];
}

function define(id: SchemeId, p: Palette) {
  const r = (token: string, color: string, fontStyle?: string) => ({ token, foreground: strip(color), fontStyle });
  monaco.editor.defineTheme(themeId(id), {
    base: p.dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      r('', p.fg),
      r('keyword', p.keyword),
      r('string', p.string),
      r('string.escape', p.escape),
      r('variable', p.variable),
      r('variable.this', p.keyword),
      r('property', p.property),
      r('number', p.number),
      r('comment', p.comment, 'italic'),
      r('comment.doc', p.docComment, 'italic'),
      r('comment.doc.tag', p.docTag, 'italic bold'),
      r('function', p.funcCall),
      r('function.declaration', p.funcDecl),
      r('function.static', p.funcCall, 'italic'),
      r('constant', p.constant, 'italic'),
      r('variable.static', p.property, 'italic'),
      r('attribute', p.attribute),
      r('parameter.named', p.namedArg),
      r('type', p.type),
      r('type.declaration', p.type),
      r('delimiter', p.fg),
      r('operator', p.fg),
      r('metatag', p.keyword),
      r('tag', p.tag),
      r('attribute.name', p.fg),
      r('attribute.value', p.string),
      r('string.key.json', p.property),
      r('string.value.json', p.string),
      r('keyword.json', p.keyword),
      r('strong.md', p.fg, 'bold'),
      r('emphasis.md', p.fg, 'italic'),
      r('number.json', p.number),
    ],
    colors: {
      'editor.background': p.bg,
      'editor.foreground': p.fg,
      'editor.lineHighlightBackground': p.lineHighlight,
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': p.lineNumber,
      'editorLineNumber.activeForeground': p.lineNumberActive,
      'editorCursor.foreground': p.dark ? '#CED0D6' : '#000000',
      'editor.selectionBackground': p.selection,
      'editor.inactiveSelectionBackground': p.selection + '99',
      'editor.wordHighlightBackground': p.dark ? '#373B39' : '#EDEBFC',
      'editor.wordHighlightStrongBackground': p.dark ? '#3B3B4A' : '#F6EBBC',
      'editorBracketMatch.background': p.dark ? '#43454A' : '#93D9D9',
      'editorBracketMatch.border': '#00000000',
      'editorGutter.background': p.bg,
      'editorInlayHint.foreground': p.hintFg,
      'editorInlayHint.background': p.hintBg,
      'editorInlayHint.parameterForeground': p.hintFg,
      'editorInlayHint.parameterBackground': p.hintBg,
      'editorInlayHint.typeForeground': p.hintFg,
      'editorInlayHint.typeBackground': p.hintBg,
      'editorCodeLens.foreground': p.hintFg,
      'editorWidget.background': p.widget,
      'editorWidget.border': p.widgetBorder,
      'editorHoverWidget.background': p.widget,
      'editorHoverWidget.border': p.widgetBorder,
      'editorSuggestWidget.background': p.widget,
      'editorSuggestWidget.border': p.widgetBorder,
      'editorSuggestWidget.foreground': p.fg,
      'editorSuggestWidget.selectedBackground': p.dark ? '#2E436E' : '#D5E1FF',
      'editorSuggestWidget.highlightForeground': p.dark ? '#548AF7' : '#2154D9',
      'editorStickyScroll.background': p.bg,
      'editorStickyScrollHover.background': p.lineHighlight,
      'editorIndentGuide.background1': p.indentGuide,
      'editorIndentGuide.activeBackground1': p.indentGuide,
      'editorError.foreground': p.error,
      'editorWarning.foreground': p.warning,
      'editorOverviewRuler.border': '#00000000',
      // Diff viewer, in JetBrains' green / red tones.
      'diffEditor.insertedLineBackground': p.dark ? '#2a3d2c80' : '#e3f5e6',
      'diffEditor.insertedTextBackground': p.dark ? '#3c6a4380' : '#bde8c4',
      'diffEditor.removedLineBackground': p.dark ? '#4a2c2e80' : '#fbe4e4',
      'diffEditor.removedTextBackground': p.dark ? '#7a3c4080' : '#f4b9b9',
      'diffEditor.diagonalFill': p.dark ? '#ffffff10' : '#00000010',
      'minimap.background': p.bg,
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': p.dark ? '#4E515766' : '#C9CCD666',
      'scrollbarSlider.hoverBackground': p.dark ? '#5A5D63AA' : '#B4B8C2AA',
      'scrollbarSlider.activeBackground': p.dark ? '#5A5D63CC' : '#A0A4AECC',
    },
  });
}

for (const [id, palette] of Object.entries(SCHEMES)) define(id as SchemeId, palette);

/** The palette color for a token type such as `function.declaration.php`. */
function colorOf(p: Palette, type: string): { color: string; italic?: boolean } {
  const t = type.replace(/\.php$/, '');
  const table: [string, string, boolean?][] = [
    ['comment.doc.tag', p.docTag, true],
    ['comment.doc', p.docComment, true],
    ['comment', p.comment, true],
    ['string.escape', p.escape],
    ['string', p.string],
    ['variable.this', p.keyword],
    ['variable.static', p.property, true],
    ['variable', p.variable],
    ['property', p.property],
    ['number', p.number],
    ['function.declaration', p.funcDecl],
    ['function.static', p.funcCall, true],
    ['function', p.funcCall],
    ['constant', p.constant, true],
    ['attribute', p.attribute],
    ['parameter.named', p.namedArg],
    ['type', p.type],
    ['keyword', p.keyword],
    ['metatag', p.keyword],
    ['tag', p.tag],
  ];
  const hit = table.find(([prefix]) => t === prefix || t.startsWith(prefix + '.'));
  return hit ? { color: hit[1], italic: hit[2] } : { color: p.fg };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** PHP code colored with a scheme as HTML (for previews; Monaco's colorize only knows the current theme). */
export function schemePreview(scheme: string, code: string): string {
  const p = schemeOf(scheme);
  const lines = code.split('\n');
  const tokens = monaco.editor.tokenize(code, 'php');
  return lines
    .map((line, i) => {
      const row = tokens[i] ?? [];
      return row
        .map((tok, j) => {
          const text = line.slice(tok.offset, row[j + 1]?.offset ?? line.length);
          if (!text) return '';
          const { color, italic } = colorOf(p, tok.type);
          return `<span style="color:${color}${italic ? ';font-style:italic' : ''}">${escapeHtml(text)}</span>`;
        })
        .join('');
    })
    .join('\n');
}

// Registers Monaco providers once per page: reload fully instead of registering them twice on hot update.
import.meta.hot?.dispose(() => location.reload());

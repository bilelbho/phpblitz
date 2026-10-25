// Code block colors: the app's Blitz Dark and Classic Light editor schemes (src/editor/themes.ts).
import type { ThemeRegistration } from 'shiki';

interface Palette {
  bg: string;
  fg: string;
  keyword: string;
  string: string;
  variable: string;
  number: string;
  comment: string;
  docComment: string;
  func: string;
  attribute: string;
  tag: string;
}

function theme(name: string, type: 'dark' | 'light', p: Palette): ThemeRegistration {
  return {
    name,
    type,
    colors: { 'editor.background': p.bg, 'editor.foreground': p.fg },
    tokenColors: [
      { settings: { foreground: p.fg } },
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: p.comment } },
      { scope: ['comment.block.documentation', 'comment.block.documentation punctuation'], settings: { foreground: p.docComment } },
      { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'constant.language', 'support.type.primitive', 'keyword.operator.new', 'punctuation.section.embedded'], settings: { foreground: p.keyword } },
      { scope: ['keyword.operator', 'punctuation'], settings: { foreground: p.fg } },
      { scope: ['string', 'string.quoted', 'punctuation.definition.string'], settings: { foreground: p.string } },
      { scope: ['constant.character.escape'], settings: { foreground: p.keyword } },
      { scope: ['variable', 'variable.other.property', 'support.variable', 'variable.other.constant'], settings: { foreground: p.variable } },
      { scope: ['variable.parameter', 'variable.other.readwrite'], settings: { foreground: p.fg } },
      { scope: ['constant.numeric'], settings: { foreground: p.number } },
      { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: p.func } },
      { scope: ['entity.name.type', 'entity.name.class', 'support.class', 'entity.other.inherited-class'], settings: { foreground: p.fg } },
      { scope: ['meta.attribute', 'entity.other.attribute-name'], settings: { foreground: p.attribute } },
      { scope: ['entity.name.tag', 'support.type.property-name.json'], settings: { foreground: p.tag } },
      { scope: ['markup.heading'], settings: { foreground: p.keyword, fontStyle: 'bold' } },
    ],
  };
}

export const blitzDark = theme('blitz-dark', 'dark', {
  bg: '#1E1F22',
  fg: '#BCBEC4',
  keyword: '#CF8E6D',
  string: '#6AAB73',
  variable: '#C77DBB',
  number: '#2AACB8',
  comment: '#7A7E85',
  docComment: '#5F826B',
  func: '#56A8F5',
  attribute: '#B3AE60',
  tag: '#D5B778',
});

export const blitzLight = theme('blitz-light', 'light', {
  bg: '#FFFFFF',
  fg: '#080808',
  keyword: '#0033B3',
  string: '#067D17',
  variable: '#871094',
  number: '#1750EB',
  comment: '#8C8C8C',
  docComment: '#8C8C8C',
  func: '#00627A',
  attribute: '#9E880D',
  tag: '#0033B3',
});

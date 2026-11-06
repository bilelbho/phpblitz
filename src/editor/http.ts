// .http / .rest files (the HTTP Client): ### separators, comments and # @options, @variables,
// the request line, headers, {{variables}} and the body (JSON colored as JSON).

import * as monaco from 'monaco-editor';

monaco.languages.register({ id: 'http', aliases: ['HTTP Request', 'http'], extensions: ['.http', '.rest'] });

monaco.languages.setLanguageConfiguration('http', {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
});

const METHOD = /(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b/;
const VARIABLE = /\{\{[^{}]*\}\}/;

monaco.languages.setMonarchTokensProvider('http', {
  defaultToken: '',
  tokenizer: {
    // Before the request line: separators, comments, options, variables.
    root: [
      [/^###.*$/, 'keyword.separator'],
      [/^\s*(#|\/\/)\s*@[\w-]+.*$/, 'annotation'],
      [/^\s*(#|\/\/).*$/, 'comment'],
      [/^(@[\w.-]+)(\s*=\s*)(.*)$/, ['variable', 'delimiter', 'string']],
      [new RegExp(`^\\s*${METHOD.source}`), { token: 'keyword', next: '@url' }],
      [/^\s*(https?:\/\/|\{\{)/, { token: 'string.link', next: '@url' }],
    ],
    url: [
      [VARIABLE, 'variable'],
      [/\s+HTTP\/[\d.]+\s*$/, { token: 'keyword', next: '@headers' }],
      [/[^\s{]+|\{/, 'string.link'],
      [/\s+/, ''],
      [/$/, { token: '', next: '@headers' }],
    ],
    headers: [
      [/^\s+[?&].*$/, 'string.link'],
      [/^###.*$/, { token: 'keyword.separator', next: '@root' }],
      [/^\s*(#|\/\/).*$/, 'comment'],
      [/^\s*$/, { token: '', next: '@body' }],
      [/^([\w-]+)(\s*:\s*)/, ['attribute.name', 'delimiter']],
      [VARIABLE, 'variable'],
      [/[^{]+|\{/, 'attribute.value'],
    ],
    body: [
      [/^###.*$/, { token: 'keyword.separator', next: '@root' }],
      [/^<\s+\S.*$/, 'string.link'],
      [/^>\s.*$/, 'comment'],
      [VARIABLE, 'variable'],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'attribute.name'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
      [/\b(true|false|null)\b/, 'keyword'],
      [/[{}[\],:]/, 'delimiter'],
      [/[^"{}[\],:\d\s]+|\s+/, ''],
    ],
  },
});

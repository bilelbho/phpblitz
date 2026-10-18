// .env files (Laravel, Symfony, Docker): `KEY=value`, comments, `export`, quoted values with
// escapes and ${VAR} references. A value is one string whatever it contains (digits in a secret are
// not numbers).

import * as monaco from 'monaco-editor';

monaco.languages.register({ id: 'dotenv', aliases: ['.env', 'dotenv'], filenamePatterns: ['.env', '.env.*'] });

monaco.languages.setLanguageConfiguration('dotenv', {
  comments: { lineComment: '#' },
  autoClosingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '${', close: '}' },
  ],
});

const VARIABLE = /\$\{[^}]*\}|\$[A-Za-z_]\w*/;

monaco.languages.setMonarchTokensProvider('dotenv', {
  defaultToken: '',
  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],
      [/^(\s*)(export)(\s+)([A-Za-z_][\w.-]*)(\s*)(=)/, ['', 'keyword', '', 'constant', '', 'delimiter']],
      [/^(\s*)([A-Za-z_][\w.-]*)(\s*)(=)/, ['', 'constant', '', 'delimiter']],
      // Values. Double-quoted ones may span lines; their state carries over.
      [/"/, { token: 'string', next: '@double' }],
      [/'[^']*'?/, 'string'],
      [VARIABLE, 'variable'],
      [/\s+#.*$/, 'comment'],
      [/[^\s"'$#]+/, 'string'],
      [/\s+/, ''],
      [/[$#]/, 'string'],
    ],
    double: [
      [/\\[\\"$nrt]/, 'string.escape'],
      [VARIABLE, 'variable'],
      [/"/, { token: 'string', next: '@pop' }],
      [/[^"\\$]+|[\\$]/, 'string'],
    ],
  },
});

import.meta.hot?.dispose(() => location.reload());

// PHP highlighting closer to PhpStorm's than Monaco's built-in grammar: method calls, properties,
// named arguments, #[Attributes], PHPDoc tags and declarations get their own tokens.

import * as monaco from 'monaco-editor';

const keywords = [
  'abstract', 'and', 'as', 'break', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'declare', 'default', 'do',
  'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'enum',
  'eval', 'exit', 'die', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if',
  'implements', 'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset', 'list', 'match', 'namespace',
  'new', 'or', 'print', 'private', 'protected', 'public', 'readonly', 'require', 'require_once', 'return', 'static',
  'switch', 'throw', 'trait', 'try', 'unset', 'use', 'var', 'while', 'xor', 'yield', 'from',
  // Types and literals, colored like keywords in PhpStorm.
  'int', 'float', 'string', 'bool', 'array', 'object', 'mixed', 'void', 'never', 'null', 'iterable', 'callable',
  'self', 'parent', 'true', 'false', 'TRUE', 'FALSE', 'NULL',
];

const language: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.php',
  keywords,
  tokenizer: {
    // Outside <?php … ?>: HTML, kept simple.
    root: [
      [/<\?(php|=)?/, { token: 'metatag', next: '@php' }],
      [/<\/?[a-zA-Z][\w-]*/, 'tag'],
      [/\/?>/, 'tag'],
      [/[^<>]+/, ''],
      [/[<>]/, ''],
    ],
    php: [
      [/\?>/, { token: 'metatag', next: '@pop' }],
      { include: '@code' },
    ],
    code: [
      { include: '@whitespace' },
      [/#\[/, { token: 'attribute', next: '@attribute' }],

      // Declarations
      [/(function)(\s+)(&?)([a-zA-Z_]\w*)/, ['keyword', '', 'operator', 'function.declaration']],
      [/(class|interface|trait|enum)(\s+)([a-zA-Z_]\w*)/, ['keyword', '', 'type.declaration']],
      [/(const)(\s+)([a-zA-Z_]\w*)(?=\s*=)/, ['keyword', '', 'constant']],
      [/(new|extends|implements|instanceof|insteadof)(\s+)(\\?[A-Za-z_][\w\\]*)/, ['keyword', '', 'type']],

      // Members: ->method(), ->property, ::method(), ::$static, ::CONSTANT
      [/(\??->)(\s*)([a-zA-Z_]\w*)(?=\s*\()/, ['operator', '', 'function']],
      [/(\??->)(\s*)([a-zA-Z_]\w*)/, ['operator', '', 'property']],
      [/(::)(class)\b/, ['operator', 'keyword']],
      [/(::)([a-zA-Z_]\w*)(?=\s*\()/, ['operator', 'function.static']],
      [/(::)(\$[a-zA-Z_]\w*)/, ['operator', 'variable.static']],
      [/(::)([a-zA-Z_]\w*)/, ['operator', 'constant']],

      [/\$this\b/, 'variable.this'],
      [/\$[a-zA-Z_]\w*/, 'variable'],

      // Named arguments: foo(name: 'x')
      [/([a-z_]\w*)(:)(?!:)/, [{ cases: { '@keywords': 'keyword', '@default': 'parameter.named' } }, { cases: { '$1@keywords': 'delimiter', '@default': 'parameter.named' } }]],

      // Calls and names
      [/\\?[a-zA-Z_][\w\\]*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'function' } }],
      [/\\?[a-zA-Z_][\w\\]*/, { cases: { '@keywords': 'keyword', '[A-Z][A-Z0-9_]+': 'constant', '[A-Z\\\\].*': 'type', '@default': 'identifier' } }],

      // Literals
      [/0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?/, 'number'],
      [/'/, { token: 'string', next: '@singleQuoted' }],
      [/"/, { token: 'string', next: '@doubleQuoted' }],
      [/<<<\s*'([A-Za-z_]\w*)'/, { token: 'string', next: '@nowdoc.$1' }],
      [/<<<\s*"?([A-Za-z_]\w*)"?/, { token: 'string', next: '@heredoc.$1' }],

      [/[{}()[\]]/, 'delimiter'],
      [/[;,.]/, 'delimiter'],
      [/[=!<>+\-*/%&|^~?:@]+/, 'operator'],
    ],
    whitespace: [
      [/\s+/, ''],
      [/\/\*\*(?!\/)/, { token: 'comment.doc', next: '@docComment' }],
      [/\/\*/, { token: 'comment', next: '@blockComment' }],
      [/(\/\/|#(?!\[)).*?(?=\?>|$)/, 'comment'],
    ],
    docComment: [
      [/\*\//, { token: 'comment.doc', next: '@pop' }],
      [/@[a-zA-Z][\w-]*/, 'comment.doc.tag'],
      [/[^@*]+/, 'comment.doc'],
      [/./, 'comment.doc'],
    ],
    blockComment: [
      [/\*\//, { token: 'comment', next: '@pop' }],
      [/[^*]+/, 'comment'],
      [/./, 'comment'],
    ],
    // #[Route('/', name: 'app')]: the attribute's name and brackets, its arguments as code.
    attribute: [
      [/\]/, { token: 'attribute', next: '@pop' }],
      [/\(/, { token: 'attribute', next: '@attributeArgs' }],
      [/\\?[A-Za-z_][\w\\]*/, 'attribute'],
      [/,/, 'delimiter'],
      [/\s+/, ''],
    ],
    attributeArgs: [
      [/\)/, { token: 'attribute', next: '@pop' }],
      [/\(/, { token: 'delimiter', next: '@parens' }],
      { include: '@code' },
    ],
    parens: [
      [/\)/, { token: 'delimiter', next: '@pop' }],
      [/\(/, { token: 'delimiter', next: '@push' }],
      { include: '@code' },
    ],
    singleQuoted: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, { token: 'string', next: '@pop' }],
    ],
    doubleQuoted: [
      [/[^\\"$]+/, 'string'],
      [/\\./, 'string.escape'],
      [/\$[a-zA-Z_]\w*/, 'variable'],
      [/\$/, 'string'],
      [/"/, { token: 'string', next: '@pop' }],
    ],
    heredoc: [
      [/^\s*([A-Za-z_]\w*)\b/, { cases: { '$1==$S2': { token: 'string', next: '@pop' }, '@default': 'string' } }],
      [/\$[a-zA-Z_]\w*/, 'variable'],
      [/[^$]+/, 'string'],
      [/./, 'string'],
    ],
    nowdoc: [
      [/^\s*([A-Za-z_]\w*)\b/, { cases: { '$1==$S2': { token: 'string', next: '@pop' }, '@default': 'string' } }],
      [/.+/, 'string'],
    ],
  },
};

let installed: monaco.IDisposable | null = null;
const install = () => {
  installed?.dispose();
  installed = monaco.languages.setMonarchTokensProvider('php', language);
};

// Monaco loads its own PHP grammar the first time a PHP file opens; ours goes in after it.
install();
monaco.languages.onLanguage('php', () => {
  import('monaco-editor/esm/vs/basic-languages/php/php.js').then(() => setTimeout(install, 0)).catch(() => setTimeout(install, 0));
});

// Registers Monaco providers once per page: reload fully instead of registering them twice on hot update.
import.meta.hot?.dispose(() => location.reload());

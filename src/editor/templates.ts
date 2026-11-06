// Live templates and postfix completion for PHP. A live template is an abbreviation that becomes
// code: `fore` + Tab → a foreach to fill in. A postfix template turns the expression before it into
// code: `$items.fore` + Tab → foreach ($items as $item). Both are offered in the completion list too.
// The template format is Surround With's (editor/surround.ts): $NAME$ / $NAME:default$ fields,
// $END$ for the caret; postfix templates have $EXPR$ for the expression.

import { fields } from './surround';

export interface LiveTemplate {
  abbr: string;
  description: string;
  body: string;
}

export const BUILTIN_LIVE: LiveTemplate[] = [
  { abbr: 'fore', description: 'foreach (…) { }', body: 'foreach ($$ITEMS:items$ as $$ITEM:item$) {\n    $END$\n}' },
  { abbr: 'forek', description: 'foreach (… as $key => $value) { }', body: 'foreach ($$ITEMS:items$ as $$KEY:key$ => $$VALUE:value$) {\n    $END$\n}' },
  { abbr: 'fori', description: 'for ($i = 0; …; $i++) { }', body: 'for ($$I:i$ = 0; $$I$ < $COUNT$; $$I$++) {\n    $END$\n}' },
  { abbr: 'ifn', description: 'if (… === null) { }', body: 'if ($$VAR:var$ === null) {\n    $END$\n}' },
  { abbr: 'pubf', description: 'public function', body: 'public function $NAME$($PARAMETERS:$)$RETURN:$\n{\n    $END$\n}' },
  { abbr: 'prof', description: 'protected function', body: 'protected function $NAME$($PARAMETERS:$)$RETURN:$\n{\n    $END$\n}' },
  { abbr: 'prif', description: 'private function', body: 'private function $NAME$($PARAMETERS:$)$RETURN:$\n{\n    $END$\n}' },
  { abbr: 'pubsf', description: 'public static function', body: 'public static function $NAME$($PARAMETERS:$)$RETURN:$\n{\n    $END$\n}' },
  { abbr: 'prisf', description: 'private static function', body: 'private static function $NAME$($PARAMETERS:$)$RETURN:$\n{\n    $END$\n}' },
  { abbr: 'con', description: 'constructor', body: 'public function __construct($PARAMETERS:$)\n{\n    $END$\n}' },
  { abbr: 'pubp', description: 'public property', body: 'public $TYPE:string$ $$NAME:name$;' },
  { abbr: 'prop', description: 'protected property', body: 'protected $TYPE:string$ $$NAME:name$;' },
  { abbr: 'prip', description: 'private property', body: 'private $TYPE:string$ $$NAME:name$;' },
  { abbr: 'const', description: 'class constant', body: 'public const $NAME:NAME$ = $VALUE:null$;' },
  { abbr: 'test', description: 'test method', body: 'public function test$NAME:Something$(): void\n{\n    $END$\n}' },
  { abbr: 'thr', description: 'throw new …', body: "throw new $EXCEPTION:\\RuntimeException$('$MESSAGE$');" },
  { abbr: 'sw', description: 'switch (…) { }', body: 'switch ($$VALUE:value$) {\n    case $CASE$:\n        $END$\n        break;\n}' },
  { abbr: 'match', description: 'match (…) { }', body: 'match ($$VALUE:value$) {\n    $CASE$ => $END$,\n    default => null,\n}' },
  { abbr: 'eco', description: 'echo …;', body: 'echo $END$;' },
  { abbr: 'vd', description: 'var_dump(…);', body: 'var_dump($END$);' },
  { abbr: 'pr', description: 'print_r(…);', body: 'print_r($END$);' },
  { abbr: 'rqr', description: 'require_once …;', body: "require_once __DIR__ . '/$FILE$';" },
  { abbr: 'strict', description: 'declare(strict_types=1);', body: 'declare(strict_types=1);' },
];

export interface PostfixTemplate {
  key: string;
  description: string;
  body: string;
}

export const BUILTIN_POSTFIX: PostfixTemplate[] = [
  { key: 'if', description: 'if (expr) { }', body: 'if ($EXPR$) {\n    $END$\n}' },
  { key: 'else', description: 'if (!expr) { }', body: 'if (!$EXPR$) {\n    $END$\n}' },
  { key: 'nn', description: 'if (expr !== null) { }', body: 'if ($EXPR$ !== null) {\n    $END$\n}' },
  { key: 'null', description: 'if (expr === null) { }', body: 'if ($EXPR$ === null) {\n    $END$\n}' },
  { key: 'isset', description: 'if (isset(expr)) { }', body: 'if (isset($EXPR$)) {\n    $END$\n}' },
  { key: 'empty', description: 'if (empty(expr)) { }', body: 'if (empty($EXPR$)) {\n    $END$\n}' },
  { key: 'fore', description: 'foreach (expr as $item) { }', body: 'foreach ($EXPR$ as $$ITEM:item$) {\n    $END$\n}' },
  { key: 'forek', description: 'foreach (expr as $key => $value) { }', body: 'foreach ($EXPR$ as $$KEY:key$ => $$VALUE:value$) {\n    $END$\n}' },
  { key: 'return', description: 'return expr;', body: 'return $EXPR$;' },
  { key: 'var', description: '$name = expr;', body: '$$NAME:value$ = $EXPR$;' },
  { key: 'echo', description: 'echo expr;', body: 'echo $EXPR$;' },
  { key: 'throw', description: 'throw expr;', body: 'throw $EXPR$;' },
  { key: 'not', description: '!expr', body: '!$EXPR$' },
  { key: 'par', description: '(expr)', body: '($EXPR$)' },
  { key: 'count', description: 'count(expr)', body: 'count($EXPR$)' },
  { key: 'new', description: 'new Expr()', body: 'new $EXPR$($END$)' },
];

/** The templates in use: the built-in ones not turned off, then the user's (theirs win on the same abbreviation). */
export function liveTemplates(custom: LiveTemplate[], hidden: string[]): LiveTemplate[] {
  const own = custom.filter((t) => /^[\w-]+$/.test(t.abbr) && t.body.trim());
  const mine = new Set(own.map((t) => t.abbr));
  return [...BUILTIN_LIVE.filter((t) => !hidden.includes(t.abbr) && !mine.has(t.abbr)), ...own];
}

/**
 * A template as a Monaco snippet inserted at the caret: indented 4 spaces (or a tab) per level, in
 * the editor's `unit` (Monaco indents the lines after the first as the caret's line). `expr`: the
 * text of $EXPR$ (postfix templates).
 */
export function templateSnippet(body: string, unit: string, expr = ''): string {
  const numbers = new Map<string, number>();
  return body
    .split('\n')
    .map((line) => {
      const own = /^\s*/.exec(line)![0];
      const levels = unit.repeat(Math.floor(own.replace(/\t/g, '    ').length / 4));
      return levels + fields(line.slice(own.length).replace(/\$EXPR\$/g, '$SELECTION$'), expr, numbers);
    })
    .join('\n');
}

/**
 * The expression that ends right before `end` in this code ($user->posts()[0], self::all(),
 * strtoupper($s)), and where it starts; null when there's none.
 */
export function expressionBefore(code: string, end: number): { text: string; start: number } | null {
  let i = end;
  const skipBack = (open: string, close: string) => {
    let depth = 0;
    for (; i > 0; i--) {
      const c = code[i - 1];
      if (c === close) depth++;
      else if (c === open && --depth === 0) {
        i--;
        return true;
      }
    }
    return false;
  };
  for (;;) {
    const c = code[i - 1];
    if (c === ')' || c === ']') {
      if (!(c === ')' ? skipBack('(', ')') : skipBack('[', ']'))) return null;
    } else if (c && /[\w\\]/.test(c)) {
      while (i > 0 && /[\w\\]/.test(code[i - 1])) i--;
      if (code[i - 1] === '$') i--;
    } else break;
    // Joined to what's before by -> ?-> ::, or a call / index / name directly after a name.
    if (code.slice(i - 3, i) === '?->') i -= 3;
    else if (code.slice(i - 2, i) === '->' || code.slice(i - 2, i) === '::') i -= 2;
    else if (!/[)\]\w$]/.test(code[i - 1] ?? '') || !/[([]/.test(code[i] ?? '')) break;
  }
  const text = code.slice(i, end);
  // A variable, or a name that's called or used with ::. Not a number, not a lone keyword.
  if (!text || /^\d/.test(text) || !(/^\$\w/.test(text) || /[(:]/.test(text))) return null;
  return { text, start: i };
}

/**
 * Is `offset` in PHP code (not in a string, a comment, or the HTML around <?php ?>)? A quick scan
 * from the start of the file: good enough for deciding what Tab does.
 */
export function inPhpCode(text: string, offset: number): boolean {
  let php = false;
  for (let i = 0; i < offset; i++) {
    if (!php) {
      const open = text.indexOf('<?', i);
      if (open < 0 || open >= offset) return false;
      php = true;
      i = open + (text.startsWith('<?php', open) ? 4 : text.startsWith('<?=', open) ? 2 : 1);
      continue;
    }
    const c = text[i];
    if (c === '?' && text[i + 1] === '>') {
      php = false;
      i++;
    } else if (c === "'" || c === '"' || c === '`') {
      const close = findClose(text, i, c);
      if (close < 0 || close >= offset) return false;
      i = close;
    } else if ((c === '/' && text[i + 1] === '/') || c === '#') {
      if (c === '#' && text[i + 1] === '[') continue; // an attribute #[…]
      const nl = text.indexOf('\n', i);
      if (nl < 0 || nl >= offset) return false;
      i = nl;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close + 2 > offset) return false;
      i = close + 1;
    }
  }
  return php;
}

/** In an HTML part of a PHP file (outside <?php … ?>)? */
export function inHtmlOfPhp(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  const open = Math.max(before.lastIndexOf('<?php'), before.lastIndexOf('<?='));
  return open < 0 || before.lastIndexOf('?>') > open;
}

function findClose(text: string, from: number, quote: string): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

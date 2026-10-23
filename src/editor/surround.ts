// Surround With (Ctrl+Alt+T) templates: the built-in ones, and how a template becomes a Monaco
// snippet around the selected code. The template format, the same for the user's own templates
// (Settings ▸ Editor ▸ Surround With):
//   $SELECTION$         the selected code: on a line of its own, the selected lines, indented as that
//                       line is; inside a line, the selection (or the word at the caret)
//   $NAME$, $NAME:x$    a field to fill in, Tab to the next one (x: what it starts with); the same
//                       name twice is the same field
//   $END$               where the caret ends up
// Everything else is text, PHP variables included ($item). Indent with 4 spaces or a tab: it
// becomes the editor's indentation.

export interface SurroundTemplate {
  label: string;
  body: string;
}

export const BUILTIN_SURROUND: SurroundTemplate[] = [
  { label: 'if', body: 'if ($CONDITION$) {\n    $SELECTION$\n}' },
  { label: 'if / else', body: 'if ($CONDITION$) {\n    $SELECTION$\n} else {\n    $END$\n}' },
  { label: 'while', body: 'while ($CONDITION$) {\n    $SELECTION$\n}' },
  { label: 'do / while', body: 'do {\n    $SELECTION$\n} while ($CONDITION$);' },
  { label: 'for', body: 'for ($$I:i$ = 0; $$I$ < $COUNT$; $$I$++) {\n    $SELECTION$\n}' },
  { label: 'foreach', body: 'foreach ($$ITEMS:items$ as $$ITEM:item$) {\n    $SELECTION$\n}' },
  { label: 'foreach with key', body: 'foreach ($$ITEMS:items$ as $$KEY:key$ => $$VALUE:value$) {\n    $SELECTION$\n}' },
  { label: 'try / catch', body: 'try {\n    $SELECTION$\n} catch ($EXCEPTION:\\Throwable$ $$E:e$) {\n    $END$\n}' },
  { label: 'try / finally', body: 'try {\n    $SELECTION$\n} finally {\n    $END$\n}' },
  { label: 'try / catch / finally', body: 'try {\n    $SELECTION$\n} catch ($EXCEPTION:\\Throwable$ $$E:e$) {\n    $CATCH$\n} finally {\n    $END$\n}' },
  { label: 'switch', body: 'switch ($VALUE$) {\n    case $CASE$:\n        $SELECTION$\n        break;\n}' },
  { label: 'function', body: 'function ($PARAMETERS$) {\n    $SELECTION$\n}' },
  { label: 'region', body: '// region $NAME$\n$SELECTION$\n// endregion' },
  { label: '/* comment */', body: '/*\n$SELECTION$\n*/' },
  { label: '( )', body: '($SELECTION$)' },
  { label: '[ ]', body: '[$SELECTION$]' },
  { label: "' '", body: "'$SELECTION$'" },
  { label: '" "', body: '"$SELECTION$"' },
  { label: 'isset()', body: 'isset($SELECTION$)' },
  { label: 'empty()', body: 'empty($SELECTION$)' },
  { label: 'count()', body: 'count($SELECTION$)' },
  { label: 'fn() =>', body: 'fn($PARAMETERS$) => $SELECTION$' },
  { label: '<?php ?>', body: '<?php $SELECTION$ ?>' },
];

/** The templates Surround With offers: the built-in ones not hidden, then the user's. */
export function surroundTemplates(custom: SurroundTemplate[], hidden: string[]): SurroundTemplate[] {
  return [...BUILTIN_SURROUND.filter((t) => !hidden.includes(t.label)), ...custom.filter((t) => t.label.trim() && t.body.includes('$SELECTION$'))];
}

/** The key that picks the n-th template in the popup: 1–9, 0, then a–z. */
export function surroundKey(n: number): string | undefined {
  return '1234567890abcdefghijklmnopqrstuvwxyz'[n];
}

/** A template that wraps text inside a line ("( )"), not whole lines ("if"). */
export function isInline(body: string): boolean {
  return !body.split('\n').some((l) => l.trim() === '$SELECTION$');
}

/** Text as snippet text: $ and \ escaped, and } too inside a field's initial value. */
const escapeSnippet = (s: string, inField = false) => s.replace(inField ? /[\\$}]/g : /[\\$]/g, (c) => `\\${c}`);
const FIELD = /\$([A-Z][A-Z0-9_]*)(?::([^$\n]*))?\$/g;

/** One template line as snippet text: fields numbered by name (shared across lines). */
function fields(text: string, selection: string, numbers: Map<string, number>): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(FIELD)) {
    out += escapeSnippet(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const [, name, initial] = m;
    if (name === 'SELECTION') out += escapeSnippet(selection);
    else if (name === 'END') out += '$0';
    else if (numbers.has(name)) out += `$${numbers.get(name)}`;
    else {
      numbers.set(name, numbers.size + 1);
      out += `\${${numbers.get(name)}:${escapeSnippet(initial ?? name.toLowerCase(), true)}}`;
    }
  }
  return out + escapeSnippet(text.slice(last));
}

/**
 * The snippet that replaces the selection. `selected`: the selected text (whole lines for a block
 * template); `indent`: the first selected line's indentation; `unit`: one level of the editor's.
 */
export function surroundSnippet(body: string, selected: string, indent: string, unit: string): string {
  const numbers = new Map<string, number>();
  if (isInline(body)) return body.split('\n').map((l) => fields(l, selected, numbers)).join('\n');
  // The selected lines without their common indentation; each template line's own (4 spaces or a
  // tab per level) in the editor's unit.
  const lines = selected.split(/\r?\n/);
  const common = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), Infinity);
  const levels = (ws: string) => unit.repeat(Math.floor(ws.replace(/\t/g, '    ').length / 4));
  return body
    .split('\n')
    .map((line) => {
      const own = /^\s*/.exec(line)![0];
      const rest = line.slice(own.length);
      if (rest.trim() === '$SELECTION$') {
        return lines.map((l) => (l.trim() ? escapeSnippet(indent + levels(own) + l.slice(Number.isFinite(common) ? common : 0)) : '')).join('\n');
      }
      return indent + levels(own) + fields(rest, '', numbers);
    })
    .join('\n');
}

// Editing actions Monaco doesn't have: Move Statement Up/Down (whole blocks, never out of the
// block they're in), Toggle Case, Surround With, and Previous/Next Method.

import * as monaco from 'monaco-editor';
import { structureOf } from '../php';

type Editor = monaco.editor.ICodeEditor;

const isDecoration = (text: string) => /^\s*(#\[|\/\*\*|\*|\*\/|\/\/)/.test(text);

/** The line of the bracket matching the one at (line, column), if any. */
function matchLine(model: monaco.editor.ITextModel, line: number, column: number): number | null {
  // Not in Monaco's typings, but every text model has it.
  const pairs = (model as unknown as { bracketPairs: { matchBracket(p: monaco.IPosition): [monaco.Range, monaco.Range] | null } }).bracketPairs;
  const pair = pairs.matchBracket({ lineNumber: line, column });
  if (!pair) return null;
  const [a, b] = pair;
  return a.startLineNumber === line ? b.startLineNumber : a.startLineNumber;
}

/** The lines of the statement on `line`: a block from its first line to its closing brace, with its doc comment and attributes. */
function unitAt(model: monaco.editor.ITextModel, line: number): { start: number; end: number } {
  const text = model.getLineContent(line);
  let start = line;
  let end = line;
  // A line that opens a block (its last bracket is an opener): to the closing one.
  const open = text.trimEnd();
  if (/[{[(]$/.test(open)) {
    const close = matchLine(model, line, open.length);
    if (close && close > line) end = close;
  } else if (/^\s*[}\])]/.test(text)) {
    // A closing line: the block it closes.
    const opener = matchLine(model, line, text.search(/\S/) + 1);
    if (opener && opener < line) start = opener;
  } else if (line < model.getLineCount() && /^\s*\{\s*$/.test(model.getLineContent(line + 1))) {
    // A declaration with its brace on the next line.
    const close = matchLine(model, line + 1, model.getLineContent(line + 1).indexOf('{') + 1);
    if (close) end = close;
  }
  while (start > 1 && isDecoration(model.getLineContent(start - 1))) start--;
  return { start, end };
}

/** Moves the statement (or the selected lines) at the caret past its neighbour, staying in its block. */
export function moveStatement(editor: Editor, dir: -1 | 1) {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;
  const unit = sel.isEmpty() ? unitAt(model, sel.startLineNumber) : { start: sel.startLineNumber, end: sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber };
  // Blank lines between statements belong to neither: the neighbour is the next non-blank line.
  const step = (line: number) => {
    let l = line;
    while (l >= 1 && l <= model.getLineCount() && !model.getLineContent(l).trim()) l += dir;
    return l;
  };
  const near = step(dir < 0 ? unit.start - 1 : unit.end + 1);
  if (near < 1 || near > model.getLineCount()) return;
  const nearText = model.getLineContent(near);
  // The edge of the enclosing block: the statement stays inside it.
  if ((dir < 0 && /[{[(]\s*$/.test(nearText)) || (dir > 0 && /^\s*[}\])]/.test(nearText))) return;
  // Below: a doc comment or attributes belong to the statement after them.
  let head = near;
  while (dir > 0 && head < model.getLineCount() && isDecoration(model.getLineContent(head))) head++;
  const other = unitAt(model, head);
  const [first, second] = dir < 0 ? [other, unit] : [unit, other];
  const eol = model.getEOL();
  const lines = (r: { start: number; end: number }) => model.getValueInRange(new monaco.Range(r.start, 1, r.end, model.getLineMaxColumn(r.end)));
  const gap = first.end + 1 <= second.start - 1 ? model.getValueInRange(new monaco.Range(first.end + 1, 1, second.start - 1, model.getLineMaxColumn(second.start - 1))) + eol : '';
  const swapped = lines(second) + eol + gap + lines(first);
  const range = new monaco.Range(first.start, 1, second.end, model.getLineMaxColumn(second.end));
  // Where the moved statement's lines land: the selection moves with it.
  const moved = dir < 0 ? first.start - unit.start : second.end - unit.end;
  editor.pushUndoStop();
  editor.executeEdits('moveStatement', [{ range, text: swapped }], () =>
    editor.getSelections()!.map((s) => new monaco.Selection(s.selectionStartLineNumber + moved, s.selectionStartColumn, s.positionLineNumber + moved, s.positionColumn)),
  );
  editor.pushUndoStop();
  editor.revealLine(dir < 0 ? first.start : second.end);
}

/** Lowercase when every selected letter is uppercase, uppercase otherwise (the word at the caret without a selection). */
export function toggleCase(editor: Editor) {
  const model = editor.getModel();
  const selections = editor.getSelections();
  if (!model || !selections) return;
  const ranges = selections.map((s) => {
    if (!s.isEmpty()) return s;
    const w = model.getWordAtPosition(s.getPosition());
    return w ? new monaco.Range(s.startLineNumber, w.startColumn, s.startLineNumber, w.endColumn) : s;
  });
  const text = ranges.map((r) => model.getValueInRange(r)).join('');
  const upper = text === text.toUpperCase();
  editor.pushUndoStop();
  editor.executeEdits(
    'toggleCase',
    ranges.map((r) => {
      const t = model.getValueInRange(r);
      return { range: r, text: upper ? t.toLowerCase() : t.toUpperCase() };
    }),
    ranges.map((r) => new monaco.Selection(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn)),
  );
  editor.pushUndoStop();
}

/** Surround With templates: `$SEL` is the selected lines, `$0` where the caret goes after. */
export const SURROUND_TEMPLATES: { label: string; key: string; body: string }[] = [
  { label: 'if', key: '1', body: 'if (${1:true}) {\n$SEL\n}' },
  { label: 'if / else', key: '2', body: 'if (${1:true}) {\n$SEL\n} else {\n\t$0\n}' },
  { label: 'while', key: '3', body: 'while (${1:true}) {\n$SEL\n}' },
  { label: 'do / while', key: '4', body: 'do {\n$SEL\n} while (${1:true});' },
  { label: 'for', key: '5', body: 'for (\\$${1:i} = 0; \\$$1 < ${2:count}; \\$$1++) {\n$SEL\n}' },
  { label: 'foreach', key: '6', body: 'foreach (\\$${1:items} as \\$${2:item}) {\n$SEL\n}' },
  { label: 'try / catch', key: '7', body: 'try {\n$SEL\n} catch (${1:\\\\Throwable} \\$${2:e}) {\n\t$0\n}' },
  { label: 'try / finally', key: '8', body: 'try {\n$SEL\n} finally {\n\t$0\n}' },
  { label: 'try / catch / finally', key: '9', body: 'try {\n$SEL\n} catch (${1:\\\\Throwable} \\$${2:e}) {\n\t$3\n} finally {\n\t$0\n}' },
  { label: 'function', key: 'f', body: 'function (${1}) {\n$SEL\n}' },
  { label: '{ }', key: 'b', body: '{\n$SEL\n}' },
  { label: '( )', key: 'p', body: '($SEL_INLINE)' },
  { label: '" "', key: 'q', body: '"$SEL_INLINE"' },
];

const snippetEscape = (s: string) => s.replace(/[\\$}]/g, (c) => `\\${c}`);

/** Surrounds the selected lines (the caret line without a selection) with a template, as a snippet. */
export function surroundWith(editor: Editor, body: string) {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;
  const inline = body.includes('$SEL_INLINE');
  let range: monaco.Range;
  if (inline) {
    range = sel.isEmpty() ? (() => {
      const w = model.getWordAtPosition(sel.getPosition());
      return w ? new monaco.Range(sel.startLineNumber, w.startColumn, sel.startLineNumber, w.endColumn) : sel;
    })() : sel;
  } else {
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    range = new monaco.Range(sel.startLineNumber, 1, end, model.getLineMaxColumn(end));
  }
  const selected = model.getValueInRange(range);
  let snippet: string;
  if (inline) {
    snippet = body.replace('$SEL_INLINE', snippetEscape(selected));
  } else {
    // The template at the first line's indentation, the lines one level deeper.
    const indent = /^\s*/.exec(model.getLineContent(range.startLineNumber))![0];
    const unit = model.getOptions().insertSpaces ? ' '.repeat(model.getOptions().indentSize) : '\t';
    const inner = selected
      .split(/\r?\n/)
      .map((l) => (l.trim() ? unit + l.slice(Math.min(indent.length, /^\s*/.exec(l)![0].length)) : ''))
      .join('\n');
    snippet = body
      .split('\n')
      .map((l) => (l === '$SEL' ? inner.split('\n').map((x) => (x ? indent + x : x)).map(snippetEscape).join('\n') : indent + l.replace(/\t/g, unit)))
      .join('\n');
  }
  editor.setSelection(range);
  editor.focus();
  const controller = editor.getContribution('snippetController2') as unknown as { insert(template: string): void } | null;
  if (controller) controller.insert(snippet);
}

/** Moves the caret to the previous / next method or function declaration of the file. */
export function gotoMethod(editor: Editor, dir: -1 | 1) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return;
  const lines = structureOf(model.getValue())
    .filter((s) => s.kind === 'method' || s.kind === 'function')
    .map((s) => s.line)
    .sort((a, b) => a - b);
  const target = dir < 0 ? [...lines].reverse().find((l) => l < pos.lineNumber) : lines.find((l) => l > pos.lineNumber);
  if (!target) return;
  const text = model.getLineContent(target);
  const column = Math.max(1, text.search(/\S/) + 1);
  editor.setPosition({ lineNumber: target, column });
  editor.revealLineInCenterIfOutsideViewport(target);
}

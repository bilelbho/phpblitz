// Editing actions Monaco doesn't have: Move Statement Up/Down (whole blocks, never out of the
// block they're in), Toggle Case, Surround With (templates: surround.ts), and Previous/Next Method.

import * as monaco from 'monaco-editor';
import { structureOf } from '../php';
import { isInline, surroundSnippet } from './surround';

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

/** Surrounds the selected lines (the caret line without a selection) with a template (editor/surround.ts). */
export function surroundWith(editor: Editor, body: string) {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel) return;
  let range: monaco.Range;
  if (isInline(body)) {
    // The selection, or the word at the caret.
    const w = sel.isEmpty() ? model.getWordAtPosition(sel.getPosition()) : null;
    range = w ? new monaco.Range(sel.startLineNumber, w.startColumn, sel.startLineNumber, w.endColumn) : sel;
  } else {
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    range = new monaco.Range(sel.startLineNumber, 1, end, model.getLineMaxColumn(end));
  }
  const options = model.getOptions();
  const unit = options.insertSpaces ? ' '.repeat(options.indentSize) : '\t';
  const indent = /^\s*/.exec(model.getLineContent(range.startLineNumber))![0];
  const snippet = surroundSnippet(body, model.getValueInRange(range), indent, unit);
  editor.setSelection(range);
  editor.focus();
  const controller = editor.getContribution('snippetController2') as unknown as { insert(template: string): void } | null;
  controller?.insert(snippet);
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

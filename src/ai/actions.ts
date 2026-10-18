// The editor's AI actions: questions about the code at hand for the chat (Explain, Fix, Write
// tests, Add doc comments) and "Edit with AI": an instruction, then the change as a diff to accept.

import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { getSettings } from '../settings';
import { AiCancelled, stripFences, streamAi } from './client';
import { askAi, editorContext } from './chat';
import { contextLabel, describeContext } from './context';
import { setAiDialog, updateReview } from './review';

type Editor = monaco.editor.ICodeEditor;

export type ChatAction = 'explain' | 'fix' | 'tests' | 'docs';

function what(editor: Editor): string {
  const sel = editor.getSelection();
  return sel && !sel.isEmpty() ? 'the selected code' : 'this file';
}

/** Opens the chat and asks about the editor's file or selection. */
export function runChatAction(ws: Workspace, editor: Editor, action: ChatAction) {
  editor.focus();
  ws.showTool('ai');
  const it = what(editor);
  const question = {
    explain: `Explain ${it}: what it does, how it fits in the project, and anything surprising.`,
    fix: `Fix the problems in ${it}. Show the corrected code.`,
    tests: `Write tests for ${it}, in the style of the project's existing tests (PHPUnit or Pest).`,
    docs: `Add doc comments (PHPDoc) to ${it}: what each method does, parameter and return types where the code doesn't say them. Show the code with the comments.`,
  }[action];
  void askAi(ws, question);
}

const EDIT_SYSTEM = `You edit code in an IDE. You get a file, the part of it to change (between <selection> tags), and an instruction.
Answer with only the new code for that part: no explanation, no Markdown fences, no <selection> tags. Keep the surrounding indentation and the project's style. If the instruction can't be done, return the code unchanged.`;

/** Edit with AI: asks for the instruction, then streams the change into a diff to review. */
export function startInlineEdit(ws: Workspace, editor: Editor) {
  const model = editor.getModel();
  if (!model) return;
  let sel: monaco.IRange | null = editor.getSelection();
  // Nothing selected: the current line, or the whole file when it's short.
  if (!sel || monaco.Range.isEmpty(sel)) {
    const line = editor.getPosition()?.lineNumber ?? 1;
    sel = model.getLineCount() <= 300 ? model.getFullModelRange() : new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    editor.setSelection(sel);
  }
  const ctx = editorContext(ws, editor);
  if (!ctx) return;
  const range = sel;
  setAiDialog({
    kind: 'prompt',
    title: 'Edit with AI',
    context: contextLabel(ctx),
    submit: (instruction) => void runInlineEdit(ws, editor, model, range, instruction),
  });
}

async function runInlineEdit(ws: Workspace, editor: Editor, model: monaco.editor.ITextModel, range: monaco.IRange, instruction: string) {
  const ctx = editorContext(ws, editor);
  if (!ctx) return;
  const original = model.getValueInRange(range);
  const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
  const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
  const all = model.getValue();
  const marked = `${all.slice(0, start)}<selection>${original}</selection>${all.slice(end)}`;
  // The usual context (problems, class outlines), with the file marked instead of shown twice.
  const context = await describeContext({ ...ctx, text: marked, selection: undefined });
  const stream = streamAi(
    {
      model: getSettings().ai.chatModel,
      maxTokens: 8192,
      temperature: 0,
      system: EDIT_SYSTEM,
      messages: [{ role: 'user', content: `${context}\n\nInstruction: ${instruction}` }],
    },
    (_piece, text) => updateReview({ text: stripFences(text) }),
  );
  setAiDialog({ kind: 'review', title: instruction, change: { model, range, text: '' }, streaming: true, cancel: stream.cancel });
  try {
    const result = await stream.done;
    updateReview({ text: stripFences(result.text), streaming: false });
  } catch (e) {
    if (e instanceof AiCancelled) return;
    updateReview({ streaming: false, error: e instanceof Error ? e.message : String(e) });
  }
}

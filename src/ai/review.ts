// AI dialogs over the editor: "Edit with AI" (the instruction) and the review of a proposed change
// as a diff, accepted or rejected. A change is a range of a model and its new text; accepting it is
// one undoable edit.

import * as monaco from 'monaco-editor';
import { useSyncExternalStore } from 'react';

export interface Change {
  model: monaco.editor.ITextModel;
  range: monaco.IRange;
  text: string;
}

export type AiDialog =
  | { kind: 'prompt'; title: string; context: string; submit: (instruction: string) => void }
  | {
      kind: 'review';
      title: string;
      change: Change;
      /** Still arriving from the model (Accept waits), or why it failed. */
      streaming: boolean;
      error?: string;
      cancel?: () => void;
    };

let dialog: AiDialog | null = null;
const listeners = new Set<() => void>();

export function setAiDialog(next: AiDialog | null) {
  dialog = next;
  listeners.forEach((l) => l());
}

/** Updates the review being shown (new text as it streams in); ignored once it was closed. */
export function updateReview(patch: Partial<Extract<AiDialog, { kind: 'review' }>> & { text?: string }) {
  if (dialog?.kind !== 'review') return;
  const { text, ...rest } = patch;
  setAiDialog({ ...dialog, ...rest, change: text === undefined ? dialog.change : { ...dialog.change, text } });
}

export function useAiDialog(): AiDialog | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => dialog,
  );
}

/** The model's text after the change. */
export function changedText(change: Change): string {
  const { model, range, text } = change;
  const all = model.getValue();
  const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
  const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
  return all.slice(0, start) + text + all.slice(end);
}

/** Makes the change as one undo step, selects the new text and focuses its editor. */
export function applyChange(change: Change, editor?: monaco.editor.ICodeEditor | null) {
  const { model, range, text } = change;
  if (model.isDisposed()) return;
  model.pushStackElement();
  model.pushEditOperations([], [{ range, text, forceMoveMarkers: true }], () => null);
  model.pushStackElement();
  if (editor?.getModel() === model) {
    const start = { lineNumber: range.startLineNumber, column: range.startColumn };
    const endOffset = model.getOffsetAt(start) + text.length;
    const end = model.getPositionAt(endOffset);
    editor.setSelection(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column));
    editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column));
    // Ctrl+Z right after applying undoes it (undo goes to whatever has focus, not to this editor).
    editor.focus();
  }
}

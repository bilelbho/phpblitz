// The AI dialogs: "Edit with AI" (type the change you want) and the review of a change as a diff
// (the text streams in; Accept makes it one undoable edit).

import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { useSettings } from '../settings';
import { activeEditor } from '../editor/active';
import { applyChange, changedText, setAiDialog, useAiDialog, type AiDialog } from '../ai/review';
import { Icon } from './Icon';

export function AiDialogs() {
  const dialog = useAiDialog();
  if (!dialog) return null;
  return dialog.kind === 'prompt' ? <PromptDialog dialog={dialog} /> : <ReviewDialog dialog={dialog} />;
}

function close(dialog: AiDialog | null) {
  if (dialog?.kind === 'review') dialog.cancel?.();
  setAiDialog(null);
  activeEditor()?.focus();
}

function PromptDialog({ dialog }: { dialog: Extract<AiDialog, { kind: 'prompt' }> }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = () => {
    if (!text.trim()) return;
    dialog.submit(text.trim());
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(dialog)}>
      <div className="pb-dialog ai-prompt" role="dialog" aria-modal="true" aria-label={dialog.title} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close(dialog))}>
        <div className="ai-dialog-title">
          <Icon name="sparkle" size={14} />
          {dialog.title}
          <span className="muted ai-dialog-sub">{dialog.context}</span>
        </div>
        <textarea
          ref={input}
          className="textarea"
          rows={3}
          placeholder="Describe the change: “extract the validation into a method”, “add return types”… (Enter to run)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="pb-dialog-buttons">
          <button type="button" className="btn primary" disabled={!text.trim()} onClick={submit}>
            Generate
          </button>
          <button type="button" className="btn" onClick={() => close(dialog)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewDialog({ dialog }: { dialog: Extract<AiDialog, { kind: 'review' }> }) {
  const host = useRef<HTMLDivElement>(null);
  const models = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  const settings = useSettings().editor;
  const { change } = dialog;
  const ready = !dialog.streaming && !dialog.error;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const language = change.model.getLanguageId();
    const original = monaco.editor.createModel(change.model.getValue(), language);
    const modified = monaco.editor.createModel(changedText(change), language);
    models.current = { original, modified };
    const diff = monaco.editor.createDiffEditor(el, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: el.clientWidth > 900,
      fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
      fontSize: settings.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
      contextmenu: false,
    });
    diff.setModel({ original, modified });
    const first = diff.onDidUpdateDiff(() => {
      const c = diff.getLineChanges()?.[0];
      if (c) diff.getModifiedEditor().revealLineInCenter(c.modifiedStartLineNumber || c.modifiedEndLineNumber || 1);
      first.dispose();
    });
    return () => {
      diff.dispose();
      original.dispose();
      modified.dispose();
      models.current = null;
    };
    // The dialog's change keeps its model and range; only the text changes while streaming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change.model, change.range]);

  // New text as it streams in.
  useEffect(() => {
    const m = models.current?.modified;
    if (m && !m.isDisposed()) m.setValue(changedText(change));
  }, [change]);

  const accept = () => {
    if (!ready) return;
    applyChange(change, activeEditor());
    setAiDialog(null);
    activeEditor()?.focus();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(dialog)}>
      <div
        className="pb-dialog ai-review"
        role="dialog"
        aria-modal="true"
        aria-label="Review the change"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close(dialog);
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) accept();
        }}
      >
        <div className="ai-dialog-title">
          <Icon name="sparkle" size={14} />
          <span className="ai-review-title">{dialog.title}</span>
          <span className="muted ai-dialog-sub">{dialog.streaming ? 'Generating…' : dialog.error ? '' : 'Review the change'}</span>
        </div>
        <div ref={host} className="ai-review-diff" />
        {dialog.error && <div className="error-text ai-error">{dialog.error}</div>}
        <div className="pb-dialog-buttons">
          <button type="button" className="btn primary" disabled={!ready} onClick={accept} title="Ctrl+Enter">
            Accept
          </button>
          <button type="button" className="btn" onClick={() => close(dialog)}>
            {dialog.streaming ? 'Stop' : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}

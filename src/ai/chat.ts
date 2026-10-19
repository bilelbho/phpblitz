// The AI chat: a conversation about the project, with the open file, the selection and the classes
// they use as context. Lives outside React, so closing the tool window keeps it. Code blocks in
// answers can be applied where they belong: the selection the question was about, the whole file,
// or the caret.

import * as monaco from 'monaco-editor';
import { useSyncExternalStore } from 'react';
import type { Workspace } from '../useWorkspace';
import { getSettings } from '../settings';
import { activeEditor, pathOfModel } from '../editor/active';
import { AiCancelled, streamAi, type AiMessage, type AiStream } from './client';
import { contextLabel, describeContext, type CodeContext } from './context';
import type { Change } from './review';

/** Where an answer's code goes: a range kept up to date as the file changes (a decoration). */
export interface Target {
  uri: string;
  path: string;
  /** Decoration over the selection the question was about; none: the whole file. */
  decoration?: string;
  /** The selected code when the question was asked: checked before applying, to find it again. */
  original?: string;
}

export interface ChatTurn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** What the model was given besides the text (sent with the question, not shown). */
  context?: string;
  /** "UserController.php, lines 10–24". */
  contextLabel?: string;
  target?: Target;
  pending?: boolean;
  error?: string;
  usage?: { input: number; output: number };
}

const SYSTEM = `You are the AI assistant built into PHPBlitz, a PHP IDE. You help with the user's project: PHP (often Laravel or Symfony), JavaScript and TypeScript, SQL, and their tooling.

- Be concise and concrete. Answer in the language the user writes in.
- Put code in fenced blocks with the language name.
- When the user selected code and asks to change it, answer with one block holding the full replacement for the selection (nothing else in that block), then a short explanation.
- When you change a whole short file, give the complete new file in one block; for long files, give only the changed methods.
- Use the project's real classes and methods: the outlines you get come from the project's index. Don't invent APIs; say when something isn't in the context.`;

/** Questions whose file context is sent again in full; older ones keep only their text. */
const CONTEXT_TURNS = 2;

let turns: ChatTurn[] = [];
let running: AiStream | null = null;
let nextId = 1;
/** The AI tool window's tab: asking from the editor switches it to the chat. */
let tab: 'chat' | 'agents' = 'chat';
const listeners = new Set<() => void>();
let snapshot: { turns: ChatTurn[]; busy: boolean; tab: 'chat' | 'agents' } = { turns, busy: false, tab };

function changed() {
  snapshot = { turns, busy: running !== null, tab };
  listeners.forEach((l) => l());
}

export function setAiTab(next: 'chat' | 'agents') {
  tab = next;
  changed();
}

function update(id: number, patch: Partial<ChatTurn>) {
  turns = turns.map((t) => (t.id === id ? { ...t, ...patch } : t));
  changed();
}

export function useChat() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** The code context of an editor: its file, selection and problems. */
export function editorContext(ws: Workspace, editor: monaco.editor.ICodeEditor | null): CodeContext | null {
  const model = editor?.getModel();
  if (!editor || !model) return null;
  const path = pathOfModel(model);
  const root = ws.backend.root;
  const sel = editor.getSelection();
  let selection: CodeContext['selection'];
  if (sel && !sel.isEmpty()) {
    // A selection ending at the start of a line doesn't include that line.
    const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    selection = { text: model.getValueInRange(sel), startLine: sel.startLineNumber, endLine };
  }
  return {
    path,
    rel: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
    language: model.getLanguageId(),
    text: model.getValue(),
    cursorLine: editor.getPosition()?.lineNumber ?? 1,
    selection,
    problems: ws.problems[path] ?? [],
  };
}

function targetOf(editor: monaco.editor.ICodeEditor | null, ctx: CodeContext | null): Target | undefined {
  const model = editor?.getModel();
  if (!model || !ctx) return undefined;
  const sel = editor!.getSelection();
  const decoration = sel && !sel.isEmpty() ? model.deltaDecorations([], [{ range: sel, options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } }])[0] : undefined;
  return { uri: model.uri.toString(), path: ctx.path, decoration, original: decoration && sel ? model.getValueInRange(sel) : undefined };
}

/** Asks a question; with `withContext`, about the active editor's file and selection. */
export async function askAi(ws: Workspace, question: string, opts: { withContext?: boolean } = {}): Promise<void> {
  const text = question.trim();
  if (!text || running) return;
  const editor = opts.withContext === false ? null : activeEditor();
  const ctx = editorContext(ws, editor);
  const user: ChatTurn = { id: nextId++, role: 'user', text, contextLabel: ctx ? contextLabel(ctx) : undefined, target: targetOf(editor, ctx) };
  const answer: ChatTurn = { id: nextId++, role: 'assistant', text: '', pending: true, target: user.target };
  turns = [...turns, user, answer];
  tab = 'chat';
  changed();
  try {
    if (ctx) update(user.id, { context: await describeContext(ctx) });
    const asked = turns.filter((t) => t.role === 'user');
    const recent = new Set(asked.slice(-CONTEXT_TURNS).map((t) => t.id));
    const messages: AiMessage[] = turns
      .filter((t) => t.id !== answer.id && !(t.role === 'assistant' && (t.error || !t.text)))
      .map((t) => ({ role: t.role, content: t.role === 'user' && t.context && recent.has(t.id) ? `${t.context}\n\n${t.text}` : t.text }));
    // The API wants user and assistant turns alternating: merge a question left without an answer.
    const merged: AiMessage[] = [];
    for (const m of messages) {
      const last = merged[merged.length - 1];
      if (last?.role === m.role) last.content += `\n\n${m.content}`;
      else merged.push({ ...m });
    }
    const ai = getSettings().ai;
    running = streamAi({ model: ai.chatModel, maxTokens: 8192, system: SYSTEM, messages: merged }, (_piece, all) => update(answer.id, { text: all }));
    changed();
    const result = await running.done;
    update(answer.id, { pending: false, usage: { input: result.inputTokens, output: result.outputTokens } });
  } catch (e) {
    update(answer.id, { pending: false, error: e instanceof AiCancelled ? 'Stopped.' : e instanceof Error ? e.message : String(e) });
  } finally {
    running = null;
    changed();
  }
}

export function stopAi() {
  running?.cancel();
}

export function clearChat() {
  stopAi();
  for (const t of turns) {
    if (t.target?.decoration) monaco.editor.getModel(monaco.Uri.parse(t.target.uri))?.deltaDecorations([t.target.decoration], []);
  }
  turns = [];
  changed();
}

// ── Applying code from an answer ─────────────────────────────

export interface ApplyPlan {
  label: string;
  /** Why it can't be applied (file closed…). */
  disabled?: string;
  change?: Change;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const sameCode = (a: string, b: string) => lf(a) === lf(b);

/**
 * Where the question's selection is now: its tracked range while that still holds the selected code
 * (or this answer's code, once applied). Undo and other edits can leave the range elsewhere: then
 * the one place the code is found again, or null.
 */
function trackedRange(target: Target, model: monaco.editor.ITextModel, code: string): monaco.IRange | null {
  const range = model.getDecorationRange(target.decoration!);
  if (range) {
    const text = model.getValueInRange(range);
    if ((target.original !== undefined && sameCode(text, target.original)) || sameCode(text, code)) return range;
  }
  for (const wanted of [target.original, code]) {
    if (!wanted?.trim()) continue;
    const found = model.findMatches(lf(wanted).replace(/\n/g, model.getEOL()), false, false, true, null, false);
    if (found.length === 1) {
      target.decoration = model.deltaDecorations([target.decoration!], [{ range: found[0].range, options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } }])[0];
      return found[0].range;
    }
  }
  return null;
}

/** Where a code block goes: the question's selection, the whole file, or the active editor's caret. */
export function planApply(turn: ChatTurn, code: string, language: string): ApplyPlan {
  const target = turn.target;
  const model = target ? monaco.editor.getModel(monaco.Uri.parse(target.uri)) : null;
  if (target?.decoration) {
    if (!model) return { label: 'Apply to selection', disabled: `Open ${target.path.split('/').pop()} again to apply this.` };
    const range = trackedRange(target, model, code);
    if (!range) return { label: 'Apply to selection', disabled: 'The selected code changed since the question: select it again and ask.' };
    return { label: 'Apply to selection', change: { model, range, text: code } };
  }
  // A whole file: the model was asked to give whole files only when they're short.
  const lines = code.split('\n').length;
  if (model && (/^\s*<\?php/.test(code) || (language === model.getLanguageId() && lines >= model.getLineCount() * 0.7))) {
    return { label: 'Replace file', change: { model, range: model.getFullModelRange(), text: code.endsWith('\n') || !model.getValue().endsWith('\n') ? code : `${code}\n` } };
  }
  const editor = activeEditor();
  const at = editor?.getModel();
  const sel = editor?.getSelection();
  if (!editor || !at || !sel) return { label: 'Insert at caret', disabled: 'Click in an editor first.' };
  return { label: sel.isEmpty() ? 'Insert at caret' : 'Replace selection', change: { model: at, range: sel, text: code } };
}

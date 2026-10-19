// The AI tool window's Chat tab: questions about the project with the open file as context, answers
// rendered with their code blocks (Apply / Show diff / Copy).

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { AI_PROVIDERS, useSettings } from '../settings';
import { isTauri } from '../platform';
import { colorizeCode, renderMarkdown } from '../editor/markdown';
import { activeEditor } from '../editor/active';
import { useApiKey } from '../ai/client';
import { askAi, clearChat, editorContext, planApply, stopAi, useChat, type ChatTurn } from '../ai/chat';
import { contextLabel } from '../ai/context';
import { splitAnswer, tokens } from '../ai/answer';
import { applyChange, setAiDialog } from '../ai/review';
import { Icon } from './Icon';

const SUGGESTIONS = ['Explain this file', 'Find bugs in this file', 'Write tests for this file', 'How is this class used in the project?'];

export function AiChat({ ws }: { ws: Workspace }) {
  const chat = useChat();
  const ai = useSettings().ai;
  const key = useApiKey(ai.provider);
  const model = ai.chatModel;
  const provider = AI_PROVIDERS[ai.provider].label;
  const [input, setInput] = useState('');
  const [withFile, setWithFile] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const last = chat.turns[chat.turns.length - 1];

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.turns.length, last?.text]);

  if (!isTauri) return <div className="empty">The AI chat runs in the desktop app.</div>;
  if (key && !key.set) {
    return (
      <div className="panel-body ai-chat">
        <div className="card">
          <div className="card-title">Add your {provider} API key</div>
          <div className="card-body">
            The chat, Edit with AI, commit messages and ghost text use your own key, billed to your {provider} account, and kept in your system&apos;s credential store. Or pick
            Ollama to use models on this computer, with no key.
          </div>
          <div>
            <button type="button" className="link-btn" onClick={() => ws.openSettings('ai-agents')}>
              Open AI settings
            </button>
          </div>
        </div>
        <div className="muted ai-note">Have a Claude subscription instead? Use the Agents tab: Claude Code signs in with your account.</div>
      </div>
    );
  }

  // The file the next question is about (re-read on each render: the active editor isn't React state).
  const ctx = withFile ? editorContext(ws, activeEditor()) : null;
  const send = (text: string) => {
    if (!text.trim() || chat.busy) return;
    void askAi(ws, text, { withContext: withFile });
    setInput('');
  };

  return (
    <>
      <div className="panel-body ai-chat">
        {!chat.turns.length && (
          <div className="ai-empty">
            <div className="muted ai-note">Ask about the open file or the project. The file, the selection, its problems and the classes it uses go with the question.</div>
            <div className="ai-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip-btn" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.turns.map((t) => (t.role === 'user' ? <UserTurn key={t.id} turn={t} /> : <Answer key={t.id} turn={t} ws={ws} />))}
        <div ref={end} />
      </div>
      <div className="panel-foot ai-foot">
        <div className="ai-context">
          {ctx ? (
            <span className="ai-chip" title={ctx.path}>
              <Icon name="code" size={12} />
              {contextLabel(ctx)}
              <button type="button" className="ai-chip-x" aria-label="Don't send the file" title="Don't send the file" onClick={() => setWithFile(false)}>
                <Icon name="close" size={8} />
              </button>
            </span>
          ) : (
            <button type="button" className="link-btn ai-add-file" onClick={() => setWithFile(true)} disabled={withFile}>
              {withFile ? 'No file open' : '+ Send the open file'}
            </button>
          )}
          <span className="grow" />
          {!!chat.turns.length && (
            <button type="button" className="icon-btn small" title="New chat" aria-label="New chat" onClick={clearChat} disabled={chat.busy}>
              <Icon name="plus" size={13} />
            </button>
          )}
        </div>
        <label htmlFor="ai-input" className="sr-only">
          Ask the AI assistant
        </label>
        <textarea
          id="ai-input"
          className="textarea"
          rows={3}
          placeholder="Ask about this project… (Enter to send, Shift+Enter for a new line)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="ai-send">
          <span className="muted ai-model">{model}</span>
          <span className="grow" />
          {chat.busy ? (
            <button type="button" className="btn small" onClick={stopAi}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn small primary" onClick={() => send(input)} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function UserTurn({ turn }: { turn: ChatTurn }) {
  return (
    <div className="ai-turn you">
      <div className="ai-bubble">{turn.text}</div>
      {turn.contextLabel && <div className="muted ai-about">about {turn.contextLabel}</div>}
    </div>
  );
}

const Answer = memo(function Answer({ turn, ws }: { turn: ChatTurn; ws: Workspace }) {
  const segments = useMemo(() => splitAnswer(turn.text), [turn.text]);
  return (
    <div className="ai-turn assistant">
      {segments.map((s, i) => (s.kind === 'text' ? <MarkdownText key={i} text={s.text} /> : <CodeBlock key={i} turn={turn} ws={ws} code={s.code} lang={s.lang} done={s.closed || !turn.pending} />))}
      {turn.pending && !turn.text && <div className="muted ai-thinking">Thinking…</div>}
      {turn.error && <div className="error-text ai-error">{turn.error}</div>}
      {turn.usage && (
        <div className="muted ai-usage" title="Tokens sent and received">
          {tokens(turn.usage.input)} in · {tokens(turn.usage.output)} out
        </div>
      )}
    </div>
  );
});

function MarkdownText({ text }: { text: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let live = true;
    void renderMarkdown(text).then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [text]);
  // renderMarkdown escapes everything it doesn't format itself.
  return <div className="ai-text md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CodeBlock({ turn, ws, code, lang, done }: { turn: ChatTurn; ws: Workspace; code: string; lang: string; done: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!done) return;
    let live = true;
    void colorizeCode(code, lang || 'php').then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [code, lang, done]);
  const plan = done ? planApply(turn, code, lang) : null;
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span className="muted mono">{lang || 'code'}</span>
        <span className="grow" />
        {plan && (
          <>
            <button
              type="button"
              className="btn small ghost"
              disabled={!!plan.disabled}
              title={plan.disabled ?? `${plan.label} (undo with Ctrl+Z)`}
              onClick={() => {
                const now = planApply(turn, code, lang);
                if (now.change) {
                  applyChange(now.change, activeEditor());
                  ws.setStatus(`${now.label}: done. Ctrl+Z undoes it.`);
                }
              }}
            >
              {plan.label}
            </button>
            <button
              type="button"
              className="btn small ghost"
              disabled={!!plan.disabled}
              onClick={() => {
                const now = planApply(turn, code, lang);
                if (now.change) setAiDialog({ kind: 'review', title: now.label, change: now.change, streaming: false });
              }}
            >
              Show diff
            </button>
          </>
        )}
        <button
          type="button"
          className="icon-btn small"
          title={copied ? 'Copied' : 'Copy'}
          aria-label="Copy code"
          onClick={() =>
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
      {html !== null ? <pre className="md-code" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="md-code">{code}</pre>}
    </div>
  );
}

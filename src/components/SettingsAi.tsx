// Settings ▸ Tools ▸ AI: the AI assistant (chat, Edit with AI, commit messages, ghost text) with the
// user's own Anthropic API key, and the MCP server that AI coding agents (Claude Code, Codex, Gemini
// CLI…) use to ask PHPBlitz's index about the project.

import { useEffect, useState } from 'react';
import type { AiSettings } from '../settings';
import { isTauri } from '../platform';
import { claudeCodeCommand, loadMcpStatus, mcpJson, newMcpToken, useMcpStatus } from '../mcp';
import { AiCancelled, setApiKey, streamAi, useApiKey } from '../ai/client';

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

export function AiAgentsPage({ value: ai, saved, onChange, highlight }: { value: AiSettings; saved: AiSettings; onChange: (patch: Partial<AiSettings>) => void; highlight: string }) {
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');
  const status = useMcpStatus();
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    void loadMcpStatus(saved.mcpPort);
  }, [saved.mcpPort]);

  const copy = (what: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(what);
        window.setTimeout(() => setCopied((c) => (c === what ? '' : c)), 1500);
      },
      () => {},
    );
  // The commands use the applied port (the server's), not one still being typed.
  const target = status ?? { url: `http://127.0.0.1:${saved.mcpPort}/mcp`, token: '' };
  const hidden = { ...target, token: showToken ? target.token : '•'.repeat(12) };
  const pending = ai.mcpServer !== saved.mcpServer || ai.mcpPort !== saved.mcpPort;

  let state = 'Off';
  if (saved.mcpServer) state = status?.running ? `Running on ${status.url}` : status?.error ? `Not running: ${status.error}` : 'Starting…';

  return (
    <>
      {isTauri && <AssistantSection ai={ai} onChange={onChange} hit={hit} />}
      <h3 className="settings-section">MCP server</h3>
      <div className="muted settings-note" style={{ marginBottom: 10 }}>
        AI coding agents can ask PHPBlitz about the open project: find classes and methods, a class's members and parents, usages, declarations and the analyzer's problems. They
        get answers from the index instead of searching files. The agent uses your own account or API key; PHPBlitz only answers its questions, on this computer, and never
        changes files.
      </div>
      <label className={'settings-check' + hit('Enable the MCP server')}>
        <input type="checkbox" className="checkbox" checked={ai.mcpServer} onChange={(e) => onChange({ mcpServer: e.target.checked })} />
        Enable the MCP server
      </label>
      <div className="settings-grid" style={{ marginTop: 10 }}>
        <label htmlFor="mcp-port" className={hit('Port')}>
          Port:
        </label>
        <div className="settings-row">
          <div className="field" style={{ width: 90 }}>
            <input id="mcp-port" value={ai.mcpPort} onChange={(e) => onChange({ mcpPort: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </div>
          <span className="muted">Only this computer can connect (127.0.0.1).</span>
        </div>
        <span>Status:</span>
        <span className={status?.error && saved.mcpServer ? 'settings-error' : 'muted'}>{pending ? 'Apply to change' : state}</span>
      </div>

      {isTauri && (
        <>
          <h3 className="settings-section">Connect an agent</h3>
          <div className="muted settings-note">Claude Code: run this once in a terminal. It works in every project; PHPBlitz answers for the project that is open.</div>
          <pre className="settings-code">{claudeCodeCommand(hidden)}</pre>
          <div className="settings-row" style={{ gap: 8 }}>
            <button type="button" className="btn" disabled={!target.token} onClick={() => copy('claude', claudeCodeCommand(target))}>
              {copied === 'claude' ? 'Copied' : 'Copy command'}
            </button>
            <button type="button" className="btn" disabled={!target.token} onClick={() => copy('json', mcpJson(target))}>
              {copied === 'json' ? 'Copied' : 'Copy JSON for other agents'}
            </button>
            <button type="button" className="link-btn" onClick={() => setShowToken((s) => !s)}>
              {showToken ? 'Hide token' : 'Show token'}
            </button>
          </div>
          <div className="muted settings-note" style={{ marginTop: 12 }}>
            The token keeps other programs and web pages out. Treat it like a password. A new token disconnects the agents set up with the old one.
          </div>
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn" onClick={() => void newMcpToken(saved.mcpPort)}>
              New token
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** The assistant: API key (saved at once, in the credential store), models and ghost text. */
function AssistantSection({ ai, onChange, hit }: { ai: AiSettings; onChange: (patch: Partial<AiSettings>) => void; hit: (label: string) => string }) {
  const key = useApiKey();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (value: string) => {
    setBusy(true);
    setResult(null);
    try {
      await setApiKey(value);
      setDraft('');
      setResult(value ? { ok: true, text: "Saved in your system's credential store." } : { ok: true, text: 'Removed.' });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      await streamAi({ model: ai.fastModel, maxTokens: 5, messages: [{ role: 'user', content: 'Reply with OK.' }] }).done;
      setResult({ ok: true, text: `The key works (${ai.fastModel} answered).` });
    } catch (e) {
      if (!(e instanceof AiCancelled)) setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 className="settings-section">AI assistant</h3>
      <div className="muted settings-note" style={{ marginBottom: 10 }}>
        The chat, Edit with AI (Ctrl+Shift+I), commit messages and ghost text use Anthropic&apos;s models with your own API key, billed to your Anthropic account. The open file,
        the selection and outlines of the classes it uses are sent with each request. Get a key at console.anthropic.com.
      </div>
      <div className="settings-grid">
        <label htmlFor="ai-key" className={hit('API key')}>
          API key:
        </label>
        <div className="settings-row" style={{ gap: 8 }}>
          <div className="field" style={{ width: 260 }}>
            <input
              id="ai-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={key?.set ? `Saved (${key.hint}): paste a new one to replace it` : 'sk-ant-…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && draft.trim() && void save(draft)}
            />
          </div>
          <button type="button" className="btn small" disabled={busy || !draft.trim()} onClick={() => void save(draft)}>
            Save
          </button>
          {key?.set && (
            <>
              <button type="button" className="btn small" disabled={busy} onClick={() => void test()}>
                Test
              </button>
              <button type="button" className="link-btn" disabled={busy} onClick={() => void save('')}>
                Remove
              </button>
            </>
          )}
        </div>
        <span />
        <span className={result && !result.ok ? 'settings-error' : 'muted'} style={{ fontSize: 12 }}>
          {busy ? 'Working…' : result ? result.text : key?.set ? `A key is saved (${key.hint}).` : 'No key yet.'}
        </span>
        <label htmlFor="ai-chat-model" className={hit('Chat model')}>
          Chat model:
        </label>
        <div className="settings-row">
          <div className="field" style={{ width: 200 }}>
            <input id="ai-chat-model" list="ai-models" spellCheck={false} value={ai.chatModel} onChange={(e) => onChange({ chatModel: e.target.value.trim() })} />
          </div>
          <span className="muted">Chat and Edit with AI.</span>
        </div>
        <label htmlFor="ai-fast-model" className={hit('Fast model')}>
          Fast model:
        </label>
        <div className="settings-row">
          <div className="field" style={{ width: 200 }}>
            <input id="ai-fast-model" list="ai-models" spellCheck={false} value={ai.fastModel} onChange={(e) => onChange({ fastModel: e.target.value.trim() })} />
          </div>
          <span className="muted">Commit messages and ghost text.</span>
        </div>
        <datalist id="ai-models">
          {MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      <div style={{ marginTop: 10 }}>
        <label className={'settings-check' + hit('Ghost text')}>
          <input type="checkbox" className="checkbox" checked={ai.ghostText} onChange={(e) => onChange({ ghostText: e.target.checked })} />
          Ghost text: suggest code while typing (Tab accepts)
        </label>
        <div className="muted settings-help">One request to the fast model after each pause in typing, so it costs more than the other features.</div>
      </div>
    </>
  );
}

// Settings ▸ Tools ▸ AI: the AI assistant (chat, Edit with AI, commit messages, ghost text) with the
// user's own API key (Anthropic, OpenAI, Gemini) or Ollama on this computer, and the MCP server that AI coding agents (Claude Code, Codex, Gemini
// CLI…) use to ask PHPBlitz's index about the project.

import { useEffect, useState } from 'react';
import { AI_PROVIDERS, type AiProvider, type AiSettings } from '../settings';
import { isTauri } from '../platform';
import { claudeCodeCommand, loadMcpStatus, mcpJson, newMcpToken, useMcpStatus } from '../mcp';
import { AiCancelled, listModels, setApiKey, streamAi, useApiKey } from '../ai/client';

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

/** The assistant: provider, its key (saved at once, in the credential store) or Ollama's address, models and ghost text. */
function AssistantSection({ ai, onChange, hit }: { ai: AiSettings; onChange: (patch: Partial<AiSettings>) => void; hit: (label: string) => string }) {
  const provider = ai.provider;
  const info = AI_PROVIDERS[provider];
  const local = provider === 'ollama';
  const key = useApiKey(provider);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<{ provider: string; list: string[]; error?: string } | null>(null);

  // The provider's models, from its API (or Ollama): no guessing at model names.
  const loadModels = async () => {
    setModels(null);
    try {
      const list = await listModels(provider, ai.ollamaUrl);
      setModels({ provider, list });
      // Ollama: start with an installed model.
      if (local && list.length && (!ai.chatModel || !ai.fastModel)) onChange({ chatModel: ai.chatModel || list[0], fastModel: ai.fastModel || list[0] });
    } catch (e) {
      setModels({ provider, list: [], error: String(e) });
    }
  };
  useEffect(() => {
    if (key?.set) void loadModels();
    // Again when the provider, its key or Ollama's address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, key?.set, key?.hint, ai.ollamaUrl]);

  const switchTo = (next: AiProvider) => {
    if (next === provider) return;
    const saved = { ...ai.savedModels, [provider]: { chat: ai.chatModel, fast: ai.fastModel } };
    const picked = saved[next] ?? { chat: AI_PROVIDERS[next].chat, fast: AI_PROVIDERS[next].fast };
    setResult(null);
    setDraft('');
    onChange({ provider: next, savedModels: saved, chatModel: picked.chat, fastModel: picked.fast });
  };
  const save = async (value: string) => {
    setBusy(true);
    setResult(null);
    try {
      await setApiKey(provider, value);
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
      await streamAi({ provider, baseUrl: ai.ollamaUrl, model: ai.fastModel, maxTokens: 5, messages: [{ role: 'user', content: 'Reply with OK.' }] }).done;
      setResult({ ok: true, text: `It works: ${ai.fastModel} answered.` });
    } catch (e) {
      if (!(e instanceof AiCancelled)) setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const list = models?.provider === provider ? models.list : [];
  let status = busy ? 'Working…' : (result?.text ?? '');
  if (!status) status = local ? (models?.error ?? (models ? `${list.length} ${list.length === 1 ? 'model' : 'models'} installed.` : 'Looking for Ollama…')) : key?.set ? `A key is saved (${key.hint}).` : 'No key yet.';
  const failed = (result && !result.ok) || (!result && local && !!models?.error);

  return (
    <>
      <h3 className="settings-section">AI assistant</h3>
      <div className="muted settings-note" style={{ marginBottom: 10 }}>
        The chat, Edit with AI (Ctrl+Shift+I), commit messages and ghost text use the provider you choose: with your own API key, billed to your account there, or Ollama with
        models on this computer. The open file, the selection and outlines of the classes it uses are sent with each request.
      </div>
      <div className="settings-grid">
        <label htmlFor="ai-provider" className={hit('Provider')}>
          Provider:
        </label>
        <div className="settings-row">
          <select id="ai-provider" className="settings-select" value={provider} onChange={(e) => switchTo(e.target.value as AiProvider)}>
            {(Object.keys(AI_PROVIDERS) as AiProvider[]).map((p) => (
              <option key={p} value={p}>
                {AI_PROVIDERS[p].label}
              </option>
            ))}
          </select>
          {info.keys && <span className="muted">Keys at {info.keys}</span>}
        </div>
        {local ? (
          <>
            <label htmlFor="ai-ollama" className={hit('Ollama address')}>
              Address:
            </label>
            <div className="settings-row" style={{ gap: 8 }}>
              <div className="field" style={{ width: 260 }}>
                <input id="ai-ollama" spellCheck={false} value={ai.ollamaUrl} onChange={(e) => onChange({ ollamaUrl: e.target.value.trim() })} />
              </div>
              <button type="button" className="btn small" disabled={busy || !ai.fastModel} onClick={() => void test()}>
                Test
              </button>
            </div>
          </>
        ) : (
          <>
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
                  placeholder={key?.set ? `Saved (${key.hint}): paste a new one to replace it` : `Your ${info.label} API key`}
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
          </>
        )}
        <span />
        <span className={failed ? 'settings-error' : 'muted'} style={{ fontSize: 12 }}>
          {status}
        </span>
        <label htmlFor="ai-chat-model" className={hit('Chat model')}>
          Chat model:
        </label>
        <div className="settings-row">
          <div className="field" style={{ width: 220 }}>
            <input id="ai-chat-model" list="ai-models" spellCheck={false} placeholder={local ? 'An installed model' : ''} value={ai.chatModel} onChange={(e) => onChange({ chatModel: e.target.value.trim() })} />
          </div>
          <span className="muted">Chat and Edit with AI.</span>
        </div>
        <label htmlFor="ai-fast-model" className={hit('Fast model')}>
          Fast model:
        </label>
        <div className="settings-row" style={{ gap: 8 }}>
          <div className="field" style={{ width: 220 }}>
            <input id="ai-fast-model" list="ai-models" spellCheck={false} placeholder={local ? 'An installed model' : ''} value={ai.fastModel} onChange={(e) => onChange({ fastModel: e.target.value.trim() })} />
          </div>
          <span className="muted">Commit messages and ghost text.</span>
          {(key?.set || local) && (
            <button type="button" className="link-btn" onClick={() => void loadModels()} title="Ask the provider for its models again">
              Refresh models
            </button>
          )}
        </div>
        <datalist id="ai-models">
          {list.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      {!local && models?.error && models.provider === provider && <div className="settings-error settings-note">Couldn&apos;t list the models: {models.error}</div>}
      <div style={{ marginTop: 10 }}>
        <label className={'settings-check' + hit('Ghost text')}>
          <input type="checkbox" className="checkbox" checked={ai.ghostText} onChange={(e) => onChange({ ghostText: e.target.checked })} />
          Ghost text: suggest code while typing (Tab accepts)
        </label>
        <div className="muted settings-help">One request to the fast model after each pause in typing{local ? '' : ', so it costs more than the other features'}.</div>
      </div>
    </>
  );
}

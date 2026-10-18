// The AI tool window: Chat (Anthropic, with the user's API key) and Agents (Claude Code, Codex,
// Gemini CLI started in the terminal with the user's own account, then handed prompts about the open
// file).

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from '../useWorkspace';
import { getSettings, saveSettings, useSettings } from '../settings';
import { isTauri } from '../platform';
import { useTerminals } from '../terminal/manager';
import { AGENTS, detectAgents, runningAgentTab, sendToAgent, shortPath, startAgent, useAgents, type Agent } from '../agents';
import { Icon } from './Icon';
import { AiChat } from './AiChat';
import { setAiTab, useChat } from '../ai/chat';

export function AiPanel({ ws }: { ws: Workspace }) {
  const { tab } = useChat();
  return (
    <>
      <div className="ai-tabs" role="tablist">
        {(['chat', 'agents'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={'ai-tab' + (tab === t ? ' active' : '')} onClick={() => setAiTab(t)}>
            {t === 'chat' ? 'Chat' : 'Agents'}
          </button>
        ))}
      </div>
      {tab === 'chat' ? <AiChat ws={ws} /> : <AgentsView ws={ws} />}
    </>
  );
}

function AgentsView({ ws }: { ws: Workspace }) {
  const agents = useAgents();
  const ai = useSettings().ai;
  useTerminals(); // re-render when an agent's tab closes
  const root = ws.backend.root;

  const [scanning, setScanning] = useState(false);
  const rescan = async () => {
    setScanning(true);
    await detectAgents().finally(() => setScanning(false));
  };

  // Also when the window gets focus again: coming back after installing an agent in a terminal.
  useEffect(() => {
    if (!isTauri) return;
    void detectAgents();
    const onFocus = () => void detectAgents();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!isTauri || ws.backend.kind !== 'disk') {
    return (
      <div className="empty">AI agents run in the desktop app, in an opened project folder.</div>
    );
  }

  const running = runningAgentTab(agents);
  const rel = ws.activePath?.startsWith(`${root}/`) ? ws.activePath.slice(root.length + 1) : ws.activePath;
  const start = async (agent: Agent) => {
    ws.showTool('terminal');
    await startAgent(agent, root);
  };
  const ask = (text: string) => {
    ws.showTool('terminal');
    sendToAgent(text);
  };
  const prompts: { label: string; text: string; needsFile?: boolean }[] = [
    { label: 'Explain this file', text: `Explain what ${rel} does and how it fits in the project.`, needsFile: true },
    { label: 'Fix its problems', text: `Fix the problems PHPBlitz reports in ${rel}.`, needsFile: true },
    { label: 'Write tests for it', text: `Write tests for ${rel}, in the style of the project's existing tests.`, needsFile: true },
    { label: 'Review my changes', text: 'Review my uncommitted changes (git diff) and point out bugs and risky code.' },
  ];

  return (
    <div className="panel-body agents">
      <div className="card agents-card">
        <div className="agents-card-row">
          <span className="dot" style={{ background: ai.mcpServer ? 'var(--green)' : 'var(--faint)' }} />
          <div className="agents-card-text">
            <div className="card-title">{ai.mcpServer ? 'Connected to the index' : 'Index tools are off'}</div>
            <div className="card-body">
              {ai.mcpServer ? "Claude Code starts with PHPBlitz's usages, classes and problems." : "Let agents use PHPBlitz's index instead of searching files."}
            </div>
          </div>
        </div>
        {!ai.mcpServer && (
          <div className="agents-card-action">
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const s = getSettings();
                saveSettings({ ...s, ai: { ...s.ai, mcpServer: true } });
              }}
            >
              Turn on
            </button>
          </div>
        )}
      </div>

      <div className="agents-head">
        <span>Agents</span>
        <button type="button" className="btn small ghost agents-refresh" title="Look for installed agents again (no restart needed)" disabled={scanning} onClick={() => void rescan()}>
          <Icon name="refresh" size={12} />
          {scanning ? 'Scanning…' : 'Refresh'}
        </button>
      </div>
      <div className="list">
        {AGENTS.map((a) => {
          const path = agents.found[a.id];
          return (
            <div key={a.id} className="list-item agents-row" title={path ?? undefined}>
              <Icon name="terminal" size={15} />
              <div className="agents-name">
                <span className="agents-title">{a.name}</span>
                <span className="mono muted agents-path">{path === undefined ? 'Looking…' : path ? shortPath(path) : 'Not installed'}</span>
              </div>
              {path ? (
                <button type="button" className="btn small primary" onClick={() => void start(a)}>
                  Start
                </button>
              ) : (
                path === null && (
                  <button type="button" className="btn small" title={a.install} onClick={() => void invoke('open_external', { url: a.install }).catch(() => {})}>
                    Install…
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>

      <div className="agents-head">
        <span>Ask {running ? running.agent.name : 'the agent'}</span>
      </div>
      {running ? (
        <div className="agents-prompts">
          {prompts.map((p) => (
            <button key={p.label} type="button" className="chip-btn" disabled={p.needsFile && !rel} title={p.text} onClick={() => ask(p.text)}>
              {p.label}
            </button>
          ))}
          <div className="muted agents-note">Typed into the agent's tab: press Enter there to send.</div>
        </div>
      ) : (
        <div className="muted agents-note agents-pad">Start an agent to send it prompts about the open file.</div>
      )}
      <div className="muted agents-note agents-pad agents-foot">Agents sign in with your own account or API key. PHPBlitz doesn't see or store them.</div>
    </div>
  );
}

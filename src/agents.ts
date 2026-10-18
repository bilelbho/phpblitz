// AI coding agents (Claude Code, Codex, Gemini CLI) run in PHPBlitz's terminal, signed in with the
// user's own account or key: PHPBlitz starts them in the project and, for agents that take an MCP
// settings file on the command line, connects them to its index (mcp.rs). Prompts from the IDE
// ("explain this file") are typed into the agent's tab for the user to send.

import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { getSettings } from './settings';
import { terminals, type ShellSpec } from './terminal/manager';

export interface Agent {
  id: 'claude' | 'codex' | 'gemini';
  name: string;
  executables: string[];
  /** Where to get it. */
  install: string;
  /** Takes `--mcp-config <file>`: started connected to PHPBlitz's MCP server. */
  mcpFlag: boolean;
}

export const AGENTS: Agent[] = [
  { id: 'claude', name: 'Claude Code', executables: ['claude'], install: 'https://docs.claude.com/en/docs/claude-code/setup', mcpFlag: true },
  { id: 'codex', name: 'Codex CLI', executables: ['codex'], install: 'https://github.com/openai/codex', mcpFlag: false },
  { id: 'gemini', name: 'Gemini CLI', executables: ['gemini'], install: 'https://github.com/google-gemini/gemini-cli', mcpFlag: false },
];

/** Agent → its executable (null: not installed), once looked up. */
let found: Partial<Record<Agent['id'], string | null>> = {};
/** Agent → the terminal tab it last started in. */
const tabs = new Map<Agent['id'], number>();
let snapshot = { found, tabs: new Map(tabs) };
const listeners = new Set<() => void>();

function changed() {
  snapshot = { found, tabs: new Map(tabs) };
  listeners.forEach((l) => l());
}

export function useAgents() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** Looks for the agents' executables (again: one may have been installed meanwhile). */
export async function detectAgents(): Promise<void> {
  const entries = await Promise.all(AGENTS.map(async (a) => [a.id, await invoke<string | null>('find_executable', { names: a.executables }).catch(() => null)] as const));
  found = Object.fromEntries(entries);
  changed();
}

/** A path with the home folder as `~` (`C:/Users/me/.local/bin/claude.exe` → `~/.local/bin/claude.exe`). */
export function shortPath(path: string): string {
  return path.replace(/^(?:[A-Za-z]:\/Users|\/Users|\/home)\/[^/]+(?=\/)/, '~');
}

/** The line that runs `program` with `args` in this shell: quoting differs between them. */
export function commandLine(shell: ShellSpec, program: string, args: string[]): string {
  const name = (shell.path.split(/[\\/]/).pop() ?? '').toLowerCase();
  const bare = (program.split(/[\\/]/).pop() ?? program).replace(/\.(exe|cmd|bat)$/i, '');
  // WSL runs Linux programs: the Windows path (and the settings file's path) mean nothing there.
  if (name.startsWith('wsl')) return bare;
  // Bash can't run npm's .cmd shims; the extensionless script next to them is on PATH.
  const bash = /^(bash|sh|zsh|fish)(\.exe)?$/.test(name);
  const exe = bash && /\.(cmd|bat)$/i.test(program) ? bare : program;
  const quote = (s: string) => (/[\s"'&()]/.test(s) ? `"${s}"` : s);
  const line = [quote(exe), ...args.map(quote)].join(' ');
  // PowerShell only runs a quoted path with the call operator.
  return /^(powershell|pwsh)/.test(name) && line.startsWith('"') ? `& ${line}` : line;
}

/** Starts an agent in a new terminal tab in the project folder. */
export async function startAgent(agent: Agent, cwd: string): Promise<void> {
  const program = found[agent.id];
  if (!program) return;
  const ai = getSettings().ai;
  const args = agent.mcpFlag && ai.mcpServer ? ['--mcp-config', await invoke<string>('mcp_agent_config', { port: ai.mcpPort })] : [];
  const session = await terminals.start({ cwd, name: agent.name, command: (shell) => commandLine(shell, program, args) });
  if (session) {
    tabs.set(agent.id, session.id);
    changed();
  }
}

/** The tab of the agent started last that is still open, if any. */
export function runningAgentTab(state = snapshot): { agent: Agent; tab: number } | null {
  const open = new Set(terminals.sessions.filter((s) => !s.exited).map((s) => s.id));
  for (const [id, tab] of [...state.tabs].reverse()) {
    if (open.has(tab)) return { agent: AGENTS.find((a) => a.id === id)!, tab };
  }
  return null;
}

/** Types a prompt into the running agent's tab (not sent: the user reads it and presses Enter). */
export function sendToAgent(text: string): boolean {
  const running = runningAgentTab();
  return !!running && terminals.paste(running.tab, text);
}

// The MCP server AI coding agents ask about the open project (src-tauri/src/mcp.rs): started and
// stopped with Settings ▸ Tools ▸ AI Agents. Its state (running, the port, the token, an error such
// as a busy port) is a small store the Settings page shows.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';
import type { AiSettings } from './settings';

export interface McpStatus {
  running: boolean;
  port: number;
  url: string;
  token: string;
  /** Why it isn't running though it's turned on. */
  error?: string;
}

let status: McpStatus | null = null;
const listeners = new Set<() => void>();

function set(next: McpStatus | null) {
  status = next;
  listeners.forEach((l) => l());
}

/** Starts, moves or stops the server to match the settings. */
export async function syncMcpServer(ai: AiSettings): Promise<void> {
  if (!isTauri) return;
  try {
    if (ai.mcpServer) {
      set(await invoke<McpStatus>('mcp_start', { port: ai.mcpPort }));
    } else {
      await invoke('mcp_stop');
      // The token is still shown, so agents can be set up before turning it on.
      if (status) set({ ...status, running: false, error: undefined });
    }
  } catch (e) {
    const known = await invoke<McpStatus>('mcp_status', { port: ai.mcpPort }).catch(() => null);
    set({ running: false, port: ai.mcpPort, url: known?.url ?? `http://127.0.0.1:${ai.mcpPort}/mcp`, token: known?.token ?? '', error: String(e) });
  }
}

/** Reads the status (and makes the token) for the Settings page. */
export async function loadMcpStatus(port: number): Promise<void> {
  if (!isTauri) return;
  const s = await invoke<McpStatus>('mcp_status', { port }).catch(() => null);
  if (s) set({ ...s, error: status?.error });
}

/** A new token: agents set up with the old one have to be set up again. */
export async function newMcpToken(port: number): Promise<void> {
  if (!isTauri) return;
  set({ ...(await invoke<McpStatus>('mcp_new_token', { port })), error: status?.error });
}

export function useMcpStatus(): McpStatus | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

/** The command that adds PHPBlitz to Claude Code, for every project (it answers for the open one). */
export const claudeCodeCommand = (s: Pick<McpStatus, 'url' | 'token'>) => `claude mcp add --scope user --transport http phpblitz ${s.url} --header "Authorization: Bearer ${s.token}"`;

/** The usual JSON entry for other agents' MCP settings (key names vary a little between agents). */
export const mcpJson = (s: Pick<McpStatus, 'url' | 'token'>) =>
  JSON.stringify({ mcpServers: { phpblitz: { type: 'http', url: s.url, headers: { Authorization: `Bearer ${s.token}` } } } }, null, 2);

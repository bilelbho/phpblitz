// Model calls from the UI: streamed through src-tauri/src/ai.rs (which holds the API key), with
// cancellation. Chat, inline edit, commit messages and ghost text all go through `streamAi`.

import { Channel, invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { isTauri } from '../platform';
import { getSettings, type AiProvider } from '../settings';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  /** Defaults to the provider and Ollama address in Settings (the Settings page tests unsaved ones). */
  provider?: AiProvider;
  baseUrl?: string;
  model: string;
  maxTokens: number;
  system?: string;
  messages: AiMessage[];
  temperature?: number;
  stopSequences?: string[];
}

export interface AiResult {
  text: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

type AiEvent = { kind: 'text'; text: string } | { kind: 'done'; stopReason: string | null; inputTokens: number; outputTokens: number } | { kind: 'error'; message: string };

export class AiCancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

export interface AiStream {
  done: Promise<AiResult>;
  cancel(): void;
}

let nextId = 1;

/** Sends a request; `onText` gets each piece and the answer so far. */
export function streamAi(request: AiRequest, onText?: (piece: string, all: string) => void): AiStream {
  const id = nextId++;
  let text = '';
  let settled = false;
  let cancel = () => {};
  const done = new Promise<AiResult>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const events = new Channel<AiEvent>();
    events.onmessage = (e) => {
      if (settled) return;
      if (e.kind === 'text') {
        text += e.text;
        onText?.(e.text, text);
      } else if (e.kind === 'done') {
        settle(() => resolve({ text, stopReason: e.stopReason, inputTokens: e.inputTokens, outputTokens: e.outputTokens }));
      } else {
        settle(() => reject(new Error(e.message)));
      }
    };
    cancel = () =>
      settle(() => {
        void invoke('ai_cancel', { id }).catch(() => {});
        reject(new AiCancelled());
      });
    if (!isTauri) {
      settle(() => reject(new Error('The AI assistant needs the desktop app.')));
      return;
    }
    const ai = getSettings().ai;
    if (!request.model) {
      settle(() => reject(new Error('Choose a model in Settings ▸ Tools ▸ AI.')));
      return;
    }
    invoke('ai_stream', { id, request: { ...request, provider: request.provider ?? ai.provider, baseUrl: request.baseUrl ?? ai.ollamaUrl }, onEvent: events }).catch((e) => settle(() => reject(new Error(String(e)))));
  });
  return { done, cancel: () => cancel() };
}

// ── API keys (kept by the Rust side, one per provider) ─────────

export interface KeyStatus {
  set: boolean;
  hint: string;
}

const keyStatus: Partial<Record<AiProvider, KeyStatus>> = {};
const loading = new Set<AiProvider>();
const listeners = new Set<() => void>();
let version = 0;
const changed = (provider: AiProvider, next: KeyStatus) => {
  keyStatus[provider] = next;
  version++;
  listeners.forEach((l) => l());
};

export async function loadKeyStatus(provider: AiProvider = getSettings().ai.provider): Promise<KeyStatus> {
  if (!isTauri) return { set: false, hint: '' };
  loading.add(provider);
  const s = await invoke<KeyStatus>('ai_key_status', { provider }).catch(() => ({ set: false, hint: '' }));
  loading.delete(provider);
  changed(provider, s);
  return s;
}

/** Saves the provider's key (empty: removes it). */
export async function setApiKey(provider: AiProvider, key: string): Promise<void> {
  changed(provider, await invoke<KeyStatus>('ai_set_key', { provider, key }));
}

/** Whether the provider has a key (Ollama needs none); null until known. Loads it the first time. */
export function useApiKey(provider: AiProvider): KeyStatus | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  const s = keyStatus[provider] ?? null;
  if (s === null && isTauri && !loading.has(provider)) void loadKeyStatus(provider);
  return s;
}

/** Whether the provider in use can answer (a key, or Ollama); asks the first time. */
export function hasApiKey(): boolean {
  const provider = getSettings().ai.provider;
  if (!keyStatus[provider] && isTauri && !loading.has(provider)) void loadKeyStatus(provider);
  return !!keyStatus[provider]?.set;
}

/** The provider's models: chat models of its API, or the models installed in Ollama. */
export function listModels(provider: AiProvider, baseUrl = getSettings().ai.ollamaUrl): Promise<string[]> {
  return invoke<string[]>('ai_models', { provider, baseUrl });
}

/** Code from a model answer: the fenced block's contents when it wrapped the code in one. */
export function stripFences(text: string): string {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

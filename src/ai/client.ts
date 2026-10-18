// Model calls from the UI: streamed through src-tauri/src/ai.rs (which holds the API key), with
// cancellation. Chat, inline edit, commit messages and ghost text all go through `streamAi`.

import { Channel, invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { isTauri } from '../platform';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
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
    invoke('ai_stream', { id, request, onEvent: events }).catch((e) => settle(() => reject(new Error(String(e)))));
  });
  return { done, cancel: () => cancel() };
}

// ── The API key (kept by the Rust side) ─────────────────────────

export interface KeyStatus {
  set: boolean;
  hint: string;
}

let keyStatus: KeyStatus | null = null;
const listeners = new Set<() => void>();
const changed = (next: KeyStatus) => {
  keyStatus = next;
  listeners.forEach((l) => l());
};

export async function loadKeyStatus(): Promise<KeyStatus> {
  if (!isTauri) return { set: false, hint: '' };
  const s = await invoke<KeyStatus>('ai_key_status').catch(() => ({ set: false, hint: '' }));
  changed(s);
  return s;
}

/** Saves the key (empty: removes it). */
export async function setApiKey(key: string): Promise<void> {
  changed(await invoke<KeyStatus>('ai_set_key', { key }));
}

/** Whether a key is set; null until known. Loads it the first time. */
export function useApiKey(): KeyStatus | null {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => keyStatus,
  );
  if (s === null && isTauri) void loadKeyStatus();
  return s;
}

export const hasApiKey = () => !!keyStatus?.set;

/** Code from a model answer: the fenced block's contents when it wrapped the code in one. */
export function stripFences(text: string): string {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}

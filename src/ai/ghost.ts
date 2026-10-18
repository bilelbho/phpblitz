// Ghost text: the fast model suggests the code after the caret while typing, shown grey; Tab
// accepts it. One request after each pause in typing, cancelled as soon as typing goes on. Off by
// default (Settings ▸ Tools ▸ AI): every suggestion is a paid request.

import * as monaco from 'monaco-editor';
import { getSettings } from '../settings';
import { pathOfModel } from '../editor/active';
import { AiCancelled, hasApiKey, loadKeyStatus, stripFences, streamAi } from './client';

/** Typing pause before asking (ms). */
const PAUSE = 450;
const PREFIX = 6000;
const SUFFIX = 2000;

const SYSTEM = `You are a code completion engine in an IDE. You get the code before the caret (<prefix>) and after it (<suffix>).
Answer with only the code to insert at the caret: no explanation, no Markdown, no tags. It must fit between prefix and suffix and must not repeat the suffix. Prefer finishing the current statement or block; at most about 10 lines. If nothing useful fits, answer with nothing.`;

let registered = false;
let last: { key: string; text: string } | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The suggestion with what the suffix already has removed from its end. */
export function trimOverlap(text: string, suffix: string): string {
  const next = suffix.split('\n')[0].trim();
  let out = text.replace(/\s+$/, '');
  if (next && out.endsWith(next)) out = out.slice(0, -next.length).replace(/\s+$/, '');
  return out;
}

export function registerGhostText() {
  if (registered) return;
  registered = true;
  void loadKeyStatus();
  monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, _context, token) {
      if (!getSettings().ai.ghostText || !hasApiKey()) return { items: [] };
      // Only in files of the project (not diff views, consoles…).
      if (model.uri.scheme !== 'file') return { items: [] };
      const offset = model.getOffsetAt(position);
      const all = model.getValue();
      const prefix = all.slice(Math.max(0, offset - PREFIX), offset);
      const suffix = all.slice(offset, offset + SUFFIX);
      // Nothing to go on, or the caret in the middle of a word.
      if (!prefix.trim() || /\w/.test(suffix[0] ?? '')) return { items: [] };
      const key = `${model.uri}:${prefix.slice(-400)}|${suffix.slice(0, 200)}`;
      let text = last?.key === key ? last.text : null;
      if (text === null) {
        await sleep(PAUSE);
        if (token.isCancellationRequested) return { items: [] };
        const stream = streamAi({
          model: getSettings().ai.fastModel,
          maxTokens: 160,
          temperature: 0,
          system: SYSTEM,
          messages: [{ role: 'user', content: `File: ${pathOfModel(model).split('/').pop()} (${model.getLanguageId()})\n<prefix>${prefix}</prefix><suffix>${suffix}</suffix>` }],
        });
        const sub = token.onCancellationRequested(() => stream.cancel());
        try {
          text = trimOverlap(stripFences((await stream.done).text), suffix);
        } catch (e) {
          if (!(e instanceof AiCancelled)) console.warn('Ghost text', e);
          return { items: [] };
        } finally {
          sub.dispose();
        }
        last = { key, text };
      }
      if (!text.trim()) return { items: [] };
      return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
    },
    freeInlineCompletions() {},
  });
}

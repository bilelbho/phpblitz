// Markdown files open like in PhpStorm: editor and live preview side by side, with a toolbar for
// Editor / Editor and Preview / Preview. Shell code blocks get a ▷ that runs them in the terminal.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as monaco from 'monaco-editor';
import { marked, type Token, type TokensList } from 'marked';
import DOMPurify from 'dompurify';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from '../useWorkspace';
import { colorizeCode } from '../editor/markdown';
import { isTauri } from '../platform';
import { runCodeBlock, SHELL_LANGS } from '../markdownBlocks';

export type MarkdownMode = 'editor' | 'split' | 'preview';

const MODE_KEY = 'phpblitz.markdownMode';

function savedMode(): MarkdownMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'editor' || m === 'preview' ? m : 'split';
  } catch {
    return 'split';
  }
}

interface Rendered {
  html: string;
  /** Code of each shell block, by its data-run index in the HTML. */
  runs: string[];
}

/** Markdown → sanitized HTML, each top-level block tagged with its source line for scroll sync. */
function render(text: string): Rendered {
  const tokens = marked.lexer(text, { gfm: true });
  const runs: string[] = [];
  let line = 1;
  const parts: string[] = [];
  for (const token of tokens) {
    const start = line;
    line += (token.raw.match(/\n/g) ?? []).length;
    if (token.type === 'space') continue;
    let html = marked.parser(Object.assign([token], { links: (tokens as TokensList).links }) as TokensList);
    if (token.type === 'code') {
      const lang = ((token as Token & { lang?: string }).lang ?? '').split(/\s/)[0].toLowerCase();
      if (SHELL_LANGS.has(lang)) {
        runs.push((token as Token & { text: string }).text);
        html = `<button type="button" class="md-run" data-run="${runs.length - 1}" title="Run in terminal" aria-label="Run in terminal">▷</button>${html}`;
      }
    }
    parts.push(`<div class="md-block" data-line="${start}">${html}</div>`);
  }
  const html = DOMPurify.sanitize(parts.join(''), { ADD_ATTR: ['data-line', 'data-run', 'target'] });
  return { html, runs };
}

export function MarkdownView({ ws, path, children }: { ws: Workspace; path: string; children: (onEditor: (e: monaco.editor.IStandaloneCodeEditor) => void) => ReactNode }) {
  const [mode, setMode] = useState<MarkdownMode>(savedMode);
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);

  const pick = (m: MarkdownMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Only a preference.
    }
  };

  return (
    <div className={'md-split mode-' + mode}>
      <div className="md-toolbar" role="radiogroup" aria-label="Markdown view">
        {(
          [
            ['editor', 'Editor Only', <path key="e" d="M3 4h10M3 7h10M3 10h10M3 13h6" />],
            ['split', 'Editor and Preview', <path key="s" d="M2.5 3.5h11v9h-11zM8 3.5v9M4 6h2.5M4 8.5h2.5" />],
            ['preview', 'Preview Only', <path key="p" d="M2.5 3.5h11v9h-11zM4.5 10.5l2.5-3 2 2 1.5-1.5 1.5 2.5M10.5 6.2h.01" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className={'md-tool' + (mode === id ? ' on' : '')} title={label} aria-label={label} onClick={() => pick(id)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {icon}
            </svg>
          </button>
        ))}
      </div>
      <div className="md-editor-pane">{children(setEditor)}</div>
      {mode !== 'editor' && <MarkdownPreview ws={ws} path={path} editor={editor} sync={mode === 'split'} />}
    </div>
  );
}

function MarkdownPreview({ ws, path, editor, sync }: { ws: Workspace; path: string; editor: monaco.editor.IStandaloneCodeEditor | null; sync: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<Rendered>(() => render(ws.liveTextOf(path) ?? ws.loaded[path] ?? ''));

  // Live preview while typing.
  useEffect(() => {
    const model = editor?.getModel();
    if (!model) return;
    let timer = 0;
    setRendered(render(model.getValue()));
    const sub = model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRendered(render(model.getValue())), 150);
    });
    return () => {
      window.clearTimeout(timer);
      sub.dispose();
    };
  }, [editor]);

  // Color code blocks with the editor's scheme once they are in the page.
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    let live = true;
    root.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
      const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice(9) ?? '';
      if (!lang) return;
      colorizeCode(code.textContent ?? '', lang).then((html) => {
        if (live) code.innerHTML = html;
      });
    });
    return () => {
      live = false;
    };
  }, [rendered]);

  // Scroll with the editor: the block at the editor's top line goes to the preview's top.
  useEffect(() => {
    if (!editor || !sync) return;
    const follow = () => {
      const root = box.current;
      const model = editor.getModel();
      if (!root || !model) return;
      const top = editor.getScrollTop();
      const line = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
      if (top <= 0) {
        root.scrollTop = 0;
        return;
      }
      const blocks = [...root.querySelectorAll<HTMLElement>('.md-block')];
      let i = blocks.findIndex((b) => Number(b.dataset.line) > line) - 1;
      if (i === -2) i = blocks.length - 1;
      if (i < 0) i = 0;
      const cur = blocks[i];
      if (!cur) return;
      const next = blocks[i + 1];
      const from = Number(cur.dataset.line);
      const to = next ? Number(next.dataset.line) : model.getLineCount() + 1;
      // Fraction of the way through this block, by editor pixels, for smooth scrolling.
      const lineTop = editor.getTopForLineNumber(from);
      const span = Math.max(1, editor.getTopForLineNumber(to) - lineTop);
      const frac = Math.min(1, Math.max(0, (top - lineTop) / span));
      const nextTop = next ? next.offsetTop : root.scrollHeight;
      root.scrollTop = cur.offsetTop + (nextTop - cur.offsetTop) * frac - 16;
    };
    const sub = editor.onDidScrollChange(follow);
    follow();
    return () => sub.dispose();
  }, [editor, sync, rendered]);

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const run = target.closest<HTMLElement>('.md-run');
    if (run) {
      const code = rendered.runs[Number(run.dataset.run)];
      if (code !== undefined) runCodeBlock(ws, code);
      return;
    }
    const a = target.closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(href)) {
      if (isTauri) invoke('open_external', { url: href }).catch(() => {});
      else window.open(href, '_blank', 'noopener');
    } else if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1)).toLowerCase();
      const heading = [...(box.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? [])].find((h) => slug(h.textContent ?? '') === id);
      heading?.scrollIntoView({ block: 'start' });
    } else {
      // A link to another file in the project, relative to this one.
      const [file] = href.split('#');
      const dir = path.slice(0, path.lastIndexOf('/'));
      const parts = `${dir}/${decodeURIComponent(file)}`.split('/');
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === '..') resolved.pop();
        else if (part !== '.' && part !== '') resolved.push(part);
      }
      const abs = (path.startsWith('/') ? '/' : '') + resolved.join('/');
      ws.openFile(abs);
    }
  };

  return <div ref={box} className="md-preview" onClick={onClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');

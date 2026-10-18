// Small Markdown renderer for language server documentation (hover, Ctrl+Q). Code blocks are
// colored with the editor's color scheme; everything else is escaped, so server text can't inject HTML.

import * as monaco from 'monaco-editor';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text: string): string {
  // Code spans first, so their contents aren't formatted.
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span class="md-link" title="$2">$1</span>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/__([^_]+)__/g, '<b>$1</b>')
        .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
        .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<i>$2</i>');
    })
    .join('');
}

/** Fence names → Monaco languages (anything unknown is shown uncolored). */
const LANGS: Record<string, string> = {
  php: 'php', js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript', json: 'json',
  html: 'html', xml: 'xml', css: 'css', scss: 'scss', sql: 'sql', yaml: 'yaml', yml: 'yaml', ini: 'ini', dotenv: 'ini',
  bash: 'shell', sh: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', powershell: 'powershell', ps1: 'powershell',
  dockerfile: 'dockerfile', docker: 'dockerfile', md: 'markdown', markdown: 'markdown', twig: 'twig', blade: 'php',
};

/** Code colored with the editor's color scheme, as HTML lines joined by <br/>. */
export async function colorizeCode(code: string, lang: string): Promise<string> {
  const language = LANGS[lang.toLowerCase()] ?? (lang ? '' : 'php');
  if (!language) return escapeHtml(code).replace(/\n/g, '<br/>');
  // The PHP grammar starts outside <?php: open a block and drop that line again.
  const needsTag = language === 'php' && !/^\s*<\?php/.test(code);
  const html = await monaco.editor.colorize(needsTag ? `<?php\n${code}` : code, language, { tabSize: 4 });
  return needsTag ? html.split(/<br\/?>/).slice(1).join('<br/>') : html;
}

async function codeBlock(code: string, lang: string): Promise<string> {
  let html = await colorizeCode(code, lang || 'php');
  // Language servers start PHP signatures with their own `<?php` line; it isn't part of the signature.
  if ((lang || 'php') === 'php' && /^\s*<\?php/.test(code)) html = html.replace(/^.*?<br\/?>/, '');
  return `<pre class="md-code">${html}</pre>`;
}

function textBlock(text: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      out.push('<hr/>');
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      out.push(`<div class="md-h">${inline(line.replace(/^#+\s*/, ''))}</div>`);
    } else if (/^([-*+]|\d+[.)])\s+/.test(line)) {
      if (paragraph.length) {
        out.push(`<p>${inline(paragraph.join(' '))}</p>`);
        paragraph = [];
      }
      list.push(line.replace(/^([-*+]|\d+[.)])\s+/, ''));
    } else {
      if (list.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return out.join('');
}

export async function renderMarkdown(md: string): Promise<string> {
  const parts: Promise<string>[] = [];
  const fence = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  for (let m = fence.exec(md); m; m = fence.exec(md)) {
    parts.push(Promise.resolve(textBlock(md.slice(last, m.index))));
    parts.push(codeBlock(m[2].replace(/\n$/, ''), m[1]));
    last = fence.lastIndex;
  }
  parts.push(Promise.resolve(textBlock(md.slice(last))));
  return (await Promise.all(parts)).join('');
}

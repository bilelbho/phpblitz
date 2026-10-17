// Rendered documentation comments (PhpStorm's "Render documentation comments" / reader mode):
// each /** … */ block is hidden and replaced by a view zone showing it formatted, with a pencil in
// the gutter to edit it (Ctrl+Alt+Q toggles the block at the caret).

import * as monaco from 'monaco-editor';

export interface DocTag {
  tag: string;
  type?: string;
  name?: string;
  text: string;
}

export interface DocBlock {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  indent: number;
  summary: string;
  tags: DocTag[];
}

/** Multi-line /** … *\/ blocks that stand on their own lines. */
export function findDocBlocks(lines: string[]): DocBlock[] {
  const out: DocBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)\/\*\*(?!\/)/.exec(lines[i]);
    if (!m || /\*\/\s*$/.test(lines[i].slice(m[0].length))) continue; // one-line /** @var X $x */ stays as is
    let j = i + 1;
    while (j < lines.length && !lines[j].includes('*/')) j++;
    if (j >= lines.length) break;
    if (lines[j].slice(lines[j].indexOf('*/') + 2).trim()) {
      i = j;
      continue; // code after */ on the same line: hiding it would hide code
    }
    const parsed = parseDocComment(lines.slice(i, j + 1));
    if (parsed.summary || parsed.tags.length) out.push({ start: i + 1, end: j + 1, indent: m[1].replace(/\t/g, '    ').length, ...parsed });
    i = j;
  }
  return out;
}

const TYPED = new Set(['param', 'return', 'throws', 'var', 'property', 'property-read', 'property-write', 'method']);
const NAMED = new Set(['param', 'var', 'property', 'property-read', 'property-write']);

export function parseDocComment(raw: string[]): { summary: string; tags: DocTag[] } {
  const body = raw
    .map((l, k) => {
      let s = l;
      if (k === 0) s = s.replace(/^\s*\/\*\*/, '');
      if (k === raw.length - 1) s = s.replace(/\*\/\s*$/, '');
      return s.replace(/^\s*\*(?!\/) ?/, '').replace(/\s+$/, '');
    })
    .filter((_, k, all) => !(k === 0 && !all[0].trim()));
  const summary: string[] = [];
  const tags: DocTag[] = [];
  for (const line of body) {
    const t = /^@([\w-]+)\s*(.*)$/.exec(line.trim());
    if (t) {
      const tag = t[1].replace(/^(psalm|phpstan)-/, '');
      let rest = t[2];
      const entry: DocTag = { tag, text: '' };
      if (TYPED.has(tag)) {
        const type = takeType(rest);
        if (type && !type.startsWith('$')) {
          entry.type = type;
          rest = rest.slice(type.length).trim();
        }
      }
      if (NAMED.has(tag)) {
        const n = /^(&?\.{3}\$\w+|&?\$\w+)\s*(.*)$/.exec(rest);
        if (n) {
          entry.name = n[1];
          rest = n[2];
        }
      }
      entry.text = rest;
      tags.push(entry);
    } else if (tags.length) {
      const last = tags[tags.length - 1];
      last.text += last.text && line.trim() ? `\n${line.trim()}` : line.trim() ? line.trim() : '\n';
    } else summary.push(line);
  }
  for (const t of tags) t.text = t.text.trim();
  return { summary: summary.join('\n').trim(), tags };
}

/** A type at the start of `s`, with generics and shapes: array<int, string>, array{a: int}|null. */
function takeType(s: string): string {
  let depth = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if ('<({['.includes(c)) depth++;
    else if ('>)}]'.includes(c)) depth--;
    else if (/\s/.test(c) && depth <= 0) {
      // "int | null" style unions continue past spaces around |
      if (s[i + 1] === '|' || s[i - 1] === '|') continue;
      break;
    }
  }
  return s.slice(0, i);
}

// ── HTML ───────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_TAGS = /&lt;(\/?)(p|br|b|i|em|strong|code|pre|ul|ol|li|tt)\s*\/?&gt;/gi;

/** Doc text: a few HTML tags, `code`, {@link X}, blank lines as paragraphs. */
function prose(s: string): string {
  return esc(s)
    .replace(SAFE_TAGS, (_, close, tag) => `<${close}${tag.toLowerCase()}>`)
    .replace(/\{@(?:link|see)\s+([^}\s]+)(?:\s+([^}]*))?\}/g, (_, target, label) => `<code>${label || shortName(target)}</code>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/https?:\/\/[^\s<)]+/g, (u) => `<a href="${u}" data-href="${u}">${u}</a>`)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, ' '))
    .join('<br><br>');
}

const shortName = (fqcn: string) => fqcn.replace(/^\\/, '').split('\\').pop() || fqcn;

function typeChips(type: string): string {
  // Unions: one chip per member, FQCNs shortened (full name in the tooltip).
  const parts = type.split(/\|(?![^<{(]*[>})])/);
  return parts.map((p) => `<code class="doc-type" title="${esc(p)}">${esc(p.replace(/\\?(?:[\w]+\\)+(\w+)/g, '$1'))}</code>`).join('<span class="doc-sep">|</span>');
}

const LABELS: Record<string, string> = {
  param: 'Parameters',
  return: 'Returns',
  throws: 'Throws',
  var: 'Type',
  see: 'See also',
  since: 'Since',
  author: 'Author',
  version: 'Version',
  link: 'Link',
  example: 'Example',
  todo: 'To do',
  property: 'Properties',
  'property-read': 'Properties',
  'property-write': 'Properties',
  method: 'Methods',
  template: 'Type parameters',
  internal: 'Internal',
  uses: 'Uses',
};

const FLAG_LABELS: Record<string, string> = { final: 'Final', internal: 'Internal', api: 'API', abstract: 'Abstract', static: 'Static', immutable: 'Immutable', readonly: 'Read-only', experimental: 'Experimental', pure: 'Pure' };

export function renderDocBlock(b: DocBlock): string {
  let html = '';
  const deprecated = b.tags.find((t) => t.tag === 'deprecated');
  if (deprecated) html += `<div class="doc-deprecated"><b>Deprecated</b>${deprecated.text ? ` ${prose(deprecated.text)}` : ''}</div>`;
  if (b.summary) html += `<div class="doc-summary">${prose(b.summary)}</div>`;

  // Tags without a value (@final, @internal, @api…) are markers: one line of labels, no colon.
  const flags = b.tags.filter((t) => !t.type && !t.name && !t.text && t.tag !== 'deprecated' && !/^inheritdoc$/i.test(t.tag));
  if (flags.length) html += `<div class="doc-flags">${flags.map((t) => `<span class="doc-flag">${esc(FLAG_LABELS[t.tag] ?? t.tag)}</span>`).join('')}</div>`;

  const groups = new Map<string, DocTag[]>();
  for (const t of b.tags) {
    if (t.tag === 'deprecated' || /^inheritdoc$/i.test(t.tag) || flags.includes(t)) continue;
    const label = LABELS[t.tag] ?? `@${t.tag}`;
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  if (groups.size) {
    html += '<div class="doc-tags">';
    for (const [label, tags] of groups) {
      html += `<div class="doc-label">${esc(label)}:</div><div class="doc-values">`;
      for (const t of tags) {
        let row = '';
        if (t.type) row += typeChips(t.type) + ' ';
        if (t.name) row += `<code class="doc-name">${esc(t.name)}</code> `;
        if (t.text) {
          const text = t.tag === 'see' || t.tag === 'uses' ? `<code>${esc(shortName(t.text.split(/\s/)[0]))}</code>${esc(t.text.slice(t.text.split(/\s/)[0].length))}` : prose(t.text);
          row += (t.type || t.name ? '– ' : '') + text;
        }
        html += `<div class="doc-value">${row}</div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  return html;
}

// ── Editor integration ─────────────────────────────────────────

const HIDDEN = 'phpblitz.docs';

interface Rendered {
  zoneId: string;
  /** Tracks the block's lines through edits. */
  decoration: string;
  margin: HTMLElement;
}

/**
 * Renders the doc comments of the editor's model. `enabled()` is read on every model switch, so
 * turning the setting off and on takes effect for the next file (or `refresh()`).
 */
export function setupDocComments(editor: monaco.editor.IStandaloneCodeEditor, enabled: () => boolean) {
  let rendered: Rendered[] = [];
  /** Raw (being edited) blocks: their tracked decorations, with the "render" glyph. */
  let raw: string[] = [];
  const disposables: monaco.IDisposable[] = [];

  const hidden = () =>
    rendered
      .map((r) => editor.getModel()?.getDecorationRange(r.decoration))
      .filter((r): r is monaco.Range => !!r)
      .map((r) => new monaco.Range(r.startLineNumber, 1, r.endLineNumber, 1));
  const applyHidden = () => (editor as unknown as { setHiddenAreas(r: monaco.IRange[], source?: unknown): void }).setHiddenAreas(hidden(), HIDDEN);

  /** The "render" icon on the first line of each raw block. */
  const glyphs = editor.createDecorationsCollection();
  const rawLine = (id: string) => editor.getModel()?.getDecorationRange(id)?.startLineNumber;
  const syncGlyphs = () =>
    glyphs.set(
      raw
        .map(rawLine)
        .filter((l): l is number => !!l)
        .map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: 'doc-raw-glyph', glyphMarginHoverMessage: { value: 'Toggle Rendered View (Ctrl+Alt+Q)' } } })),
    );

  const clear = () => {
    const model = editor.getModel();
    editor.changeViewZones((acc) => rendered.forEach((r) => acc.removeZone(r.zoneId)));
    model?.deltaDecorations([...rendered.map((r) => r.decoration), ...raw], []);
    rendered = [];
    raw = [];
    glyphs.clear();
    applyHidden();
  };

  type Zone = monaco.editor.IViewZone & { __id?: string };
  const zoneFor = (b: DocBlock): { zone: Zone; dom: HTMLElement; margin: HTMLElement } => {
    const dom = document.createElement('div');
    dom.className = 'doc-render';
    const char = editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
    const inner = document.createElement('div');
    inner.className = 'doc-render-inner';
    inner.style.marginLeft = `${b.indent * char}px`;
    inner.innerHTML = renderDocBlock(b);
    dom.appendChild(inner);
    const margin = document.createElement('div');
    margin.className = 'doc-render-margin';
    const pencil = document.createElement('button');
    pencil.type = 'button';
    pencil.className = 'doc-render-edit';
    pencil.title = 'Toggle Rendered View (Ctrl+Alt+Q)';
    pencil.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    margin.appendChild(pencil);
    const zone: monaco.editor.IViewZone & { __id?: string } = {
      afterLineNumber: b.start - 1,
      heightInPx: 24,
      domNode: dom,
      marginDomNode: margin,
      suppressMouseDown: false,
      showInHiddenAreas: true,
    };
    return { zone, dom: inner, margin };
  };

  const render = (blocks: DocBlock[]) => {
    const model = editor.getModel();
    if (!model || !blocks.length) return;
    const ids = model.deltaDecorations(
      [],
      blocks.map((b) => ({ range: new monaco.Range(b.start, 1, b.end, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } })),
    );
    const measure: { zone: monaco.editor.IViewZone & { __id?: string }; dom: HTMLElement }[] = [];
    editor.changeViewZones((acc) => {
      blocks.forEach((b, k) => {
        const z = zoneFor(b);
        z.zone.__id = acc.addZone(z.zone);
        rendered.push({ zoneId: z.zone.__id, decoration: ids[k], margin: z.margin });
        measure.push(z);
      });
    });
    applyHidden();
    // Fit each zone to its content once it is laid out (and again when the width changes it).
    const fit = () =>
      editor.changeViewZones((acc) => {
        for (const m of measure) {
          if (!m.zone.__id || !rendered.some((r) => r.zoneId === m.zone.__id)) continue;
          const h = Math.ceil(m.dom.getBoundingClientRect().height) + 8;
          if (h > 8 && h !== m.zone.heightInPx) {
            m.zone.heightInPx = h;
            acc.layoutZone(m.zone.__id);
          }
        }
      });
    requestAnimationFrame(fit);
    const ro = new ResizeObserver(() => requestAnimationFrame(fit));
    measure.forEach((m) => ro.observe(m.dom));
    observers.push(ro);
  };
  const observers: ResizeObserver[] = [];

  /** Shows a block's source again; `focus` puts the caret in it. */
  const unrender = (r: Rendered, focus: boolean) => {
    const model = editor.getModel();
    const range = model?.getDecorationRange(r.decoration);
    editor.changeViewZones((acc) => acc.removeZone(r.zoneId));
    rendered = rendered.filter((x) => x !== r);
    model?.deltaDecorations([r.decoration], []);
    applyHidden();
    if (!model || !range) return;
    raw.push(
      ...model.deltaDecorations(
        [],
        [
          {
            range: new monaco.Range(range.startLineNumber, 1, range.endLineNumber, 1),
            options: {
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ],
      ),
    );
    syncGlyphs();
    if (focus) {
      editor.setPosition({ lineNumber: range.startLineNumber + 1, column: model.getLineMaxColumn(range.startLineNumber + 1) });
      editor.revealLineInCenterIfOutsideViewport(range.startLineNumber);
      editor.focus();
    }
  };

  /** Renders a raw block again (if it is still a doc comment). */
  const rerender = (id: string) => {
    const model = editor.getModel();
    const range = model?.getDecorationRange(id);
    raw = raw.filter((x) => x !== id);
    model?.deltaDecorations([id], []);
    syncGlyphs();
    if (!model || !range) return;
    const lines = model.getLinesContent();
    const block = findDocBlocks(lines).find((b) => b.start <= range.startLineNumber && b.end >= range.startLineNumber);
    if (block) render([block]);
  };

  const refresh = () => {
    observers.splice(0).forEach((o) => o.disconnect());
    clear();
    const model = editor.getModel();
    if (!model || !enabled() || model.getLanguageId() !== 'php') return;
    render(findDocBlocks(model.getLinesContent()));
  };

  disposables.push(editor.onDidChangeModel(refresh));
  disposables.push(
    editor.onDidChangeModelContent(() => {
      // A rendered block that no longer is one (deleted, mangled by an edit around it): show it raw.
      const model = editor.getModel();
      if (!model) return;
      for (const r of [...rendered]) {
        const range = model.getDecorationRange(r.decoration);
        const ok = range && /^\s*\/\*\*/.test(model.getLineContent(range.startLineNumber)) && model.getLineContent(range.endLineNumber).includes('*/');
        if (!ok) unrender(r, false);
      }
    }),
  );
  // Hover feedback for the pencil (it is under Monaco's margin layer).
  disposables.push(
    editor.onMouseMove((e) => {
      const zoneId = e.target.type === monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE ? (e.target.detail as { viewZoneId?: string }).viewZoneId : undefined;
      for (const r of rendered) r.margin.classList.toggle('hover', r.zoneId === zoneId);
    }),
    editor.onMouseLeave(() => rendered.forEach((r) => r.margin.classList.remove('hover'))),
  );
  disposables.push(
    editor.onMouseDown((e) => {
      if (!e.event.leftButton) return; // right-click: the gutter menu
      const T = monaco.editor.MouseTargetType;
      // Zones sit under Monaco's own layers, so their clicks arrive here: the pencil (margin),
      // a double click in the text, or a link.
      if (e.target.type === T.GUTTER_VIEW_ZONE || e.target.type === T.CONTENT_VIEW_ZONE) {
        const zoneId = (e.target.detail as { viewZoneId?: string }).viewZoneId;
        const r = rendered.find((x) => x.zoneId === zoneId);
        if (!r) return;
        const { posx, posy } = e.event;
        const link = document.elementsFromPoint(posx, posy).find((el) => el.matches('.doc-render a[data-href]'));
        if (link) window.open(link.getAttribute('data-href')!, '_blank');
        else if (e.target.type === T.GUTTER_VIEW_ZONE || e.event.detail === 2) unrender(r, true);
        else return;
        e.event.preventDefault();
        return;
      }
      if (e.target.type !== T.GUTTER_GLYPH_MARGIN || !e.target.position) return;
      const model = editor.getModel();
      const line = e.target.position.lineNumber;
      const id = raw.find((x) => rawLine(x) === line);
      // After the other gutter listeners, which ask ownsGlyph() to skip their breakpoint toggle.
      if (id) queueMicrotask(() => rerender(id));
    }),
  );

  /** Ctrl+Alt+Q: the rendered block just above the caret, or the raw block around it. */
  const toggleAtCaret = () => {
    const model = editor.getModel();
    const line = editor.getPosition()?.lineNumber;
    if (!model || !line) return;
    const inRaw = raw.find((x) => {
      const r = model.getDecorationRange(x);
      return r && r.startLineNumber <= line && r.endLineNumber >= line;
    });
    if (inRaw) return rerender(inRaw);
    const above = rendered.find((r) => model.getDecorationRange(r.decoration)?.endLineNumber === line - 1);
    if (above) return unrender(above, true);
    const block = findDocBlocks(model.getLinesContent()).find((b) => (b.start <= line && b.end >= line) || b.end === line - 1);
    if (block && !rendered.some((r) => model.getDecorationRange(r.decoration)?.startLineNumber === block.start)) {
      render([block]);
      editor.setPosition({ lineNumber: block.end + 1, column: 1 });
    }
  };
  editor.addAction({
    id: 'phpblitz.toggleRenderedDoc',
    label: 'Toggle Rendered View',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyQ],
    run: toggleAtCaret,
  });

  refresh();
  return {
    refresh,
    /** Whether a gutter click on this line is the "render" icon (so it isn't a breakpoint). */
    ownsGlyph: (line: number) => raw.some((x) => rawLine(x) === line),
    dispose: () => {
      observers.forEach((o) => o.disconnect());
      clear();
      disposables.forEach((d) => d.dispose());
    },
  };
}

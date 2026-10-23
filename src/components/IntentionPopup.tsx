// Alt+Enter / lightbulb popup: the actions on the left, a preview of what the
// selected one would change on the right (toggle with Ctrl+Q).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon } from './Icon';
import type { TextChange } from '../lsp/monacoBridge';

type Item = Extract<ContextItem, { label: string }>;
/** Columns (0-based, end exclusive) of new text on a preview line, highlighted. */
type Mark = { line: number; from: number; to: number };
type Preview = { state: 'loading' } | { state: 'none' } | { state: 'ready'; first: number; lines: string[]; marks: Mark[] };

const PREVIEW_KEY = 'phpblitz.intentionPreview';
const MAX_PREVIEW_LINES = 14;

function previewWanted() {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** The changed lines of the file after applying `changes`, colored. */
async function renderPreview(model: monaco.editor.ITextModel, changes: TextChange[]): Promise<Preview> {
  if (!changes.length) return { state: 'none' };
  const before = model.getValue();
  const ordered = [...changes].sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn);
  let after = before;
  for (const c of ordered) {
    const start = model.getOffsetAt({ lineNumber: c.startLine, column: c.startColumn });
    const end = model.getOffsetAt({ lineNumber: c.endLine, column: c.endColumn });
    after = after.slice(0, start) + c.text + after.slice(end);
  }
  if (after === before) return { state: 'none' };
  // Where each change's new text ends up in the result (changes applied in order, shifting later ones).
  const inserted: [number, number][] = [];
  let delta = 0;
  for (const c of [...ordered].reverse()) {
    const start = model.getOffsetAt({ lineNumber: c.startLine, column: c.startColumn });
    const end = model.getOffsetAt({ lineNumber: c.endLine, column: c.endColumn });
    if (c.text) inserted.push([start + delta, start + delta + c.text.length]);
    delta += c.text.length - (end - start);
  }
  // Changed lines: everything between the common first and last lines.
  const a = before.split('\n');
  const b = after.split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let bottom = 0;
  while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++;
  const from = Math.min(top, b.length - 1);
  const to = Math.min(b.length, Math.max(b.length - bottom, top + 1), from + MAX_PREVIEW_LINES);
  const snippet = b.slice(from, to);
  // The PHP grammar starts outside <?php; open a PHP block first and drop that line again.
  const language = model.getLanguageId();
  const code = language === 'php' ? '<?php\n' + snippet.join('\n') : snippet.join('\n');
  const html = await monaco.editor.colorize(code, language, { tabSize: 4 });
  const lines = html.split(/<br\/?>/);
  // Offsets → (line, column) marks on the shown lines; whitespace-only stretches aren't marked.
  const lineStart = [0];
  for (let i = 0; i < after.length; i++) if (after[i] === '\n') lineStart.push(i + 1);
  const lineOf = (off: number) => {
    let lo = 0;
    while (lo + 1 < lineStart.length && lineStart[lo + 1] <= off) lo++;
    return lo;
  };
  const marks: Mark[] = [];
  for (const [s, e] of inserted) {
    for (let l = lineOf(s); l <= lineOf(Math.max(s, e - 1)) && l < to; l++) {
      if (l < from) continue;
      const text = b[l];
      let a0 = Math.max(s, lineStart[l]) - lineStart[l];
      let a1 = Math.min(e, lineStart[l] + text.length) - lineStart[l];
      while (a0 < a1 && text[a0] === ' ') a0++;
      while (a1 > a0 && text[a1 - 1] === ' ') a1--;
      if (a1 > a0) marks.push({ line: l - from, from: a0, to: a1 });
    }
  }
  return { state: 'ready', first: from + 1, marks, lines: language === 'php' ? lines.slice(1, snippet.length + 1) : lines.slice(0, snippet.length) };
}

interface Props {
  x: number;
  y: number;
  items: ContextItem[];
  model: monaco.editor.ITextModel | null;
  onClose: () => void;
}

export function IntentionPopup({ x, y, items, model, onClose }: Props) {
  const choices = items.map((it, i) => ({ it, i })).filter((c): c is { it: Item; i: number } => c.it.kind !== 'sep' && !c.it.disabled);
  const [selected, setSelected] = useState(choices[0]?.i ?? -1);
  const [showPreview, setShowPreview] = useState(previewWanted);
  const [preview, setPreview] = useState<Preview>({ state: 'none' });
  const [submenu, setSubmenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [pos, setPos] = useState({ x, y });
  const box = useRef<HTMLDivElement>(null);
  const chord = useRef(false);
  const current = items[selected] as Item | undefined;
  const hasIcons = items.some((it) => it.kind !== 'sep' && it.icon === 'bulb');

  // Keep the popup on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: r.bottom > window.innerHeight - 8 ? Math.max(8, y - r.height - 24) : y });
  }, [x, y]);

  // Preview of the selected action.
  useEffect(() => {
    if (!showPreview || !current?.preview || !model) {
      setPreview({ state: 'none' });
      return;
    }
    let live = true;
    setPreview({ state: 'loading' });
    current
      .preview()
      .then((changes) => (changes ? renderPreview(model, changes) : ({ state: 'none' } as Preview)))
      .catch((): Preview => ({ state: 'none' }))
      .then((p) => live && setPreview(p));
    return () => {
      live = false;
    };
  }, [current, showPreview, model]);

  const togglePreview = () =>
    setShowPreview((on) => {
      try {
        localStorage.setItem(PREVIEW_KEY, on ? 'off' : 'on');
      } catch {
        // Only a preference.
      }
      return !on;
    });

  const openSubmenu = (index: number) => {
    const it = items[index] as Item | undefined;
    const row = box.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!it?.submenu || !row) return;
    const r = row.getBoundingClientRect();
    setSubmenu({ x: r.right + 2, y: r.top - 4, items: it.submenu });
  };

  const run = (index: number) => {
    const it = items[index] as Item | undefined;
    if (!it || it.disabled) return;
    if (!it.run && it.submenu) return openSubmenu(index);
    onClose();
    it.run?.();
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (submenu) return; // the submenu handles its own keys
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Ctrl+Q, or Ctrl+K then Ctrl+I: toggle the preview.
      if ((ctrl && k === 'q') || (chord.current && ctrl && k === 'i')) {
        e.preventDefault();
        e.stopPropagation();
        chord.current = false;
        togglePreview();
        return;
      }
      chord.current = ctrl && k === 'k';
      if (chord.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const at = choices.findIndex((c) => c.i === selected);
      const handled = (() => {
        switch (e.key) {
          case 'ArrowDown':
            if (choices.length) setSelected(choices[(at + 1) % choices.length].i);
            return true;
          case 'ArrowUp':
            if (choices.length) setSelected(choices[(at - 1 + choices.length) % choices.length].i);
            return true;
          case 'Home':
            if (choices.length) setSelected(choices[0].i);
            return true;
          case 'End':
            if (choices.length) setSelected(choices[choices.length - 1].i);
            return true;
          case 'ArrowRight':
            openSubmenu(selected);
            return true;
          case 'Enter':
            run(selected);
            return true;
          case 'Escape':
            onClose();
            return true;
          default: {
            // A one-character hint (Surround With's 1, 2, … a, b) picks its item.
            if (ctrl || e.altKey || e.key.length !== 1) return false;
            const hit = choices.find((c) => (items[c.i] as Item).shortcut?.toLowerCase() === k);
            if (!hit) return false;
            run(hit.i);
            return true;
          }
        }
      })();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const outside = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.intention-popup, .intention-preview, .ctx-menu')) onClose();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('blur', onClose);
    };
  });

  return (
    <>
      <div ref={box} className="intention-popup" role="menu" aria-label="Context actions" style={{ left: pos.x, top: pos.y }}>
        <div className="intention-list">
          {items.map((it, i) =>
            it.kind === 'sep' ? (
              <div key={i} className="intention-sep" role="separator" />
            ) : (
              <div
                key={i}
                data-index={i}
                role="menuitem"
                aria-disabled={it.disabled || undefined}
                className={'intention-item' + (i === selected ? ' selected' : '') + (it.disabled ? ' disabled' : '')}
                onMouseEnter={() => !it.disabled && setSelected(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(i)}
              >
                {hasIcons && <span className="intention-icon">{it.icon === 'bulb' && <BulbIcon />}</span>}
                <span className="intention-label">{it.label}</span>
                {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
                {it.submenu && (
                  <button
                    type="button"
                    className="intention-more"
                    aria-label={`${it.label} options`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(i);
                      openSubmenu(i);
                    }}
                  >
                    <Icon name="more" size={13} />
                  </button>
                )}
              </div>
            ),
          )}
        </div>
        <div className="intention-foot">Press Ctrl+Q to toggle preview</div>
      </div>
      {showPreview && preview.state !== 'none' && (
        <IntentionPreview anchor={box} preview={preview} />
      )}
      {submenu && <ContextMenu x={submenu.x} y={submenu.y} items={submenu.items} onClose={() => { setSubmenu(null); onClose(); }} />}
    </>
  );
}

function IntentionPreview({ anchor, preview }: { anchor: React.RefObject<HTMLDivElement | null>; preview: Preview }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setAt({ left: r.right + 6, top: r.top });
  }, [anchor, preview]);
  if (!at) return null;
  return (
    <div className="intention-preview" style={{ left: at.left, top: at.top }} aria-label="Preview">
      {preview.state === 'loading' ? (
        <div className="muted intention-preview-wait">Loading preview…</div>
      ) : preview.state === 'ready' ? (
        preview.lines.map((html, i) => (
          <div key={i} className="intention-preview-line">
            <span className="ln">{preview.first + i}</span>
            <span className="code">
              {preview.marks
                .filter((m) => m.line === i)
                .map((m, j) => (
                  <span key={j} className="mark" style={{ left: `${m.from}ch`, width: `${m.to - m.from}ch` }} />
                ))}
              <span dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
            </span>
          </div>
        ))
      ) : null}
    </div>
  );
}

/** The yellow quick-fix bulb. */
function BulbIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5a4.5 4.5 0 0 0-2.7 8.1c.4.3.7.8.7 1.3V12h4v-1.1c0-.5.3-1 .7-1.3A4.5 4.5 0 0 0 8 1.5Z" fill="#F2C55C" />
      <path d="M6 13.2h4M6.6 14.6h2.8" stroke="#CED0D6" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

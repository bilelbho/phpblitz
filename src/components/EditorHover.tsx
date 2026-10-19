// The editor popup on hover, F2 (next problem) and Ctrl+Q: the problem with its first quick
// fix on top ("More actions…" opens Alt+Enter), the language server's documentation below.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { markersAt, quickFixesFor, variableAt, type QuickFix } from '../editorMenu';
import { typoAt, typoMarker, type Typo } from '../editor/spelling';
import { debug } from '../debug/manager';
import type { Property } from '../debug/dbgp';
import { VarNode } from './VarNode';
import { hoverAt } from '../lsp/monacoBridge';
import { isScriptModel, scriptHover } from '../jsProjects';
import { renderMarkdown } from '../editor/markdown';
import { copyText } from '../editorMenu';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon } from './Icon';

export interface HoverRequest {
  line: number;
  column: number;
  /** Screen point under the word the popup belongs to; it opens below (or above) that line. */
  x: number;
  top: number;
  bottom: number;
  /** Mouse hovers close when the pointer leaves; keyboard ones on the next key or caret move. */
  source: 'mouse' | 'keyboard';
  /** Ctrl+Q: documentation only. */
  docOnly?: boolean;
}

interface Problem {
  marker: monaco.editor.IMarker;
  fixes: QuickFix[] | null;
}

interface Props {
  editor: monaco.editor.IStandaloneCodeEditor;
  ws: Workspace;
  path: string;
  request: HoverRequest;
  onMoreActions: () => void;
  onClose: () => void;
  /** Called when the popup has nothing to show. */
  onEmpty: () => void;
  /** A typo's actions (Typo: Rename to…, Save to dictionary). */
  typoFixes: (typo: Typo) => QuickFix[];
}

export function EditorHover({ editor, ws, path, request, onMoreActions, onClose, onEmpty, typoFixes }: Props) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  /** While stopped in the debugger: the value of the variable under the mouse. */
  const [value, setValue] = useState<Property | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const model = editor.getModel();

  useEffect(() => {
    if (!model) return;
    let live = true;
    const pos = { lineNumber: request.line, column: request.column };
    // A problem first; else a typo (shown the same way, with its own actions).
    const typo = request.docOnly ? null : typoAt(model, pos);
    const marker = request.docOnly ? undefined : markersAt(model, pos)[0] ?? (typo ? typoMarker(model, typo) : undefined);
    setProblem(marker ? { marker, fixes: marker.owner === 'spelling' && typo ? typoFixes(typo) : null } : null);
    setDoc(null);
    setValue(null);
    if (marker && marker.owner !== 'spelling') quickFixesFor(editor, ws, path, marker).then((fixes) => live && setProblem({ marker, fixes }));
    const expression = !request.docOnly && debug.active?.status === 'break' ? variableAt(model.getLineContent(pos.lineNumber), pos.column) : '';
    const valueLookup = expression ? debug.hoverValue(expression).then((p) => (p ? { ...p, name: expression, fullname: expression } : null)) : Promise.resolve(null);
    const docLookup = (isScriptModel(model) ? scriptHover(model, pos) : hoverAt(model, pos))
      .then((md) => (md ? renderMarkdown(md) : null))
      .catch(() => null);
    void Promise.all([docLookup, valueLookup]).then(([html, val]) => {
      if (!live) return;
      setDoc(html);
      setValue(val);
      if (!marker && !html && !val) onEmpty();
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Below the line when it fits, else above it; never off screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = request.bottom + 4;
    const top = below + r.height > window.innerHeight - 8 && request.top - r.height - 4 > 8 ? request.top - r.height - 4 : below;
    setPlace({ left: Math.max(8, Math.min(request.x, window.innerWidth - r.width - 8)), top: Math.max(8, top) });
  }, [request, problem, doc, value]);

  // Keyboard popups close: Escape, typing or moving the caret.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const outside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.pb-hover, .ctx-menu')) onClose();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', outside, true);
    const subs = [editor.onDidScrollChange((e) => (e.scrollTopChanged || e.scrollLeftChanged) && onClose()), editor.onDidChangeModelContent(onClose)];
    if (request.source === 'keyboard') subs.push(editor.onDidChangeCursorPosition(onClose));
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', outside, true);
      subs.forEach((s) => s.dispose());
    };
  }, [editor, request, onClose]);

  // Nothing yet (documentation still loading), or nothing at all (onEmpty closes it).
  if (!problem && !doc && !value) return null;

  const m = problem?.marker;
  const [title, ...rest] = (m?.message ?? '').split(/\n\s*\n/);
  const code = typeof m?.code === 'string' ? m.code : m?.code?.value;
  const severity = m ? (m.owner === 'spelling' ? 'typo' : m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info') : null;
  const firstFix = problem?.fixes?.[0];

  const optionsMenu = (e: React.MouseEvent) => {
    if (!m) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const p = (ws.problems[path] ?? []).find((x) => x.code === code && x.line <= m.startLineNumber && (x.endLine ?? x.line) >= m.startLineNumber);
    setMenu({
      x: r.right - 220,
      y: r.bottom + 4,
      items: [
        { label: 'Copy Problem Description', icon: 'copy', run: () => copyText(ws, m.message, 'problem description') },
        ...(problem?.fixes?.length ? [{ kind: 'sep' as const }, ...problem.fixes.map((f) => ({ label: f.title, icon: 'bulb' as const, run: () => (onClose(), f.run()) }))] : []),
        ...(p?.category === 'lint' || p?.category === 'analysis'
          ? [
              { kind: 'sep' as const },
              { label: 'Suppress for This Line', run: () => (onClose(), ws.suppressProblem(path, p)) },
              { label: `Disable '${p.code}' in mago.toml`, disabled: ws.backend.kind !== 'disk', run: () => (onClose(), ws.disableMagoRule(p)) },
            ]
          : []),
      ],
    });
  };

  return (
    <div
      ref={box}
      className={'pb-hover' + (severity ? ` sev-${severity}` : '')}
      role="tooltip"
      style={place ? { left: place.left, top: place.top } : { left: request.x, top: request.bottom + 4, visibility: 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {value && (
        <div className="pb-hover-debug debug-tree" role="tree">
          <VarNode p={value} context={0} depth={0} onMenu={(e) => e.preventDefault()} />
        </div>
      )}
      {m && (
        <div className="pb-hover-problem">
          <div className="pb-hover-head">
            <div className="pb-hover-msg">
              <div>{title}</div>
              {rest.map((para, i) => (
                <div key={i} className="pb-hover-help">
                  {para}
                </div>
              ))}
            </div>
            <button type="button" className="icon-btn small" aria-label="Problem options" title="More" onClick={optionsMenu}>
              <Icon name="more" size={13} />
            </button>
          </div>
          <div className="pb-hover-fixes">
            {problem?.fixes === null ? (
              <span className="muted">Looking for quick fixes…</span>
            ) : firstFix ? (
              <>
                <button
                  type="button"
                  className="pb-hover-fix"
                  onClick={() => {
                    onClose();
                    firstFix.run();
                  }}
                >
                  {firstFix.title}
                </button>
                <span className="pb-hover-key">Alt+Shift+Enter</span>
              </>
            ) : null}
            <button
              type="button"
              className="pb-hover-fix"
              onClick={() => {
                onClose();
                onMoreActions();
              }}
            >
              More actions…
            </button>
            <span className="pb-hover-key">Alt+Enter</span>
            {(m.source || code) && (
              <span className="pb-hover-source">
                {m.source}
                {code ? ` (${code})` : ''}
              </span>
            )}
          </div>
        </div>
      )}
      {doc && <div className="pb-hover-doc md" dangerouslySetInnerHTML={{ __html: doc }} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

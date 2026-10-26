// replacements for Monaco's VS Code popups:
// Go to Line:Column (Ctrl+G), the Find/Replace bar (Ctrl+F / Ctrl+R) and File Structure (Ctrl+F12).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { PhpSymbol } from '../php';
import { Icon, Sym, Visibility } from './Icon';
import { SYMBOL_KIND, symbolLabel } from './StructurePanel';
import { jumpedTo } from '../navHistory';
import { uriToPath } from '../lsp/client';

type Editor = monaco.editor.IStandaloneCodeEditor;

// ── Go to Line:Column ─────────────────────────────────────────

export function GotoLineDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const pos = editor.getPosition();
  const [value, setValue] = useState(pos ? `${pos.lineNumber}:${pos.column}` : '1');
  const input = useRef<HTMLInputElement>(null);
  const lines = editor.getModel()?.getLineCount() ?? 1;
  const m = value.trim().match(/^(\d+)?(?:\s*[:,]\s*(\d+))?$/);
  const valid = !!m && (!!m[1] || !!m[2]);

  useEffect(() => { input.current?.select(); }, []);

  const go = () => {
    if (!m || !valid) return;
    const line = Math.min(Math.max(Number(m[1] ?? pos?.lineNumber ?? 1), 1), lines);
    const model = editor.getModel()!;
    const column = Math.min(Math.max(Number(m[2] ?? 1), 1), model.getLineMaxColumn(line));
    onClose();
    jumpedTo({ path: uriToPath(model.uri.toString()), line, column });
    editor.setPosition({ lineNumber: line, column });
    editor.revealPositionInCenter({ lineNumber: line, column });
    editor.focus();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pb-dialog" role="dialog" aria-modal="true" aria-labelledby="goto-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="pb-dialog-title" id="goto-title">
          Go to Line:Column
        </div>
        <div className="pb-dialog-body">
          <label htmlFor="goto-line">[Line] [:column]:</label>
          <div className={'field' + (valid ? '' : ' invalid')}>
            <input
              id="goto-line"
              ref={input}
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                go();
              }}
            />
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            Lines 1–{lines}
          </span>
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={go} disabled={!valid}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Find / Replace bar ────────────────────────────────────────

export interface FindRequest {
  replace: boolean;
  seed: string;
  nonce: number;
}

const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

export function FindBar({
  editor,
  request,
  step,
  onClose,
}: {
  editor: Editor;
  request: FindRequest;
  /** F3 / Shift+F3 pressed in the editor. */
  step: { dir: 1 | -1; nonce: number } | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(request.seed);
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(request.replace);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [version, setVersion] = useState(0);
  const [current, setCurrent] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  // Ctrl+F again with a new selection: take it over.
  useEffect(() => {
    if (request.seed) setQuery(request.seed);
    if (request.replace) setShowReplace(true);
    window.setTimeout(() => input.current?.select(), 0);
  }, [request]);

  useEffect(() => {
    const model = editor.getModel();
    const sub = model?.onDidChangeContent(() => setVersion((v) => v + 1));
    decorations.current = editor.createDecorationsCollection();
    return () => {
      sub?.dispose();
      decorations.current?.clear();
    };
  }, [editor]);

  const { matches, error } = useMemo(() => {
    const model = editor.getModel();
    if (!model || !query) return { matches: [] as monaco.editor.FindMatch[], error: '' };
    try {
      if (regex) new RegExp(query);
      return { matches: model.findMatches(query, false, regex, matchCase, wholeWord ? WORD_SEPARATORS : null, true, 5000), error: '' };
    } catch (e) {
      return { matches: [], error: 'Bad pattern' };
    }
    // version: re-search after edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, query, matchCase, wholeWord, regex, version]);

  // The match at or after the caret becomes current.
  useEffect(() => {
    if (!matches.length) return setCurrent(-1);
    const pos = editor.getPosition();
    const i = pos ? matches.findIndex((m) => m.range.getEndPosition().isBeforeOrEqual(pos) === false) : 0;
    setCurrent(i >= 0 ? i : 0);
  }, [matches, editor]);

  useEffect(() => {
    decorations.current?.set(
      matches.map((m, i) => ({
        range: m.range,
        options: { className: i === current ? 'find-match-current' : 'find-match', overviewRuler: { color: '#e5a33d99', position: monaco.editor.OverviewRulerLane.Center } },
      })),
    );
  }, [matches, current]);

  const select = (i: number) => {
    if (!matches.length) return;
    const index = (i + matches.length) % matches.length;
    setCurrent(index);
    editor.setSelection(matches[index].range);
    editor.revealRangeInCenterIfOutsideViewport(matches[index].range);
  };

  const lastStep = useRef(step?.nonce);
  useEffect(() => {
    if (!step || step.nonce === lastStep.current) return;
    lastStep.current = step.nonce;
    select(current + step.dir);
    // Only react to new key presses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const replaceText = (m: monaco.editor.FindMatch) => (regex && m.matches ? m.matches[0].replace(new RegExp(query, matchCase ? '' : 'i'), replacement) : replacement);

  const replaceOne = () => {
    const m = matches[current];
    if (!m) return;
    editor.executeEdits('find', [{ range: m.range, text: replaceText(m) }]);
    editor.pushUndoStop();
  };

  const replaceAll = () => {
    if (!matches.length) return;
    editor.executeEdits('find', matches.map((m) => ({ range: m.range, text: replaceText(m) })));
    editor.pushUndoStop();
  };

  const close = () => {
    decorations.current?.clear();
    onClose();
    editor.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'F3' || (e.key === 'Enter' && (e.target as HTMLElement).id === 'find-input')) {
      e.preventDefault();
      select(current + (e.shiftKey ? -1 : 1));
    }
  };

  const count = !query ? '' : error ? error : matches.length === 0 ? '0 results' : `${current + 1}/${matches.length}`;
  const toggle = (on: boolean, set: (v: boolean) => void, label: string, text: string, title: string) => (
    <button type="button" className={'find-toggle' + (on ? ' on' : '')} aria-pressed={on} aria-label={label} title={title} onClick={() => set(!on)}>
      {text}
    </button>
  );

  return (
    <div className="find-bar" onKeyDown={onKeyDown} role="search">
      <div className="find-row">
        <button type="button" className="icon-btn small" aria-label={showReplace ? 'Hide replace' : 'Show replace'} title="Replace (Ctrl+R)" onClick={() => setShowReplace((s) => !s)}>
          <span className={'chev' + (showReplace ? ' open' : '')}>
            <Icon name="chevronRight" size={12} />
          </span>
        </button>
        <div className={'field find-field' + (query && !matches.length ? ' invalid' : '')}>
          <Icon name="search" size={13} />
          <label htmlFor="find-input" className="sr-only">
            Find
          </label>
          <input id="find-input" ref={input} value={query} spellCheck={false} placeholder="Find" onChange={(e) => setQuery(e.target.value)} />
          {toggle(matchCase, setMatchCase, 'Match case', 'Cc', 'Match Case (Alt+C)')}
          {toggle(wholeWord, setWholeWord, 'Words', 'W', 'Words (Alt+O)')}
          {toggle(regex, setRegex, 'Regex', '.*', 'Regex (Alt+X)')}
        </div>
        <span className="find-count" style={{ color: query && !matches.length ? '#f0787f' : undefined }}>
          {count}
        </span>
        <button type="button" className="icon-btn small" aria-label="Previous occurrence" title="Previous Occurrence (Shift+Enter)" onClick={() => select(current - 1)} disabled={!matches.length}>
          <Icon name="chevronUp" size={13} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Next occurrence" title="Next Occurrence (Enter)" onClick={() => select(current + 1)} disabled={!matches.length}>
          <Icon name="chevronDown" size={13} />
        </button>
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Close search" title="Close (Escape)" onClick={close}>
          <Icon name="close" size={11} />
        </button>
      </div>
      {showReplace && (
        <div className="find-row">
          <span style={{ width: 22, flex: 'none' }} />
          <div className="field find-field">
            <Icon name="refresh" size={13} />
            <label htmlFor="replace-input" className="sr-only">
              Replace
            </label>
            <input id="replace-input" value={replacement} spellCheck={false} placeholder="Replace" onChange={(e) => setReplacement(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && replaceOne()} />
          </div>
          <button type="button" className="btn small" onClick={replaceOne} disabled={!matches.length}>
            Replace
          </button>
          <button type="button" className="btn small" onClick={replaceAll} disabled={!matches.length}>
            Replace All
          </button>
        </div>
      )}
    </div>
  );
}

// ── File Structure (Ctrl+F12) ─────────────────────────────────

export function FileStructurePopup({ editor, fileName, symbols, onClose }: { editor: Editor; fileName: string; symbols: PhpSymbol[]; onClose: () => void }) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const caretLine = editor.getPosition()?.lineNumber ?? 1;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? symbols.filter((s) => s.name.toLowerCase().includes(q)) : symbols;
  }, [symbols, filter]);

  // Start on the member the caret is in.
  useLayoutEffect(() => {
    const i = [...shown].reverse().findIndex((s) => s.line <= caretLine);
    setSelected(filter || i < 0 ? 0 : shown.length - 1 - i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  const go = (s: PhpSymbol | undefined) => {
    if (!s) return;
    onClose();
    const model = editor.getModel()!;
    const col = Math.max(1, model.getLineContent(s.line).indexOf(s.name) + 1);
    editor.setPosition({ lineNumber: s.line, column: col });
    editor.revealLineInCenter(s.line);
    editor.focus();
  };

  return (
    <div className="modal-backdrop clear" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-popup"
        role="dialog"
        aria-label="File structure"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected((i) => Math.min(i + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') go(shown[selected]);
        }}
      >
        <div className="pb-popup-title">{fileName}</div>
        <div className="field" style={{ margin: '0 8px 6px' }}>
          <Icon name="search" size={13} />
          <label htmlFor="structure-filter" className="sr-only">
            Filter members
          </label>
          <input id="structure-filter" ref={input} value={filter} spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="pb-popup-list" ref={list}>
          {shown.map((s, i) => {
            const [letter, color] = SYMBOL_KIND[s.kind];
            return (
              <button
                key={`${s.kind}:${s.line}`}
                type="button"
                className={'result' + (i === selected ? ' selected' : '')}
                data-selected={i === selected}
                style={{ paddingLeft: 8 + (filter ? 0 : s.depth * 18) }}
                onMouseMove={() => setSelected(i)}
                onClick={() => go(s)}
              >
                <Sym letter={letter} color={color} />
                <Visibility value={s.visibility} />
                <span className="name">{symbolLabel(s)}</span>
              </button>
            );
          })}
          {!shown.length && <div className="empty">No matches.</div>}
        </div>
      </div>
    </div>
  );
}

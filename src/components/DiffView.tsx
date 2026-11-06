// Diff in an editor tab: HEAD vs your version (editable, same document as the editor), or a
// commit vs its parent. Side by side: what counts as a change (whitespace, empty lines, imports)
// and what's highlighted (lines, words, characters) are options; unchanged code can be collapsed,
// and a change in your version can be reverted from the band between the panes. The unified
// viewer is Monaco's own. F7 / Shift+F7 jump between changes.

import { useEffect, useReducer, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { languageOf } from '../php';
import { baseName, relativePath } from '../backend/types';
import { useSettings } from '../settings';
import { themeId } from '../editor/themes';
import { HIGHLIGHT_MODES, innerRanges, lineChanges, movedBlocks, partsOf, splitChanges, WHITESPACE_MODES, type HighlightMode, type LineChange, type Part, type WhitespaceMode } from '../git/textDiff';
import { matchingLine } from '../git/merge';
import { changeKeys, includeChanges, usePartialCommits } from '../git/partial';
import { Icon } from './Icon';
import { FoldZones, wavyPath, type Fold } from './foldZones';

type Viewer = 'side' | 'unified';
interface DiffOptions {
  viewer: Viewer;
  whitespace: WhitespaceMode;
  highlight: HighlightMode;
  collapse: boolean;
  sync: boolean;
}
const OPTIONS_KEY = 'phpblitz.diffOptions';
const DEFAULTS: DiffOptions = { viewer: 'side', whitespace: 'none', highlight: 'words', collapse: false, sync: true };

function loadOptions(): DiffOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

/** Unchanged lines kept around each change when the rest is collapsed. */
const CONTEXT = 4;
/** Bigger changed blocks are highlighted as lines only: comparing their words would take too long. */
const INNER_LIMIT = 400;

/**
 * A name for a document of this view only (a copy of a version): unique, since another view of the
 * same file (switching viewers, a second tab, one still closing) has its own.
 */
let scratchCount = 0;
export function scratchUri(kind: string, path: string): monaco.Uri {
  return monaco.Uri.parse(`inmemory://${kind}/${++scratchCount}-${Date.now().toString(36)}/${encodeURIComponent(path)}`);
}

/** The side-by-side view's editors, what the comparison found, and the folds of each side. */
interface Live {
  left: monaco.editor.IStandaloneCodeEditor;
  right: monaco.editor.IStandaloneCodeEditor;
  changes: LineChange[];
  parts: Part[];
  /** Per change shown: the names of the exact changes it covers (git/partial.ts). */
  commitKeys: string[][];
  folds: { a: FoldZones; b: FoldZones };
}

/** Line ranges [x0, x1) and [y0, y1) share a line, or an empty one sits at or inside the other. */
function overlaps(x0: number, x1: number, y0: number, y1: number): boolean {
  if (x0 < y1 && y0 < x1) return true;
  if (x0 === x1) return y0 <= x0 && x0 <= y1;
  if (y0 === y1) return x0 <= y0 && y0 <= x1;
  return false;
}

const kindOf = (c: LineChange): 'added' | 'deleted' | 'modified' => (c.a1 === c.a0 ? 'added' : c.b1 === c.b0 ? 'deleted' : 'modified');

/** The line (1-based, your version) a change's commit checkbox is on: its first, or for a deletion the one above. */
const checkLine = (c: LineChange) => (c.b1 > c.b0 ? c.b0 + 1 : Math.max(1, c.b0));

/** Lines [start0, end0) (0-based) marked as moved code, with a hover saying where to or from. */
function movedDecoration(start0: number, end0: number, message: string): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(start0 + 1, 1, end0, Number.MAX_SAFE_INTEGER),
    options: { isWholeLine: true, className: 'diff-line-moved', linesDecorationsClassName: 'diff-mark-moved', hoverMessage: { value: message }, zIndex: 1 },
  };
}

export function DiffView({ ws, path, commit, left: base, shelf }: { ws: Workspace; path: string; commit?: string; left?: string; shelf?: string }) {
  const [options, setOptionsState] = useState<DiffOptions>(loadOptions);
  const setOption = <K extends keyof DiffOptions>(key: K, value: DiffOptions[K]) =>
    setOptionsState((o) => {
      const next = { ...o, [key]: value };
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        // Only a preference.
      }
      return next;
    });
  const [texts, setTexts] = useState<{ left: string; right: monaco.editor.ITextModel; editable: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A shelved file: the shelf's name and the commit it was shelved on. */
  const [shelved, setShelved] = useState<{ name: string; base: string } | null>(null);
  const settings = useSettings().editor;
  // Monaco has one theme for the page, set by whichever editor opens: the diff sets it too (a
  // diff opened before any file would show Monaco's own white theme). 'theme' follows the UI theme.
  const theme = themeId(settings.scheme);
  useEffect(() => monaco.editor.setTheme(theme), [theme]);
  // An open file's editor already knows its language (it may have been guessed from the text).
  const language = monaco.editor.getModel(monaco.Uri.file(path))?.getLanguageId() ?? languageOf(path, ws.liveTextOf(path) ?? ws.loaded[path]);

  // Both versions: the left as text, the right as a document (your version: the editor's own).
  useEffect(() => {
    let disposed = false;
    const owned: monaco.IDisposable[] = [];
    (async () => {
      try {
        let left: string | null;
        let right: monaco.editor.ITextModel;
        let editable = false;
        if (shelf) {
          const s = (await ws.gitRepo.shelves()).find((x) => x.id === shelf);
          const file = s?.files.find((x) => x.path === ws.gitRepo.rel(path));
          if (!s || !file) throw new Error('This shelf (or this file in it) is gone: unshelved or deleted.');
          if (file.after === undefined) throw new Error('Not a text file: there is nothing to compare.');
          left = file.status === 'A' ? '' : await ws.gitRepo.show(s.base, path);
          right = monaco.editor.createModel((file.after ?? '').replace(/\r\n/g, '\n'), language, scratchUri(`diff/shelf-${shelf}`, path));
          owned.push(right);
          if (!disposed) setShelved({ name: s.name, base: s.base });
        } else if (commit) {
          left = await ws.gitRepo.show(base ?? `${commit}^`, path);
          const after = await ws.gitRepo.show(commit, path);
          right = monaco.editor.createModel(after ?? '', language, scratchUri(`diff/${commit}`, path));
          owned.push(right);
        } else {
          left = base ? await ws.gitRepo.show(base, path) : await ws.gitRepo.head(path);
          // Your version: the editor's own document when the file is open, so edits here are real edits.
          const existing = monaco.editor.getModel(monaco.Uri.file(path));
          if (existing) {
            right = existing;
            editable = true;
          } else {
            const text = ws.liveTextOf(path) ?? (await ws.backend.readFile(path).catch(() => ''));
            right = monaco.editor.createModel(text, language, scratchUri('diff/working', path));
            owned.push(right);
          }
        }
        if (disposed) return;
        setTexts({ left: (left ?? '').replace(/\r\n/g, '\n'), right, editable });
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      disposed = true;
      owned.forEach((d) => d.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, commit, base, shelf]);

  // A hash shortened, a branch name as it is.
  const rev = (r: string) => (/^[0-9a-f]{12,}$/i.test(r) ? r.slice(0, 8) : r);
  const leftName = shelved ? rev(shelved.base) : base ? rev(base) : commit ? `${rev(commit)}^` : 'HEAD';
  const rightName = shelved ? `Shelf: ${shelved.name}` : commit ? rev(commit) : 'Your version';
  const title = `${leftName} vs ${rightName}`;
  const heads = [`${baseName(path)} (${leftName})`, commit && !shelf ? `${baseName(path)} (${rightName})` : rightName];
  const [count, setCount] = useState<number | null>(null);
  const [included, setIncluded] = useState<number | null>(null);
  const goRef = useRef<(dir: 1 | -1) => void>(() => {});

  const select = <T extends string>(label: string, value: T, items: [T, string][], onPick: (v: T) => void, disabled?: (v: T) => boolean) => (
    <select className="field select diff-select" aria-label={label} title={label} value={value} onChange={(e) => onPick(e.target.value as T)}>
      {items.map(([v, text]) => (
        <option key={v} value={v} disabled={disabled?.(v)}>
          {text}
        </option>
      ))}
    </select>
  );
  const unified = options.viewer === 'unified';

  return (
    <div
      className="diff-view"
      onKeyDown={(e) => {
        if (e.key === 'F7') {
          e.preventDefault();
          goRef.current(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="tw-toolbar diff-toolbar">
        <button type="button" className="icon-btn small" title="Previous Difference (Shift+F7)" aria-label="Previous difference" onClick={() => goRef.current(-1)}>
          <Icon name="chevronUp" size={13} />
        </button>
        <button type="button" className="icon-btn small" title="Next Difference (F7)" aria-label="Next difference" onClick={() => goRef.current(1)}>
          <Icon name="chevronDown" size={13} />
        </button>
        <span className="te-sep" />
        {select<Viewer>('Viewer', options.viewer, [['side', 'Side-by-side viewer'], ['unified', 'Unified viewer']], (v) => setOption('viewer', v))}
        {/* The unified viewer is Monaco's: it can trim whitespace, not ignore the rest. */}
        {select('Whitespace', options.whitespace, WHITESPACE_MODES, (v) => setOption('whitespace', v), (v) => unified && v !== 'none' && v !== 'trim')}
        {select('Highlighting', options.highlight, HIGHLIGHT_MODES, (v) => setOption('highlight', v), (v) => unified && (v === 'split' || v === 'chars'))}
        <button type="button" className={'icon-btn small' + (options.collapse ? ' on' : '')} aria-pressed={options.collapse} title="Collapse Unchanged Fragments" aria-label="Collapse unchanged fragments" onClick={() => setOption('collapse', !options.collapse)}>
          <Icon name="collapseAll" size={14} />
        </button>
        {!unified && (
          <button type="button" className={'icon-btn small' + (options.sync ? ' on' : '')} aria-pressed={options.sync} title="Synchronize Scrolling" aria-label="Synchronize scrolling" onClick={() => setOption('sync', !options.sync)}>
            <Icon name="columns" size={14} />
          </button>
        )}
        {!commit && (
          <button type="button" className="btn small ghost" onClick={() => ws.openFile(path)}>
            <Icon name="goTo" size={13} />
            Jump to Source
          </button>
        )}
        <span className="grow" />
        <span className="muted diff-title">
          {count !== null ? `${count} ${count === 1 ? 'difference' : 'differences'}${included !== null ? `, ${included} included` : ''} · ` : ''}
          {title} · {relativePath(ws.backend, path)}
        </span>
      </div>
      <div className="diff-heads">
        <span>{heads[0]}</span>
        {!unified && <span className="diff-head-gap" />}
        {!unified && <span>{heads[1]}</span>}
      </div>
      {error && (
        <div className="te-error">
          <pre>{error}</pre>
        </div>
      )}
      {texts &&
        (unified ? (
          <UnifiedDiff texts={texts} path={path} commit={commit} language={language} options={options} theme={theme} onCount={setCount} goRef={goRef} partial={!commit && !base && !shelf} onIncluded={setIncluded} />
        ) : (
          <SideBySideDiff texts={texts} path={path} language={language} options={options} theme={theme} onCount={setCount} goRef={goRef} partial={!commit && !base && !shelf} onIncluded={setIncluded} />
        ))}
    </div>
  );
}

interface ViewProps {
  texts: { left: string; right: monaco.editor.ITextModel; editable: boolean };
  path: string;
  language: string;
  options: DiffOptions;
  theme: string;
  onCount: (n: number) => void;
  goRef: React.MutableRefObject<(dir: 1 | -1) => void>;
  /** Your version against HEAD: each change has a checkbox for the next commit. */
  partial?: boolean;
  /** How many changes are checked (for the title). */
  onIncluded?: (n: number | null) => void;
}

function editorOptions(theme: string, settings: ReturnType<typeof useSettings>['editor']): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    theme,
    automaticLayout: true,
    fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
    fontSize: settings.fontSize,
    lineHeight: Math.round(settings.fontSize * settings.lineHeight),
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    contextmenu: false,
    codeLens: false,
  };
}

/** Monaco's own diff editor, one column (it can trim whitespace and collapse; the rest is ours only). */
function UnifiedDiff({ texts, path, commit, language, options, theme, onCount, goRef, partial, onIncluded }: ViewProps & { commit?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const settings = useSettings().editor;
  const ref = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const diff = monaco.editor.createDiffEditor(host.current, {
      ...editorOptions(theme, settings),
      renderSideBySide: false,
      originalEditable: false,
      readOnly: !texts.editable,
      renderOverviewRuler: true,
      contextmenu: false,
      // The commit checkboxes.
      glyphMargin: !!partial,
    });
    ref.current = diff;
    // A name of its own: another view of this file (switching viewers, a second tab) has a base too.
    const original = monaco.editor.createModel(texts.left, language, scratchUri(`diff/base/${commit ?? 'HEAD'}`, path));
    diff.setModel({ original, modified: texts.right });
    const expand = (key: string) => {
      expanded.current = new Set(expanded.current).add(key);
      fold();
    };
    folds.current = new FoldZones(diff.getModifiedEditor(), path, expand);
    checks.current = diff.getModifiedEditor().createDecorationsCollection();
    originalFolds.current = new FoldZones(diff.getOriginalEditor(), path, expand);
    // Moved code: in one column only your version's lines can be marked (the deleted ones are Monaco's).
    const moved = diff.getModifiedEditor().createDecorationsCollection();
    const sub = diff.onDidUpdateDiff(() => {
      onCount(diff.getLineChanges()?.length ?? 0);
      fold();
      const a = original.getLinesContent();
      const b = diff.getModifiedEditor().getModel()?.getLinesContent() ?? [];
      const blocks = movedBlocks(a, b, lineChanges(a, b, whitespace.current));
      moved.set(blocks.map((m) => movedDecoration(m.b0, m.b1, `Moved from line ${m.a0 + 1}`)));
      if (partial) setCommitChanges(changeKeys(a, b));
    });
    // A click on a change's checkbox: in or out of the next commit (all the changes on that line).
    const click = diff.getModifiedEditor().onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
      const keys = commitChangesRef.current.filter((c) => checkLine(c.change) === e.target.position!.lineNumber).map((c) => c.key);
      if (!keys.length) return;
      e.event.preventDefault();
      includeChanges(path, keys, keys.some((k) => excludedRef.current?.has(k)));
    });
    goRef.current = (dir) => {
      const changes = diff.getLineChanges() ?? [];
      const ed = diff.getModifiedEditor();
      const line = ed.getPosition()?.lineNumber ?? 1;
      const starts = changes.map((c) => Math.max(1, c.modifiedStartLineNumber));
      const target = dir === 1 ? starts.find((s) => s > line) ?? starts[0] : [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1];
      if (target === undefined) return;
      ed.setPosition({ lineNumber: target, column: 1 });
      ed.revealLineInCenter(target);
      ed.focus();
    };
    return () => {
      sub.dispose();
      click.dispose();
      // Our marks off your version's document (a scratch one may be gone already).
      if (!texts.right.isDisposed()) {
        checks.current?.clear();
        moved.clear();
      }
      checks.current = null;
      folds.current?.dispose();
      originalFolds.current?.dispose();
      originalFolds.current = null;
      folds.current = null;
      diff.setModel(null);
      diff.dispose();
      original.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texts]);

  // Collapse Unchanged Fragments: our wavy strips, not Monaco's (the same as side by side). The
  // unchanged stretches are in your version's lines, between the diff's changes.
  const folds = useRef<FoldZones | null>(null);
  const originalFolds = useRef<FoldZones | null>(null);
  const expanded = useRef(new Set<string>());
  // Commit checkboxes (your version against HEAD): one in the gutter per change the commit takes.
  const [commitChanges, setCommitChanges] = useState<{ change: LineChange; key: string }[]>([]);
  const commitChangesRef = useRef(commitChanges);
  commitChangesRef.current = commitChanges;
  const excluded = usePartialCommits().get(path);
  const excludedRef = useRef(excluded);
  excludedRef.current = excluded;
  const checks = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    if (!partial) return;
    checks.current?.set(
      commitChanges.map(({ change, key }) => {
        const line = checkLine(change);
        const on = !excluded?.has(key);
        return {
          range: new monaco.Range(line, 1, line, 1),
          options: { glyphMarginClassName: 'diff-check' + (on ? ' on' : ''), glyphMarginHoverMessage: { value: on ? 'In the next commit: click to leave this change out' : 'Left out of the next commit: click to include it' } },
        };
      }),
    );
    onIncluded?.(commitChanges.filter((c) => !excluded?.has(c.key)).length);
  }, [commitChanges, excluded, partial, onIncluded]);
  const whitespace = useRef(options.whitespace);
  whitespace.current = options.whitespace;
  const collapse = useRef(options.collapse);
  collapse.current = options.collapse;
  function fold() {
    const diff = ref.current;
    if (!diff || !folds.current || !originalFolds.current) return;
    const changes = diff.getLineChanges() ?? [];
    // The unchanged stretches of one side: between its changes (an end of 0 means the change has no
    // lines on that side, it sits after the start line). The k-th stretch is the same on both sides.
    const stretches = (ed: monaco.editor.ICodeEditor, start: (c: monaco.editor.ILineChange) => number, end: (c: monaco.editor.ILineChange) => number): Fold[] => {
      if (!collapse.current) return [];
      const total = ed.getModel()?.getLineCount() ?? 0;
      const out: Fold[] = [];
      let next = 1;
      const add = (k: number, from: number, to: number) => {
        const a = from + (k > 0 ? CONTEXT : 0);
        const b = to - (k < changes.length ? CONTEXT : 0);
        if (b - a >= 1 && !expanded.current.has(`u${k}`)) out.push({ key: `u${k}`, from: a, to: b });
      };
      changes.forEach((c, k) => {
        const empty = end(c) === 0;
        add(k, next, empty ? start(c) : start(c) - 1);
        next = empty ? start(c) + 1 : end(c) + 1;
      });
      add(changes.length, next, total);
      return out;
    };
    folds.current.set(stretches(diff.getModifiedEditor(), (c) => c.modifiedStartLineNumber, (c) => c.modifiedEndLineNumber));
    // In one column Monaco still shows the original's line numbers from its own (hidden) editor:
    // folded the same way, they stay next to the right lines.
    originalFolds.current.set(stretches(diff.getOriginalEditor(), (c) => c.originalStartLineNumber, (c) => c.originalEndLineNumber));
  }
  useEffect(() => {
    ref.current?.updateOptions({ ignoreTrimWhitespace: options.whitespace !== 'none', hideUnchangedRegions: { enabled: false } });
  }, [options.whitespace]);
  useEffect(() => {
    if (options.collapse) expanded.current = new Set();
    fold();
  }, [options.collapse]);
  const cls = options.highlight === 'none' ? ' diff-no-highlight' : options.highlight === 'lines' ? ' diff-lines-only' : '';
  return <div ref={host} className={'diff-host' + cls} data-theme={theme} />;
}

/** Ours: two editors and the bands between them, with every option. */
function SideBySideDiff({ texts, path, language, options, theme, onCount, goRef, partial, onIncluded }: ViewProps) {
  const excluded = usePartialCommits().get(path);
  const leftHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const settings = useSettings().editor;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const live = useRef<Live | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Folds opened with a click; collapsing again (or other options) folds them back.
  const expandedRef = useRef(new Set<string>());
  useEffect(() => {
    if (options.collapse) expandedRef.current = new Set();
  }, [options.collapse]);

  useEffect(() => {
    if (!leftHost.current || !rightHost.current) return;
    const leftModel = monaco.editor.createModel(texts.left, language, scratchUri('diff/left', path));
    const base = editorOptions(theme, settings);
    const left = monaco.editor.create(leftHost.current, { ...base, model: leftModel, readOnly: true });
    const right = monaco.editor.create(rightHost.current, { ...base, model: texts.right, readOnly: !texts.editable });
    const expand = (key: string) => {
      expandedRef.current = new Set(expandedRef.current).add(key);
      compare();
    };
    live.current = { left, right, changes: [], parts: [], commitKeys: [], folds: { a: new FoldZones(left, path, expand), b: new FoldZones(right, path, expand) } };
    const subs: monaco.IDisposable[] = [];
    let syncing = false;
    for (const [ed, other, from, to] of [
      [left, right, 'a', 'b'],
      [right, left, 'b', 'a'],
    ] as const) {
      subs.push(
        ed.onDidScrollChange((e) => {
          if (e.scrollTopChanged && optionsRef.current.sync && !syncing && live.current) {
            syncing = true;
            const top = ed.getVisibleRanges()[0]?.startLineNumber ?? 1;
            const within = ed.getScrollTop() - ed.getTopForLineNumber(top);
            const parts = live.current.parts;
            if (parts.length) other.setScrollTop(other.getTopForLineNumber(matchingLine(parts.map((p) => p[from]), parts.map((p) => p[to]), top)) + within);
            syncing = false;
          }
          redraw();
        }),
        ed.onDidLayoutChange(() => redraw()),
      );
    }
    // Your edits: compared again after a pause.
    let timer = 0;
    subs.push(
      texts.right.onDidChangeContent(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => compare(), 250);
      }),
    );
    goRef.current = (dir) => {
      const l = live.current;
      if (!l || !l.changes.length) return;
      const line = right.getPosition()?.lineNumber ?? 0;
      const starts = l.changes.map((c) => c.b0 + 1);
      const target = dir === 1 ? starts.find((s) => s > line) ?? starts[0] : [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1];
      right.setPosition({ lineNumber: target, column: 1 });
      right.revealLineInCenter(target);
      right.focus();
    };
    compare();
    return () => {
      window.clearTimeout(timer);
      subs.forEach((s) => s.dispose());
      // The right model may be the editor's own document: only our left one is disposed, and our
      // marks come off the right one (else they'd show in the editor, or in the other viewer).
      if (live.current) Object.values(live.current.folds).forEach((f) => f.dispose());
      // (A scratch right model is the diff view's, and may be gone already.)
      if (!texts.right.isDisposed()) texts.right.deltaDecorations(decorations.current.b, []);
      decorations.current = { a: [], b: [] };
      left.dispose();
      right.dispose();
      leftModel.dispose();
      live.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texts]);

  useEffect(() => compare(), [options.whitespace, options.highlight, options.collapse]); // eslint-disable-line react-hooks/exhaustive-deps

  const decorations = useRef<{ a: string[]; b: string[] }>({ a: [], b: [] });
  /** Compares the two sides with the current options, then marks and folds both editors. */
  function compare() {
    const l = live.current;
    if (!l) return;
    const o = optionsRef.current;
    const a = l.left.getModel()!.getLinesContent();
    const b = l.right.getModel()!.getLinesContent();
    let changes = lineChanges(a, b, o.whitespace);
    if (o.highlight === 'split') changes = splitChanges(changes, a, b, o.whitespace);
    const parts = partsOf(changes, a.length, b.length);
    l.changes = changes;
    l.parts = parts;
    // What each change shown is for a commit: the exact changes (whitespace and all) it covers.
    const exact = changeKeys(a, b);
    l.commitKeys = changes.map((c) => exact.filter(({ change: k }) => overlaps(c.a0, c.a1, k.a0, k.a1) || overlaps(c.b0, c.b1, k.b0, k.b1)).map((k) => k.key));
    onCount(changes.length);

    const out: { a: monaco.editor.IModelDeltaDecoration[]; b: monaco.editor.IModelDeltaDecoration[] } = { a: [], b: [] };
    const block = (side: 'a' | 'b', start0: number, end0: number, kind: string) => {
      const bg = o.highlight === 'none' ? undefined : `diff-line-${kind}`;
      if (end0 > start0) out[side].push({ range: new monaco.Range(start0 + 1, 1, end0, 1), options: { isWholeLine: true, className: bg, linesDecorationsClassName: `diff-mark-${kind}` } });
      else out[side].push({ range: new monaco.Range(Math.max(1, start0), 1, Math.max(1, start0), 1), options: { isWholeLine: true, className: `diff-gap-${kind}${start0 === 0 ? ' top' : ''}` } });
    };
    for (const c of changes) {
      const kind = kindOf(c);
      block('a', c.a0, c.a1, kind === 'added' ? 'added' : kind === 'deleted' ? 'deleted' : 'modified');
      block('b', c.b0, c.b1, kind);
      if ((o.highlight === 'words' || o.highlight === 'split' || o.highlight === 'chars') && kind === 'modified' && c.a1 - c.a0 + c.b1 - c.b0 <= INNER_LIMIT) {
        for (const r of innerRanges(a.slice(c.a0, c.a1), b.slice(c.b0, c.b1), o.highlight === 'chars' ? 'chars' : 'words', o.whitespace)) {
          const line = (r.side === 'a' ? c.a0 : c.b0) + r.line + 1;
          out[r.side].push({ range: new monaco.Range(line, r.start + 1, line, r.end + 1), options: { inlineClassName: r.side === 'a' ? 'diff-inner-del' : 'diff-inner-add' } });
        }
      }
    }
    // Moved code: marked as moved on both sides, with where it went or came from.
    if (o.highlight !== 'none') {
      for (const m of movedBlocks(a, b, changes)) {
        out.a.push(movedDecoration(m.a0, m.a1, `Moved to line ${m.b0 + 1}`));
        out.b.push(movedDecoration(m.b0, m.b1, `Moved from line ${m.a0 + 1}`));
      }
    }
    // Collapse Unchanged Fragments: unchanged stretches keep CONTEXT lines next to each change; the
    // rest is a wavy strip a click opens. A stretch has the same key on both sides.
    for (const side of ['a', 'b'] as const) {
      const folds: Fold[] = [];
      if (o.collapse) {
        parts.forEach((p, i) => {
          const key = `u${p.a.start}`;
          if (p.changed || expandedRef.current.has(key)) return;
          const at = p[side];
          const from = at.start + (i > 0 ? CONTEXT : 0);
          const to = at.start + at.count - 1 - (i < parts.length - 1 ? CONTEXT : 0);
          if (to - from >= 1) folds.push({ key, from, to });
        });
      }
      l.folds[side].set(folds);
    }
    decorations.current.a = l.left.getModel()!.deltaDecorations(decorations.current.a, out.a);
    decorations.current.b = l.right.getModel()!.deltaDecorations(decorations.current.b, out.b);
    redraw();
  }

  /** Revert: this change's lines in your version go back to what the left side has. */
  function revert(c: LineChange) {
    const l = live.current;
    if (!l) return;
    const model = l.right.getModel()!;
    const lines = l.left.getModel()!.getLinesContent().slice(c.a0, c.a1);
    const total = model.getLineCount();
    let range: monaco.Range;
    let text: string;
    if (c.b1 < total) {
      range = new monaco.Range(c.b0 + 1, 1, c.b1 + 1, 1);
      text = lines.map((x) => x + model.getEOL()).join('');
    } else if (c.b1 > c.b0) {
      const from = !lines.length && c.b0 > 0 ? new monaco.Position(c.b0, model.getLineMaxColumn(c.b0)) : new monaco.Position(c.b0 + 1, 1);
      range = monaco.Range.fromPositions(from, new monaco.Position(total, model.getLineMaxColumn(total)));
      text = lines.join(model.getEOL());
    } else {
      range = new monaco.Range(total, model.getLineMaxColumn(total), total, model.getLineMaxColumn(total));
      text = lines.map((x) => model.getEOL() + x).join('');
    }
    model.pushStackElement();
    model.pushEditOperations([], [{ range, text }], () => null);
    model.pushStackElement();
  }

  // Changes checked for the next commit (after each comparison and each checkbox).
  const included = partial && live.current ? live.current.commitKeys.filter((keys) => keys.length && keys.every((k) => !excluded?.has(k))).length : null;
  useEffect(() => onIncluded?.(included), [included, onIncluded]);

  return (
    <div className={'merge-panes diff-panes' + (options.highlight === 'none' ? ' diff-no-highlight' : '')} data-theme={theme}>
      <div ref={leftHost} className="merge-pane" />
      <DiffDivider live={live.current} editable={texts.editable} onRevert={revert} excluded={partial ? excluded ?? new Set() : null} onInclude={(keys, on) => includeChanges(path, keys, on)} />
      <div ref={rightHost} className="merge-pane" />
    </div>
  );
}

const DIVIDER = 40;

/** The gutter between the two sides: a band per change, and Revert (») on your version's changes. */
function DiffDivider({
  live,
  editable,
  onRevert,
  excluded,
  onInclude,
}: {
  live: Live | null;
  editable: boolean;
  onRevert: (c: LineChange) => void;
  /** Partial commits: the changes left out (null: no checkboxes). */
  excluded: ReadonlySet<string> | null;
  onInclude: (keys: string[], included: boolean) => void;
}) {
  if (!live) return <div className="merge-divider" style={{ width: DIVIDER }} />;
  const { left, right } = live;
  const lh = left.getOption(monaco.editor.EditorOption.lineHeight);
  const y = (ed: monaco.editor.IStandaloneCodeEditor, line: number) => {
    const count = ed.getModel()?.getLineCount() ?? 1;
    return (line > count ? ed.getTopForLineNumber(count) + lh : ed.getTopForLineNumber(line)) - ed.getScrollTop();
  };
  const W = DIVIDER;
  const mid = W / 2;
  const height = left.getLayoutInfo().height;
  return (
    <div className="merge-divider" style={{ width: W }}>
      <svg width={W} height="100%" aria-hidden>
        {live.changes.map((c, i) => {
          const t1 = y(left, c.a0 + 1);
          const b1 = c.a1 > c.a0 ? y(left, c.a1 + 1) : t1;
          const t2 = y(right, c.b0 + 1);
          const b2 = c.b1 > c.b0 ? y(right, c.b1 + 1) : t2;
          if (Math.max(b1, b2) < 0 || Math.min(t1, t2) > height) return null;
          return <path key={i} className={`merge-band merge-band-${kindOf(c)}`} d={`M0,${t1} C${mid},${t1} ${mid},${t2} ${W},${t2} L${W},${b2} C${mid},${b2} ${mid},${b1} 0,${b1} Z`} />;
        })}
        {(() => {
          // A fold's wavy strip goes on across the gutter to the same fold on the other side.
          const right = new Map(live.folds.b.places().map((f) => [f.key, f]));
          return live.folds.a.places().flatMap((f) => {
            const other = right.get(f.key);
            return other ? [<path key={f.key} className="fold-link" d={wavyPath(0, f.top + f.height / 2, W, other.top + other.height / 2)} />] : [];
          });
        })()}
      </svg>
      {excluded &&
        live.changes.map((c, i) => {
          const keys = live.commitKeys[i] ?? [];
          const top = y(right, c.b0 + 1);
          if (!keys.length || top < -lh || top > height) return null;
          const included = keys.every((k) => !excluded.has(k));
          return (
            <input
              key={`check${i}`}
              type="checkbox"
              className="checkbox diff-include"
              style={{ top }}
              checked={included}
              title={included ? 'In the next commit: uncheck to leave this change out' : 'Left out of the next commit'}
              aria-label="Include this change in the commit"
              onChange={() => onInclude(keys, !included)}
            />
          );
        })}
      {editable &&
        live.changes.map((c, i) => {
          const top = y(left, c.a0 + 1);
          if (top < -lh || top > height) return null;
          return (
            <div key={i} className="merge-btns left" style={{ top }}>
              <button type="button" className="merge-btn take" title="Revert (take the left side)" aria-label="Revert this change" onClick={() => onRevert(c)}>
                »
              </button>
            </div>
          );
        })}
    </div>
  );
}

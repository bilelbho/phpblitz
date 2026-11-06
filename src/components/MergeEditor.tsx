// Merge Revisions: yours on the left, theirs on the right, the result in the middle (it starts as
// the common base). Each change is applied (» «) or ignored (×) from the bands between the panes;
// non-conflicting ones can be applied all at once. The result can also be edited by hand.

import { useEffect, useReducer, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import type { GitOperation } from '../backend/types';
import { relativePath } from '../backend/types';
import { languageOf } from '../php';
import { useSettings } from '../settings';
import { themeId } from '../editor/themes';
import { confirmDialog } from '../platform';
import { act, eolOf, initialStates, isResolved, matchingLine, merge3, mergedText, resultLines, segmentPlaces, toLines, type ChunkState, type MergeWhitespace, type Segment } from '../git/merge';
import { HIGHLIGHT_MODES, innerRanges, type HighlightMode } from '../git/textDiff';
import { Icon } from './Icon';
import { FoldZones, wavyPath, type Fold } from './foldZones';
import { scratchUri } from './DiffView';

/** Column titles for the two sides, per operation (in a rebase "ours" is the branch being rebased onto). */
export function sideLabels(op: GitOperation | undefined, branch: string): { ours: string; theirs: string } {
  switch (op?.kind) {
    case 'rebase':
      return { ours: 'Rebased so far (upstream)', theirs: `Your commit${op.branch ? ` on ${op.branch}` : ''}` };
    case 'cherry-pick':
      return { ours: `Yours (${branch})`, theirs: `Cherry-picked${op.incoming ? ` ${op.incoming}` : ''}` };
    case 'revert':
      return { ours: `Yours (${branch})`, theirs: `Revert${op.incoming ? ` of ${op.incoming}` : ''}` };
    default:
      return { ours: `Yours (${branch})`, theirs: `Theirs${op?.incoming ? ` (${op.incoming})` : ''}` };
  }
}

/** What each side is called in "Changes from …". */
function sideNames(op: GitOperation | undefined, branch: string): { ours: string; theirs: string } {
  switch (op?.kind) {
    case 'rebase':
      return { ours: 'upstream', theirs: `your commit${op.branch ? ` (${op.branch})` : ''}` };
    case 'cherry-pick':
      return { ours: branch, theirs: op.incoming ? `commit ${op.incoming}` : 'the picked commit' };
    case 'revert':
      return { ours: branch, theirs: op.incoming ? `the revert of ${op.incoming}` : 'the revert' };
    default:
      return { ours: branch, theirs: op?.incoming ?? 'theirs' };
  }
}

/** Replaces whole lines [start, start + count) of the model with `lines`. */
function replaceLines(model: monaco.editor.ITextModel, start: number, count: number, lines: string[]) {
  const total = model.getLineCount();
  let range: monaco.Range;
  let text: string;
  if (start + count <= total) {
    range = new monaco.Range(start, 1, start + count, 1);
    text = lines.map((l) => l + '\n').join('');
  } else if (count === 0) {
    range = new monaco.Range(total, model.getLineMaxColumn(total), total, model.getLineMaxColumn(total));
    text = lines.map((l) => '\n' + l).join('');
  } else {
    const from = !lines.length && start > 1 ? new monaco.Position(start - 1, model.getLineMaxColumn(start - 1)) : new monaco.Position(start, 1);
    range = monaco.Range.fromPositions(from, new monaco.Position(total, model.getLineMaxColumn(total)));
    text = lines.join('\n');
  }
  model.pushEditOperations([], [{ range, text }], () => null);
}

/** A tracked block's place: [start, start + count) whole lines (its range ends at the next line's start). */
function blockOf(model: monaco.editor.ITextModel, id: string): { start: number; count: number } {
  const r = model.getDecorationRange(id);
  if (!r) return { start: 1, count: 0 };
  if (r.isEmpty()) return { start: r.startLineNumber, count: 0 };
  return { start: r.startLineNumber, count: r.endLineNumber - r.startLineNumber + (r.endColumn === 1 ? 0 : 1) };
}

function blockRange(model: monaco.editor.ITextModel, start: number, count: number): monaco.Range {
  const total = model.getLineCount();
  if (count === 0) return new monaco.Range(Math.min(start, total), 1, Math.min(start, total), 1);
  if (start + count <= total) return new monaco.Range(start, 1, start + count, 1);
  return new monaco.Range(start, 1, total, model.getLineMaxColumn(total));
}

const TRACK = { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges };

/** Unchanged lines kept around each change when the rest is collapsed. */
const CONTEXT = 4;
const COLLAPSE_KEY = 'phpblitz.mergeCollapse';

const WHITESPACE_KEY = 'phpblitz.mergeWhitespace';
const HIGHLIGHT_KEY = 'phpblitz.mergeHighlight';
const MERGE_WHITESPACE: [MergeWhitespace, string][] = [
  ['none', 'Do not ignore'],
  ['trim', 'Trim whitespaces'],
  ['all', 'Ignore whitespaces'],
  ['all-empty', 'Ignore whitespaces and empty lines'],
  ['imports', 'Ignore imports and formatting'],
];
/** Split changes is a two-way diff's: the merge editor highlights lines, words or characters. */
const MERGE_HIGHLIGHT = HIGHLIGHT_MODES.filter(([m]) => m !== 'split');

function pref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a preference.
  }
}


/** A change's look: added (base had nothing there), deleted (the side has nothing), or modified. */
function changeKind(s: Segment, side: 'ours' | 'theirs'): 'added' | 'deleted' | 'modified' {
  if (s.kind === 'same') return 'modified';
  if (!s.base.length) return 'added';
  if (!s[side].length) return 'deleted';
  return 'modified';
}

interface Loaded {
  segments: Segment[];
  ours: string;
  theirs: string;
  base: string;
  eol: '\r\n' | '\n';
}

type Pane = 'ours' | 'result' | 'theirs';

export function MergeEditor({ ws, path, onClose }: { ws: Workspace; path: string; onClose: (resolved: boolean) => void }) {
  const hosts = { ours: useRef<HTMLDivElement>(null), result: useRef<HTMLDivElement>(null), theirs: useRef<HTMLDivElement>(null) };
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [states, setStatesState] = useState<(ChunkState | null)[]>([]);
  const statesRef = useRef(states);
  const setStates = (next: (ChunkState | null)[]) => {
    statesRef.current = next;
    setStatesState(next);
  };
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState(true);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  // Collapse Unchanged Fragments: only the changes and a few lines around them.
  const [collapse, setCollapse] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const collapseRef = useRef(collapse);
  collapseRef.current = collapse;
  // What whitespace counts (it decides what conflicts: changing it starts over) and what's highlighted.
  const [whitespace, setWhitespace] = useState<MergeWhitespace>(() => pref(WHITESPACE_KEY, 'none'));
  const [highlight, setHighlight] = useState<HighlightMode>(() => pref(HIGHLIGHT_KEY, 'words'));
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  // The bands between the panes follow scrolling and edits: redrawn on every change.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const settings = useSettings().editor;
  const theme = themeId(settings.scheme);
  const branch = ws.git?.branch ?? 'HEAD';
  const names = sideNames(ws.git?.operation, branch);

  const live = useRef<{ panes: Record<Pane, monaco.editor.IStandaloneCodeEditor>; trackers: (string | null)[]; folds: Record<Pane, FoldZones> } | null>(null);
  // Folds opened with a click (by segment); collapsing again folds them back.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await ws.gitRepo.conflictVersions(path);
        if (v.ours === null || v.theirs === null) throw new Error('One side deleted this file: use Accept Yours or Accept Theirs in the conflicts list.');
        const disk = ws.liveTextOf(path) ?? (await ws.backend.readFile(path).catch(() => ''));
        const segments = merge3(v.base ?? '', v.ours, v.theirs, whitespace);
        if (cancelled) return;
        setStates(initialStates(segments));
        setLoaded({ segments, ours: toLines(v.ours).join('\n'), theirs: toLines(v.theirs).join('\n'), base: toLines(v.base ?? '').join('\n'), eol: eolOf(disk || v.ours) });
      } catch (e) {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ws, path, whitespace]);

  useEffect(() => {
    if (!loaded || !hosts.ours.current || !hosts.result.current || !hosts.theirs.current) return;
    const { segments } = loaded;
    const language = languageOf(path, loaded.ours);
    const base: monaco.editor.IStandaloneEditorConstructionOptions = {
      theme,
      automaticLayout: true,
      fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
      fontSize: settings.fontSize,
      lineHeight: Math.round(settings.fontSize * settings.lineHeight),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      contextmenu: false,
      folding: false,
      codeLens: false,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 10 },
    };
    const uri = (side: string) => scratchUri(`merge/${side}`, path);
    // The result starts as the common base. It ends with a spare empty line (dropped on Apply): every
    // tracked block then ends at the start of a next line, also the file's last one.
    const models = {
      ours: monaco.editor.createModel(loaded.ours, language, uri('ours')),
      result: monaco.editor.createModel(mergedText(segments, statesRef.current) + '\n', language, uri('result')),
      theirs: monaco.editor.createModel(loaded.theirs, language, uri('theirs')),
    };
    const panes = {
      ours: monaco.editor.create(hosts.ours.current, { ...base, model: models.ours, readOnly: true }),
      result: monaco.editor.create(hosts.result.current, { ...base, model: models.result }),
      theirs: monaco.editor.create(hosts.theirs.current, { ...base, model: models.theirs, readOnly: true }),
    };

    const places = segmentPlaces(segments, statesRef.current);
    const ids = models.result.deltaDecorations(
      [],
      segments.flatMap((s, i) => (s.kind === 'same' ? [] : [{ range: blockRange(models.result, places[i].result.start, places[i].result.count), options: TRACK }])),
    );
    let t = 0;
    const expand = (key: string) => setExpanded((s) => new Set(s).add(key));
    live.current = {
      panes,
      trackers: segments.map((s) => (s.kind === 'same' ? null : ids[t++])),
      folds: { ours: new FoldZones(panes.ours, path, expand), result: new FoldZones(panes.result, path, expand), theirs: new FoldZones(panes.theirs, path, expand) },
    };

    // The panes scroll together, segment by segment.
    let syncing = false;
    const subs: monaco.IDisposable[] = [];
    for (const name of ['ours', 'result', 'theirs'] as Pane[]) {
      const ed = panes[name];
      subs.push(
        ed.onDidScrollChange((e) => {
          if (e.scrollTopChanged && syncRef.current && !syncing) {
            syncing = true;
            const top = ed.getVisibleRanges()[0]?.startLineNumber ?? 1;
            const within = ed.getScrollTop() - ed.getTopForLineNumber(top);
            const p = placesNow();
            for (const other of ['ours', 'result', 'theirs'] as Pane[]) {
              if (other !== name) panes[other].setScrollTop(panes[other].getTopForLineNumber(matchingLine(p[name], p[other], top)) + within);
            }
            syncing = false;
          }
          redraw();
        }),
        ed.onDidLayoutChange(() => redraw()),
      );
    }
    subs.push(models.result.onDidChangeContent(() => (paint(), redraw())));
    paint();
    redraw();

    return () => {
      subs.forEach((s) => s.dispose());
      if (live.current) Object.values(live.current.folds).forEach((f) => f.dispose());
      Object.values(panes).forEach((p) => p.dispose());
      Object.values(models).forEach((m) => m.dispose());
      live.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => monaco.editor.setTheme(theme), [theme]);
  // Folding lines in or out moves everything: the bands are drawn again.
  useEffect(() => {
    paint();
    redraw();
  }, [states, collapse, highlight, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Each segment's lines in the three panes now (the result's from its tracked blocks, as edited). */
  function placesNow(): Record<Pane, { start: number; count: number }[]> {
    const l = live.current!;
    const p = segmentPlaces(loaded!.segments, statesRef.current);
    const model = l.panes.result.getModel()!;
    const res = p.map((x, i) => (l.trackers[i] ? blockOf(model, l.trackers[i]!) : x.result));
    for (let i = 0; i < res.length; i++) if (!l.trackers[i]) res[i] = { start: i ? res[i - 1].start + res[i - 1].count : 1, count: p[i].result.count };
    return { ours: p.map((x) => x.ours), theirs: p.map((x) => x.theirs), result: res };
  }

  // Line highlights by state: pending conflicts and changes, applied and ignored ones.
  const decorations = useRef<Record<Pane, string[]>>({ ours: [], result: [], theirs: [] });
  function paint() {
    const l = live.current;
    if (!l || !loaded) return;
    const p = placesNow();
    const hl = highlightRef.current;
    // Do not highlight: only the marks in the gutter.
    const lines = (at: { start: number; count: number }, className: string): monaco.editor.IModelDeltaDecoration[] =>
      at.count
        ? [{ range: new monaco.Range(at.start, 1, at.start + at.count - 1, 1), options: { isWholeLine: true, className: hl === 'none' ? undefined : className, linesDecorationsClassName: `${className}-mark` } }]
        : [{ range: new monaco.Range(Math.max(1, at.start - 1), 1, Math.max(1, at.start - 1), 1), options: { isWholeLine: true, className: `${className}-gap` } }];
    /** Words or characters: what each side changed in a chunk, against the base. */
    const inner = (s: Segment, side: 'ours' | 'theirs', at: { start: number }): monaco.editor.IModelDeltaDecoration[] => {
      if ((hl !== 'words' && hl !== 'chars') || s.kind === 'same' || !s.base.length || !s[side].length || s.base.length + s[side].length > 400) return [];
      return innerRanges(s.base, s[side], hl, whitespace)
        .filter((r) => r.side === 'b')
        .map((r) => ({ range: new monaco.Range(at.start + r.line, r.start + 1, at.start + r.line, r.end + 1), options: { inlineClassName: 'diff-inner-add' } }));
    };
    const out: Record<Pane, monaco.editor.IModelDeltaDecoration[]> = { ours: [], result: [], theirs: [] };
    loaded.segments.forEach((s, i) => {
      const st = statesRef.current[i];
      if (s.kind === 'same' || !st) return;
      const conflict = s.kind === 'conflict';
      for (const side of ['ours', 'theirs'] as const) {
        const state = st[side];
        if (!state) continue;
        const cls = state === 'applied' ? 'merge-applied' : state === 'ignored' ? 'merge-ignored' : conflict ? 'merge-conflict' : `merge-${changeKind(s, side)}`;
        out[side].push(...lines(p[side][i], cls));
        if (state === 'pending') out[side].push(...inner(s, side, p[side][i]));
      }
      if (!isResolved(st)) out.result.push(...lines(p.result[i], conflict ? 'merge-conflict' : 'merge-modified'));
    });
    // Collapsed: each long unchanged stretch keeps CONTEXT lines next to the changes; the rest is a
    // wavy strip (a click shows it). The same stretch has the same key in the three panes.
    const n = loaded.segments.length;
    for (const pane of ['ours', 'result', 'theirs'] as Pane[]) {
      const folds: Fold[] = [];
      if (collapseRef.current) {
        loaded.segments.forEach((s, i) => {
          if (s.kind !== 'same' || expandedRef.current.has(`s${i}`)) return;
          const at = p[pane][i];
          const from = at.start + (i > 0 ? CONTEXT : 0);
          const to = at.start + at.count - 1 - (i < n - 1 ? CONTEXT : 0);
          if (to - from >= 1) folds.push({ key: `s${i}`, from, to });
        });
      }
      l.folds[pane].set(folds);
    }
    for (const pane of ['ours', 'result', 'theirs'] as Pane[]) decorations.current[pane] = l.panes[pane].getModel()!.deltaDecorations(decorations.current[pane], out[pane]);
  }

  /** Applies or ignores one side of segment i; the result block is rewritten when its text changes. */
  function decide(i: number, side: 'ours' | 'theirs', action: 'apply' | 'ignore') {
    const l = live.current;
    if (!l || !loaded) return;
    const s = loaded.segments[i];
    const st = statesRef.current[i];
    if (!st) return;
    const next = act(s, st, side, action);
    if (next === st) return;
    const before = resultLines(s, st);
    const after = resultLines(s, next);
    if (before.join('\n') !== after.join('\n') || before.length !== after.length) {
      const model = l.panes.result.getModel()!;
      const block = blockOf(model, l.trackers[i]!);
      replaceLines(model, block.start, block.count, after);
      l.trackers[i] = model.deltaDecorations([l.trackers[i]!], [{ range: blockRange(model, block.start, after.length), options: TRACK }])[0];
    }
    setStates(statesRef.current.map((x, k) => (k === i ? next : x)));
  }

  function applyNonConflicting(sides: ('ours' | 'theirs')[]) {
    if (!loaded) return;
    loaded.segments.forEach((s, i) => {
      if (s.kind === 'change') for (const side of sides) if (statesRef.current[i]?.[side] === 'pending') decide(i, side, 'apply');
    });
  }

  /** The next (or previous) chunk with something left to decide, after the result's caret. */
  function go(dir: 1 | -1) {
    const l = live.current;
    if (!l || !loaded) return;
    const p = placesNow();
    const line = l.panes.result.getPosition()?.lineNumber ?? 0;
    const open = loaded.segments.map((_, i) => i).filter((i) => !isResolved(statesRef.current[i]));
    if (!open.length) return;
    const starts = open.map((i) => p.result[i].start);
    const target = dir === 1 ? starts.find((s) => s > line) ?? starts[0] : [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1];
    l.panes.result.setPosition({ lineNumber: target, column: 1 });
    l.panes.result.revealLineInCenter(target);
    l.panes.result.focus();
  }

  const pendingChanges = loaded ? loaded.segments.filter((s, i) => s.kind === 'change' && !isResolved(states[i])).length : 0;
  const pendingConflicts = loaded ? loaded.segments.filter((s, i) => s.kind === 'conflict' && !isResolved(states[i])).length : 0;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const status = loaded ? `${pendingChanges ? plural(pendingChanges, 'change') : 'No changes'}. ${pendingConflicts ? plural(pendingConflicts, 'conflict') : 'No conflicts'}.` : 'Reading…';

  const apply = async () => {
    const l = live.current;
    if (!l || !loaded) return;
    const left = pendingChanges + pendingConflicts;
    if (left && !(await confirmDialog(`${plural(left, 'change')} ${left === 1 ? 'was' : 'were'} neither applied nor ignored. Save the result as it is and mark the file resolved?`))) return;
    setBusy(true);
    try {
      const value = l.panes.result.getModel()!.getValue();
      const text = (value.endsWith('\n') ? value.slice(0, -1) : value).replace(/\r?\n/g, loaded.eol);
      await ws.backend.writeFile(path, text);
      await ws.gitRepo.markResolved([path]);
      await ws.refreshGit();
      onClose(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  /** Accept Left / Right: the whole file as that side has it. */
  const acceptSide = async (side: 'ours' | 'theirs') => {
    setBusy(true);
    try {
      await ws.gitRepo.acceptSide(path, side, false);
      await ws.refreshGit();
      onClose(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop merge-backdrop">
      <div
        className="pb-dialog merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-title"
        onKeyDown={(e) => {
          if (e.key === 'F7') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            onClose(false);
          }
        }}
      >
        <div className="pb-dialog-title merge-window-title" id="merge-title">
          Merge Revisions for {path}
        </div>
        <div className="tw-toolbar merge-toolbar">
          <button type="button" className="icon-btn small" title="Previous Change (Shift+F7)" aria-label="Previous change" onClick={() => go(-1)}>
            <Icon name="chevronUp" size={13} />
          </button>
          <button type="button" className="icon-btn small" title="Next Change (F7)" aria-label="Next change" onClick={() => go(1)}>
            <Icon name="chevronDown" size={13} />
          </button>
          <span className="te-sep" />
          <span className="muted merge-apply-label">Apply non-conflicting changes:</span>
          <button type="button" className="btn small ghost" disabled={!pendingChanges} onClick={() => applyNonConflicting(['ours'])} title={`Apply the changes from ${names.ours} that don't conflict`}>
            » Left
          </button>
          <button type="button" className="btn small ghost" disabled={!pendingChanges} onClick={() => applyNonConflicting(['ours', 'theirs'])} title="Apply every change that doesn't conflict">
            »« All
          </button>
          <button type="button" className="btn small ghost" disabled={!pendingChanges} onClick={() => applyNonConflicting(['theirs'])} title={`Apply the changes from ${names.theirs} that don't conflict`}>
            « Right
          </button>
          <span className="te-sep" />
          <select
            className="field select diff-select"
            aria-label="Whitespace"
            title="What whitespace counts as a change (changing it starts the merge of this file over)"
            value={whitespace}
            onChange={(e) => {
              const v = e.target.value as MergeWhitespace;
              savePref(WHITESPACE_KEY, v);
              setWhitespace(v);
            }}
          >
            {MERGE_WHITESPACE.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="field select diff-select"
            aria-label="Highlighting"
            title="What's highlighted inside a change"
            value={highlight}
            onChange={(e) => {
              const v = e.target.value as HighlightMode;
              savePref(HIGHLIGHT_KEY, v);
              setHighlight(v);
            }}
          >
            {MERGE_HIGHLIGHT.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={'btn small ghost' + (collapse ? ' on' : '')}
            aria-pressed={collapse}
            onClick={() =>
              setCollapse((v) => {
                try {
                  localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
                } catch {
                  // Only a preference.
                }
                // Collapsing again folds what was opened too.
                if (!v) setExpanded(new Set());
                return !v;
              })
            }
            title="Collapse Unchanged Fragments"
          >
            <Icon name="collapseAll" size={13} />
            Collapse Unchanged
          </button>
          <button type="button" className={'btn small ghost' + (sync ? ' on' : '')} aria-pressed={sync} onClick={() => setSync((v) => !v)} title="Scroll the three panes together">
            <Icon name="columns" size={13} />
            Sync Scrolling
          </button>
          <span className="grow" />
          <span className={'merge-count' + (pendingChanges + pendingConflicts ? '' : ' done')}>{status}</span>
        </div>
        <div className="merge-heads">
          <span>Changes from {names.ours}</span>
          <span className="merge-head-gap" />
          <span>
            Result <span className="muted">{relativePath(ws.backend, path)}</span>
          </span>
          <span className="merge-head-gap" />
          <span>Changes from {names.theirs}</span>
        </div>
        {error && (
          <div className="te-error">
            <pre>{error}</pre>
          </div>
        )}
        <div className="merge-panes" data-theme={theme}>
          <div ref={hosts.ours} className="merge-pane" />
          <MergeDivider which="left" live={live.current} loaded={loaded} states={states} places={live.current && loaded ? placesNow() : null} decide={decide} />
          <div ref={hosts.result} className="merge-pane merge-result" />
          <MergeDivider which="right" live={live.current} loaded={loaded} states={states} places={live.current && loaded ? placesNow() : null} decide={decide} />
          <div ref={hosts.theirs} className="merge-pane" />
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" disabled={!loaded || busy} onClick={() => void acceptSide('ours')} title={`The whole file as ${names.ours} has it`}>
            Accept Left
          </button>
          <button type="button" className="btn" disabled={!loaded || busy} onClick={() => void acceptSide('theirs')} title={`The whole file as ${names.theirs} has it`}>
            Accept Right
          </button>
          <span className="grow" />
          <button type="button" className="btn primary" disabled={!loaded || busy} onClick={() => void apply()}>
            Apply
          </button>
          <button type="button" className="btn" onClick={() => onClose(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const DIVIDER = 64;

/** The gutter between a side pane and the result: a band per change linking both, with its buttons. */
function MergeDivider({
  which,
  live,
  loaded,
  states,
  places,
  decide,
}: {
  which: 'left' | 'right';
  live: { panes: Record<Pane, monaco.editor.IStandaloneCodeEditor>; folds: Record<Pane, FoldZones> } | null;
  loaded: Loaded | null;
  states: (ChunkState | null)[];
  places: Record<Pane, { start: number; count: number }[]> | null;
  decide: (i: number, side: 'ours' | 'theirs', action: 'apply' | 'ignore') => void;
}) {
  const side = which === 'left' ? 'ours' : 'theirs';
  if (!live || !loaded || !places) return <div className="merge-divider" style={{ width: DIVIDER }} />;
  const sideEd = live.panes[side];
  const resEd = live.panes.result;
  const lh = sideEd.getOption(monaco.editor.EditorOption.lineHeight);
  /** The y of a line's top in a pane, relative to the divider (the panes start at the same height). */
  const y = (ed: monaco.editor.IStandaloneCodeEditor, line: number) => {
    const count = ed.getModel()?.getLineCount() ?? 1;
    return (line > count ? ed.getTopForLineNumber(count) + lh : ed.getTopForLineNumber(line)) - ed.getScrollTop();
  };
  // Left: the side pane is at x=0 and the result at x=W; right: the other way round.
  const W = DIVIDER;
  const sx = which === 'left' ? 0 : W;
  const rx = which === 'left' ? W : 0;
  const bands: React.ReactNode[] = [];
  const buttons: React.ReactNode[] = [];
  loaded.segments.forEach((s, i) => {
    const st = states[i];
    if (s.kind === 'same' || !st || !st[side]) return;
    const a = places[side][i];
    const r = places.result[i];
    const t1 = y(sideEd, a.start);
    const b1 = a.count ? y(sideEd, a.start + a.count) : t1;
    const t2 = y(resEd, r.start);
    const b2 = r.count ? y(resEd, r.start + r.count) : t2;
    const state = st[side];
    const kind = state === 'applied' ? 'applied' : state === 'ignored' ? 'ignored' : s.kind === 'conflict' ? 'conflict' : changeKind(s, side);
    const mid = W / 2;
    bands.push(
      <path
        key={i}
        className={`merge-band merge-band-${kind}`}
        d={`M${sx},${t1} C${mid},${t1} ${mid},${t2} ${rx},${t2} L${rx},${b2} C${mid},${b2} ${mid},${b1} ${sx},${b1} Z`}
      />,
    );
    if (state === 'pending' && t1 > -lh && t1 < sideEd.getLayoutInfo().height) {
      const arrow = which === 'left' ? '»' : '«';
      const take = (
        <button key="take" type="button" className="merge-btn take" title={`Apply (${which === 'left' ? '→' : '←'} result)`} aria-label="Apply this change" onClick={() => decide(i, side, 'apply')}>
          {arrow}
        </button>
      );
      const ignore = (
        <button key="ignore" type="button" className="merge-btn ignore" title="Ignore this change" aria-label="Ignore this change" onClick={() => decide(i, side, 'ignore')}>
          ×
        </button>
      );
      buttons.push(
        <div key={i} className={`merge-btns ${which}`} style={{ top: t1 }}>
          {which === 'left' ? [ignore, take] : [take, ignore]}
        </div>,
      );
    }
  });
  // A fold's wavy strip goes on across the gutter to the same fold in the result.
  const resultFolds = new Map(live.folds.result.places().map((f) => [f.key, f]));
  const links = live.folds[side].places().flatMap((f) => {
    const other = resultFolds.get(f.key);
    return other ? [<path key={f.key} className="fold-link" d={wavyPath(sx, f.top + f.height / 2, rx, other.top + other.height / 2)} />] : [];
  });
  return (
    <div className="merge-divider" style={{ width: W }}>
      <svg width={W} height="100%" aria-hidden>
        {bands}
        {links}
      </svg>
      {buttons}
    </div>
  );
}

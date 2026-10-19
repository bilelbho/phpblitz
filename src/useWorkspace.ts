import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { invalidateLaravelFiles, setLaravelProject } from './completion/laravel';
import { isScriptModel, scriptFileChanged, scriptFilesChanged, scriptProblem, scriptUsages, setScriptContext } from './jsProjects';
import { anchorOf, DEFAULT_LAYOUT, isBottomTool, loadToolLayout, moveTool as moveToolIn, saveToolLayout, type Anchor, type BottomTool, type SideAnchor, type SideTool, type Tool, type ToolLayout } from './toolLayout';
import * as monaco from 'monaco-editor';
import type { Backend, CommitOptions, Entry, GitInfo, Package, Problem, RunResult } from './backend/types';
import { testRunner, type Scope } from './tests/runner';
import { baseName } from './backend/types';
import { languageOf, phpIndex, routesOf, structureOf, type PhpSymbol, type Route } from './php';
import { symbols } from './symbols';
import { findUsages as indexFindUsages, setDefinitionOpener, targetAt } from './navigation';
import { refreshUsageHints } from './monaco';
import {
  magoAvailable,
  magoCheck,
  magoClose,
  magoDisableRule,
  magoEnsureConfig,
  magoOpen,
  magoAnalyze,
  magoProjectIssues,
  magoSync,
  suppressionComment,
  toProblem,
  type MagoSummary,
} from './mago';
import { confirmDialog, isTauri } from './platform';
import { invoke } from '@tauri-apps/api/core';
import { LspClient, pathToUri, uriToPath, type ServerSpec } from './lsp/client';
import { listen } from '@tauri-apps/api/event';
import { terminals } from './terminal/manager';
import { db } from './db/store';
import { consoleText } from './components/QueryConsole';
import { ANALYSIS_DELAY, AnalysisQueue, CODE_INSIGHT_LIMIT, lowPriority, markBusy } from './daemon';
import { caretMoved, fileShown, goBack, goForward, resetHistory, tabClosed, takeClosed, type Place } from './navHistory';
import { FileResolver } from './terminal/fileLinks';
import { dirMarks } from './dirMarks';
import { bookmarks } from './bookmarks';
import { planForTarget, renameEdits } from './rename';
import { perf } from './perf';
import { insertTab, nextActive, overLimit } from './tabPolicy';
import { getSettings } from './settings';
import { Git } from './git/git';
import type { SearchOptions, SearchResult } from './search';
import { applyEditNow, findUsages as lspFindUsages, renameSymbol, setActiveLsp, type Usage } from './lsp/monacoBridge';
import type { Diagnostic, WorkspaceEdit } from './lsp/protocol';
import { debug, useDebug } from './debug/manager';
import { useInterpreters } from './interpreters';
import { projectStorage } from './projectStorage';

/** `preview`: the preview tab (italic), replaced by the next previewed file. */
export type Tab =
  | { id: string; kind: 'file'; path: string; preview?: boolean }
  /** A database table's data (Database tool window). */
  | { id: string; kind: 'table'; source: string; schema: string; table: string }
  /** A data source's query console. */
  | { id: string; kind: 'console'; source: string; name: string }
  /** Side-by-side diff: HEAD vs the working copy, or a commit vs its parent. */
  | { id: string; kind: 'diff'; path: string; commit?: string };
/** Left tool windows. Structure docks in the bottom half, the others in the top half. */
export type LeftTool = 'project' | 'commit' | 'structure' | 'database';
export type RightTool = 'notifications' | 'ai' | 'endpoints' | 'composer' | 'npm';
export type GitDialogRequest =
  | { kind: 'push' }
  | { kind: 'newBranch'; from?: string }
  | { kind: 'renameBranch'; branch: string }
  | { kind: 'checkoutRevision' }
  | { kind: 'stash' }
  | { kind: 'unstash' }
  | { kind: 'reset'; hash: string; subject: string }
  | { kind: 'tag'; hash: string };

/** A usage search's results (Find Usages / Show Usages). */
export interface UsageSearch {
  name: string;
  /** "\\App\\Entity\\Photo.$uploader" (empty with a language server). */
  title: string;
  /** "Field", "Method", "Class"… */
  kind: string;
  container: string;
  items: Usage[];
  target: unknown;
}

export interface UsagesPopupState extends Omit<UsageSearch, 'target'> {
  request: { model: monaco.editor.ITextModel; position: monaco.IPosition; anchor: { x: number; y: number } };
  loading: boolean;
  vendor: boolean;
  error?: string;
  target?: unknown;
}

export type BottomTab = 'problems' | 'terminal' | 'tests' | 'composer' | 'usages' | 'find' | 'git' | 'debug' | 'todo';

/** The tool window a bottom tab belongs to (Find and Usages results always open in the bottom panel). */
export function toolOfTab(tab: BottomTab): BottomTool | null {
  if (tab === 'usages' || tab === 'find') return null;
  return tab === 'composer' ? 'composerLog' : tab;
}
export const tabOfTool = (t: BottomTool): BottomTab => (t === 'composerLog' ? 'composer' : t);
const ALL_TOOLS = Object.values(DEFAULT_LAYOUT).flat();

export interface LspStatus {
  state: 'off' | 'starting' | 'ready' | 'missing' | 'stopped' | 'error';
  name?: string;
  message?: string;
}

/** Language servers PHPBlitz knows how to start, in order of preference. */
const KNOWN_SERVERS: { name: string; executable: string; args: string[] }[] = [
  { name: 'PHPantom', executable: 'phpantom_lsp', args: ['--stdio'] },
  { name: 'php-lsp', executable: 'php-lsp', args: [] },
];

export interface Notice {
  id: number;
  title: string;
  body: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  action?: { label: string; run: () => void };
}

export interface GotoRequest {
  path: string;
  line?: number;
  column?: number;
  /** Regex source; the first matching line is revealed. */
  find?: string;
  nonce: number;
}

const INDEX_BATCH = 24;
const MAX_INDEXED = 4000;

export function useWorkspace(backend: Backend) {
  // ── Project tree ──────────────────────────────────────────────
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([backend.root]));

  const childrenRef = useRef(children);
  childrenRef.current = children;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  /** Folders being listed: one request per folder at a time. */
  const listing = useRef(new Map<string, Promise<void>>());

  /**
   * Lists a folder into the tree. A folder that is shown open also gets its sub-folders listed in
   * the background (one level ahead), so opening them is instant.
   * `quiet`: a background listing (no error notification).
   */
  const loadDir = useCallback(
    (path: string, quiet = false): Promise<void> => {
      const pending = listing.current.get(path);
      if (pending) return pending;
      const run = (async () => {
        let entries: Entry[] | null = null;
        let error: unknown = null;
        for (let attempt = 0; attempt < 2 && !entries; attempt++) {
          try {
            entries = await backend.listDir(path);
          } catch (e) {
            error = e;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
          }
        }
        if (!entries) {
          // Not a Loading… row forever: an empty folder, and why (unless this was a background listing).
          setChildren((c) => (c[path] ? c : { ...c, [path]: [] }));
          if (!quiet) notify({ title: 'Could not read folder', body: `${path}: ${String(error)}`, tone: 'error' });
          return;
        }
        const listed = entries;
        setChildren((c) => ({ ...c, [path]: listed }));
        if (expandedRef.current.has(path)) prefetchUnder(listed);
      })().finally(() => listing.current.delete(path));
      listing.current.set(path, run);
      return run;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend],
  );

  /** Lists sub-folders not listed yet, when the UI is idle (at most 40 at a time). */
  const prefetchUnder = useCallback((entries: Entry[]) => {
    const todo = entries.filter((e) => e.isDir && !childrenRef.current[e.path] && !listing.current.has(e.path) && !['node_modules', '.git'].includes(e.name)).slice(0, 40);
    if (!todo.length) return;
    void (async () => {
      for (const e of todo) {
        await lowPriority();
        if (!childrenRef.current[e.path]) await loadDir(e.path, true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDir = useCallback(
    (path: string) => {
      const open = !expandedRef.current.has(path);
      const next = new Set(expandedRef.current);
      if (open) next.add(path);
      else next.delete(path);
      // Updated now, so a second click before the next render sees this one.
      expandedRef.current = next;
      setExpanded(next);
      if (!open) return;
      const known = childrenRef.current[path];
      if (known) prefetchUnder(known);
      else void loadDir(path);
    },
    [loadDir, prefetchUnder],
  );

  /** Expands every folder between the project root and `path` (Always Select Opened File). */
  const revealInTree = useCallback(
    async (path: string) => {
      if (!path.startsWith(backend.root + '/')) return;
      const parts = path.slice(backend.root.length + 1).split('/').slice(0, -1);
      const dirs = [backend.root];
      parts.forEach((p) => dirs.push(`${dirs[dirs.length - 1]}/${p}`));
      setExpanded((prev) => (dirs.every((d) => prev.has(d)) ? prev : new Set([...prev, ...dirs])));
      // Load from the top down, so each folder's children exist before the next level renders.
      for (const d of dirs) await loadDir(d);
    },
    [backend, loadDir],
  );

  /** Expands a folder and everything under it, loading lazily (Expand Selected). */
  const expandRecursively = useCallback(
    async (dir: string, limit = 300) => {
      const queue = [dir];
      const opened: string[] = [];
      while (queue.length && opened.length < limit) {
        const d = queue.shift()!;
        opened.push(d);
        const entries = await backend.listDir(d).catch(() => [] as Entry[]);
        setChildren((c) => ({ ...c, [d]: entries }));
        for (const e of entries) if (e.isDir && !['vendor', 'node_modules', '.git'].includes(e.name)) queue.push(e.path);
      }
      setExpanded((prev) => new Set([...prev, ...opened]));
    },
    [backend],
  );

  const collapseAll = useCallback(() => setExpanded(new Set([backend.root])), [backend]);

  // ── Notifications ─────────────────────────────────────────────
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextNoticeId = useRef(1);
  const notify = useCallback((n: Omit<Notice, 'id'>) => {
    const id = nextNoticeId.current++;
    setNotices((list) => [{ ...n, id }, ...list.filter((x) => x.title !== n.title || x.body !== n.body)].slice(0, 30));
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices((list) => list.filter((n) => n.id !== id)), []);

  // ── Tool windows ──────────────────────────────────────────────
  // Side tool windows: where each lives (draggable between the strips) and which is open in each place.
  const [toolLayout, setToolLayoutState] = useState<ToolLayout>(loadToolLayout);
  const toolLayoutRef = useRef(toolLayout);
  toolLayoutRef.current = toolLayout;
  const [openTools, setOpenTools] = useState<Record<SideAnchor, Tool | null>>({ leftTop: 'project', leftBottom: null, rightTop: null, rightBottom: null });
  /** A side tool window (Project, Commit…) dragged into the bottom panel and open there. */
  const [bottomSideTool, setBottomSideTool] = useState<SideTool | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('problems');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Settings window (Ctrl+Alt+S), open on a page. */
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  /** Find in Files (Ctrl+Shift+F) / Replace in Files (Ctrl+Shift+R) popup. */
  /** `dir`: search only that folder (Project tree ▸ Find in Files…). */
  const [findInFiles, setFindInFiles] = useState<{ mode: 'find' | 'replace'; seed: string; dir?: string; nonce: number } | null>(null);
  const openFindInFiles = useCallback(
    (mode: 'find' | 'replace', seed = '', dir?: string) => setFindInFiles({ mode, seed, dir, nonce: Date.now() }),
    [],
  );
  /** Results pinned to the bottom "Find" tool window. */
  const [findResults, setFindResults] = useState<{ options: SearchOptions; result: SearchResult } | null>(null);
  const [searchTab, setSearchTab] = useState<'all' | 'classes' | 'files' | 'symbols' | 'actions'>('all');
  /** Search Everywhere on a tab: Ctrl+N classes, Ctrl+Shift+N files, Ctrl+Shift+A actions. */
  const openSearch = useCallback((tab: 'all' | 'classes' | 'files' | 'symbols' | 'actions' = 'all') => {
    setSearchTab(tab);
    setSearchOpen(true);
  }, []);
  // Which tool window is open where, for the callbacks below (they run outside renders).
  const openRef = useRef({ openTools, bottomOpen, bottomTab, bottomSideTool });
  openRef.current = { openTools, bottomOpen, bottomTab, bottomSideTool };
  const toolOpenNow = (t: Tool): boolean => {
    const { openTools: open, bottomOpen: bOpen, bottomTab: tab, bottomSideTool: bSide } = openRef.current;
    const anchor = anchorOf(toolLayoutRef.current, t);
    if (anchor !== 'bottom') return open[anchor] === t;
    return bOpen && (isBottomTool(t) ? !bSide && toolOfTab(tab) === t : bSide === t);
  };
  const isToolOpen = toolOpenNow;
  /** Opens a tool window where it lives, without closing it when it is already open. */
  const showTool = useCallback((t: Tool) => {
    const anchor = anchorOf(toolLayoutRef.current, t);
    if (anchor === 'bottom') {
      if (isBottomTool(t)) {
        setBottomSideTool(null);
        setBottomTab(tabOfTool(t));
      } else setBottomSideTool(t);
      setBottomOpen(true);
    } else setOpenTools((o) => ({ ...o, [anchor]: t }));
  }, []);
  const hideTool = useCallback((t: Tool) => {
    const anchor = anchorOf(toolLayoutRef.current, t);
    if (anchor === 'bottom') setBottomOpen(false);
    else setOpenTools((o) => (o[anchor] === t ? { ...o, [anchor]: null } : o));
  }, []);
  const toggleTool = useCallback((t: Tool) => (toolOpenNow(t) ? hideTool(t) : showTool(t)), [hideTool, showTool]);
  /** Drops a tool window at `index` of `anchor`; it stays open (or closed) as it was. */
  const placeTool = useCallback(
    (t: Tool, anchor: Anchor, index: number) => {
      const was = toolOpenNow(t);
      if (was) hideTool(t);
      const next = moveToolIn(toolLayoutRef.current, t, anchor, index);
      toolLayoutRef.current = next;
      setToolLayoutState(next);
      saveToolLayout(next);
      if (was) showTool(t);
    },
    [hideTool, showTool],
  );
  const resetToolLayout = useCallback(() => {
    const open = ALL_TOOLS.filter(toolOpenNow);
    setOpenTools({ leftTop: null, leftBottom: null, rightTop: null, rightBottom: null });
    setBottomSideTool(null);
    toolLayoutRef.current = DEFAULT_LAYOUT;
    setToolLayoutState(DEFAULT_LAYOUT);
    saveToolLayout(DEFAULT_LAYOUT);
    open.forEach(showTool);
  }, [showTool]);
  // The names the rest of the app uses.
  const toggleLeft = toggleTool as (t: LeftTool) => void;
  const showLeft = showTool as (t: LeftTool) => void;
  const toggleRight = toggleTool as (t: RightTool) => void;
  const setRightTool = useCallback((t: RightTool | null) => (t ? showTool(t) : setOpenTools((o) => ({ ...o, rightTop: null, rightBottom: null }))), [showTool]);
  /** Opens a bottom tool window (Problems, Terminal…), wherever it was dragged. */
  const showBottom = useCallback(
    (t: BottomTab) => {
      const tool = toolOfTab(t);
      if (tool && anchorOf(toolLayoutRef.current, tool) !== 'bottom') return showTool(tool);
      setBottomSideTool(null);
      setBottomTab(t);
      setBottomOpen(true);
    },
    [showTool],
  );

  // ── Editor tabs and documents ─────────────────────────────────
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const savedText = useRef<Record<string, string>>({});
  /** Editor documents edited since their text was last read: read on demand, not per keystroke. */
  const staleModels = useRef(new Map<string, monaco.editor.ITextModel>());
  /**
   * The current text of each open file (unsaved edits included). Typing only marks the file
   * stale; its text is read from the editor the first time something asks for it (save, search,
   * the analysis after a pause), so a keystroke never copies the whole document.
   */
  const liveText = useRef<Record<string, string>>(
    new Proxy({} as Record<string, string>, {
      get(target, key) {
        if (typeof key === 'string') {
          const model = staleModels.current.get(key);
          if (model) {
            staleModels.current.delete(key);
            if (!model.isDisposed()) target[key] = model.getValue();
          }
        }
        return Reflect.get(target, key);
      },
      set(target, key, value) {
        if (typeof key === 'string') staleModels.current.delete(key);
        return Reflect.set(target, key, value);
      },
      deleteProperty(target, key) {
        if (typeof key === 'string') staleModels.current.delete(key);
        return Reflect.deleteProperty(target, key);
      },
    }),
  );
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [activeText, setActiveText] = useState('');
  const [goto, setGoto] = useState<GotoRequest | null>(null);
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  /** Problems from the language server or `php -l`; used when Mago is not available (browser). */
  const [otherProblems, setOtherProblems] = useState<Record<string, Problem[]>>({});
  /** Problems from Mago (lint + analysis) for open files. */
  const [magoProblems, setMagoProblems] = useState<Record<string, Problem[]>>({});
  /** Errors from the TypeScript service in open .js/.ts files (it marks the editor itself). */
  const [scriptProblems, setScriptProblems] = useState<Record<string, Problem[]>>({});
  useEffect(() => {
    const sub = monaco.editor.onDidChangeMarkers((uris) => {
      setScriptProblems((prev) => {
        let next = prev;
        for (const uri of uris) {
          const markers = monaco.editor.getModelMarkers({ resource: uri }).filter((m) => (m.owner === 'typescript' || m.owner === 'javascript') && m.severity > monaco.MarkerSeverity.Hint);
          const path = uriToPath(uri.toString());
          if (!markers.length && !(path in next)) continue;
          if (next === prev) next = { ...prev };
          if (markers.length) next[path] = markers.map((m) => scriptProblem(path, m));
          else delete next[path];
        }
        return next;
      });
    });
    return () => sub.dispose();
  }, []);
  const baseProblems = magoAvailable ? magoProblems : otherProblems;
  const problems = useMemo(() => (Object.keys(scriptProblems).length ? { ...baseProblems, ...scriptProblems } : baseProblems), [baseProblems, scriptProblems]);
  const [status, setStatus] = useState('');

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activePath = activeTab?.kind === 'file' ? activeTab.path : null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // ── Recent Files (Ctrl+E) ─────────────────────────────────────
  /** Files opened in this project, most recent first (kept between sessions). */
  const recentKey = `phpblitz.recentFiles:${backend.root}`;
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try {
      return JSON.parse(projectStorage.getItem(`phpblitz.recentFiles:${backend.root}`) ?? '[]');
    } catch {
      return [];
    }
  });
  const recentRef = useRef(recentFiles);
  recentRef.current = recentFiles;
  /** Files changed in this session ("Show edited only"). */
  const [editedFiles, setEditedFiles] = useState<Set<string>>(new Set());
  const [recentOpen, setRecentOpen] = useState(false);
  const [locationsOpen, setLocationsOpen] = useState(false);
  useEffect(() => {
    if (!activePath) return;
    setRecentFiles((list) => {
      if (list[0] === activePath) return list;
      const next = [activePath, ...list.filter((p) => p !== activePath)].slice(0, 60);
      try {
        projectStorage.setItem(recentKey, JSON.stringify(next));
      } catch {
        // Only a convenience.
      }
      return next;
    });
  }, [activePath, recentKey]);
  const forgetRecent = useCallback(
    (path: string) =>
      setRecentFiles((list) => {
        const next = list.filter((p) => p !== path);
        try {
          projectStorage.setItem(recentKey, JSON.stringify(next));
        } catch {
          // Only a convenience.
        }
        return next;
      }),
    [recentKey],
  );

  // ── Language server ───────────────────────────────────────────
  const lspRef = useRef<LspClient | null>(null);
  const [lspStatus, setLspStatus] = useState<LspStatus>({ state: 'off' });

  // ── Mago (lint + analysis, built into the Rust core) ──────────
  const [magoStatus, setMagoStatus] = useState<{ state: 'off' | 'analyzing' | 'ready' | 'error'; summary?: MagoSummary; message?: string }>({
    state: 'off',
  });
  const [projectProblems, setProjectProblems] = useState<Problem[] | null>(null);
  /** How many problems the project really has (projectProblems is capped). */
  const [projectProblemsTotal, setProjectProblemsTotal] = useState(0);
  /** Type analysis problems held back because vendor/ is missing. */
  const [projectProblemsHidden, setProjectProblemsHidden] = useState(0);
  const checkSeq = useRef<Record<string, number>>({});
  /** Set once openWithMago exists (it is declared further down). */
  const reanalyzeRef = useRef<(() => void) | null>(null);

  /** Checks a file's text now. Responses for older text are dropped. Usually reached through checkFile. */
  const analyze = useCallback(
    async (path: string, text: string) => {
      if (!path.endsWith('.php') || largeFiles.current.has(path)) return;
      if (!magoAvailable) {
        // With a language server running, its diagnostics are the source of problems.
        if (lspRef.current?.running) return;
        const found = await backend.lint(path, text).catch(() => []);
        setOtherProblems((p) => ({ ...p, [path]: found }));
        return;
      }
      const seq = (checkSeq.current[path] ?? 0) + 1;
      checkSeq.current[path] = seq;
      try {
        const found = await magoCheck(path, text);
        if (checkSeq.current[path] !== seq || !(path in liveText.current)) return;
        setMagoProblems((p) => ({ ...p, [path]: found.map((d) => toProblem(path, d)) }));
      } catch (e) {
        console.warn('Mago check failed', e);
      }
    },
    [backend],
  );

  /** Files over the code insight limit: shown, not analyzed. */
  const largeFiles = useRef(new Set<string>());
  /** One analysis at a time, newest text per file, active file first, closed files dropped. */
  const analysisQueue = useRef<AnalysisQueue | null>(null);
  const analyzeRef = useRef(analyze);
  analyzeRef.current = analyze;
  analysisQueue.current ??= new AnalysisQueue(
    (path, text) => analyzeRef.current(path, text),
    () => (activeIdRef.current?.startsWith('file:') ? activeIdRef.current.slice(5) : null),
    (path) => path in liveText.current,
  );
  /** Queues a re-check of a file's text (after the editor has been quiet for a moment). */
  const checkFile = useCallback((path: string, text: string, delay?: number) => {
    if (!path.endsWith('.php') || largeFiles.current.has(path)) return;
    analysisQueue.current!.request(path, text, delay);
  }, []);

  const refreshProjectProblems = useCallback(async () => {
    if (!magoAvailable || backend.kind !== 'disk') return;
    const result = await magoProjectIssues().catch(() => null);
    if (!result) return;
    setProjectProblems(result.files.flatMap((f) => f.diagnostics.map((d) => toProblem(f.path, d))));
    setProjectProblemsTotal(result.total);
    setProjectProblemsHidden(result.hidden);
  }, [backend]);

  /** Forgets an editor document: model, texts, problems, language server sync. */
  const releaseFile = useCallback((path: string) => {
    analysisQueue.current?.drop(path);
    largeFiles.current.delete(path);
    // Drop the editor model after the tab switch, so a reopened file is read from disk again.
    const uri = monaco.Uri.file(path);
    window.setTimeout(() => monaco.editor.getModel(uri)?.dispose(), 0);
    lspRef.current?.didClose(path);
    setMagoProblems((p) => {
      const { [path]: _, ...rest } = p;
      return rest;
    });
    delete savedText.current[path];
    delete liveText.current[path];
    setLoaded((l) => {
      const { [path]: _, ...rest } = l;
      return rest;
    });
    setDirty((d) => {
      if (!d.has(path)) return d;
      const next = new Set(d);
      next.delete(path);
      return next;
    });
  }, []);

  /**
   * Opens a file in a tab. With `preview`, it reuses the preview tab ("Enable
   * Preview Tab"): the next preview replaces it until it is edited or pinned.
   */
  /** Files being read ahead of opening (mouse pressed on them in the tree). */
  const prefetched = useRef(new Map<string, Promise<string>>());
  /** When each file's open started (for Startup Performance: click → editor ready). */
  const openStarted = useRef(new Map<string, number>());
  /** Starts reading a file that is about to be opened, so the editor has it sooner. */
  const prefetchFile = useCallback(
    (path: string) => {
      if (path in savedText.current || prefetched.current.has(path)) return;
      const read = backend.readFile(path);
      read.catch(() => {});
      prefetched.current.set(path, read);
      // Not opened after all: forget it.
      window.setTimeout(() => prefetched.current.get(path) === read && prefetched.current.delete(path), 10_000);
    },
    [backend],
  );

  const openFile = useCallback(
    async (path: string, at?: { line?: number; column?: number; find?: string }, opts?: { preview?: boolean }) => {
      const id = `file:${path}`;
      // Only the latest open is timed (a tab opened in the background shows later, if ever).
      openStarted.current.clear();
      if (!(path in savedText.current)) openStarted.current.set(path, performance.now());
      const current = tabsRef.current;
      const tabRules = getSettings().tabs;
      // Settings ▸ Editor Tabs ▸ Enable preview tab: off means every file gets its own tab.
      const preview = !!opts?.preview && tabRules.previewTab;
      const existing = current.find((x) => x.id === id);
      const old = !existing && preview ? current.find((x) => x.kind === 'file' && x.preview && !dirtyRef.current.has(x.path)) : undefined;
      let next: Tab[];
      if (existing) {
        // Opening a previewed file for real pins it.
        next = existing.kind === 'file' && existing.preview && !preview ? current.map((x) => (x.id === id ? { ...x, preview: false } : x)) : current;
      } else if (old) {
        next = current.map((x) => (x.id === old.id ? { id, kind: 'file', path, preview: true } : x));
      } else {
        next = insertTab(current, { id, kind: 'file', path, preview }, activeIdRef.current, tabRules);
      }
      // Tab limit: close tabs (never unsaved ones or the new one) beyond it.
      const closing = overLimit(next, tabRules, id, (t) => t.kind === 'file' && dirtyRef.current.has(t.path), recentRef.current);
      if (closing.length) {
        for (const t of next) if (closing.includes(t.id) && t.kind === 'file') releaseFile(t.path);
        next = next.filter((t) => !closing.includes(t.id));
      }
      tabsRef.current = next;
      setTabs(next);
      if (old?.kind === 'file') releaseFile(old.path);
      // Back / Forward: opening at a line (search, declaration, usages) is a jump to that line.
      if (at?.line) caretMoved({ path, line: at.line, column: at.column ?? 1 });
      setActiveId(id);
      activeIdRef.current = id;
      // Opening a file comes first: background work (indexing) waits.
      markBusy();
      if (!(path in savedText.current)) {
        try {
          const ahead = prefetched.current.get(path);
          prefetched.current.delete(path);
          const readStart = performance.now();
          const text = await (ahead ?? backend.readFile(path));
          openReadMs.current.set(path, [Math.round(performance.now() - readStart), !!ahead]);
          savedText.current[path] = text;
          liveText.current[path] = text;
          if (text.length > CODE_INSIGHT_LIMIT) largeFiles.current.add(path);
          else largeFiles.current.delete(path);
          setLoaded((l) => ({ ...l, [path]: text }));
          if (!largeFiles.current.has(path)) {
            if (path.endsWith('.php') && lspRef.current?.running) lspRef.current.didOpen(path, 'php', text);
            checkFile(path, text, ANALYSIS_DELAY);
          }
        } catch (e) {
          setTabs((t) => t.filter((x) => x.id !== id));
          notify({ title: `Could not open ${baseName(path)}`, body: String(e), tone: 'error' });
          return;
        }
      }
      if (at) setGoto({ path, ...at, nonce: Date.now() });
    },
    [backend, notify, releaseFile, checkFile],
  );
  // ── Back / Forward, Reopen Closed Tab (navHistory.ts) ─────────
  // Another file's tab in front is a move too (a click on the tab doesn't touch its caret).
  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab?.kind === 'file') fileShown(tab.path);
  }, [activeId]);
  const goToPlace = useCallback((p: Place) => void openFile(p.path, { line: p.line, column: p.column }), [openFile]);
  const navigateBack = useCallback(() => {
    if (!goBack(goToPlace)) setStatus('No earlier location.');
  }, [goToPlace]);
  const navigateForward = useCallback(() => {
    if (!goForward(goToPlace)) setStatus('No later location.');
  }, [goToPlace]);
  const reopenClosedTab = useCallback(() => {
    const p = takeClosed((path) => tabsRef.current.some((t) => t.kind === 'file' && t.path === path));
    if (p) goToPlace(p);
    else setStatus('No closed tab to reopen.');
  }, [goToPlace]);

  /** How long reading each opened file took, and whether it was read ahead. */
  const openReadMs = useRef(new Map<string, [number, boolean]>());
  /** The editor for a file is ready: Startup Performance records the open. */
  const editorReady = useCallback((path: string) => {
    const started = openStarted.current.get(path);
    if (started === undefined) return;
    openStarted.current.delete(path);
    const read = openReadMs.current.get(path);
    const text = liveText.current[path] ?? '';
    const lines = text.split('\n').length;
    perf.record(`Open ${baseName(path)}`, started, performance.now(), `${lines.toLocaleString()} lines` + (read ? `, read in ${read[0]} ms${read[1] ? ' (started on mouse press)' : ''}` : ''));
  }, []);

  /** Drag and drop in the tab bar: moves the tab at `from` to index `to`. */
  const moveTab = useCallback((from: number, to: number) => {
    setTabs((list) => {
      if (from === to || from < 0 || from >= list.length) return list;
      const next = [...list];
      const [t] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, t);
      tabsRef.current = next;
      return next;
    });
  }, []);

  /** Turns a preview tab into a normal one (double-click on the tab, or editing it). */
  const pinTab = useCallback((id: string) => {
    setTabs((tabs) => (tabs.some((t) => t.id === id && t.kind === 'file' && t.preview) ? tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) : tabs));
  }, []);

  const openTable = useCallback((source: string, schema: string, table: string) => {
    const id = `table:${source}:${schema}.${table}`;
    setTabs((t) => (t.some((x) => x.id === id) ? t : [...t, { id, kind: 'table', source, schema, table }]));
    setActiveId(id);
  }, []);
  /** A data source's query console: "console" (the default one), or a named one. `sql` is put in it. */
  const openConsole = useCallback((source: string, name = 'console', sql?: string) => {
    const id = name === 'console' ? `console:${source}` : `console:${source}:${name}`;
    if (sql !== undefined) consoleText.set(source, name, sql);
    setTabs((t) => (t.some((x) => x.id === id) ? t : [...t, { id, kind: 'console', source, name }]));
    setActiveId(id);
  }, []);

  const closeTab = useCallback(
    async (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.kind === 'file' && dirty.has(tab.path)) {
        const discard = await confirmDialog(`${baseName(tab.path)} has unsaved changes. Close it and discard them?`);
        if (!discard) return;
      }
      if (tab.kind === 'file') {
        releaseFile(tab.path);
        tabClosed(tab.path);
      }
      const rest = tabs.filter((t) => t.id !== id);
      setTabs(rest);
      if (activeId === id) setActiveId(nextActive(tabs, [id], activeId, getSettings().tabs, recentRef.current));
    },
    [tabs, dirty, activeId, releaseFile],
  );

  /** Closes several tabs at once (Close Others / All / Unmodified…), asking once about unsaved ones. */
  const closeTabs = useCallback(
    async (ids: string[]) => {
      const closing = tabs.filter((t) => ids.includes(t.id));
      const unsaved = closing.filter((t) => t.kind === 'file' && dirty.has(t.path));
      if (unsaved.length) {
        const names = unsaved.length === 1 ? baseName((unsaved[0] as { path: string }).path) : `${unsaved.length} files`;
        if (!(await confirmDialog(`${names} ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes. Close and discard them?`))) return;
      }
      for (const t of closing) {
        if (t.kind !== 'file') continue;
        releaseFile(t.path);
        tabClosed(t.path);
      }
      const rest = tabs.filter((t) => !ids.includes(t.id));
      setTabs(rest);
      if (activeId && ids.includes(activeId)) setActiveId(nextActive(tabs, ids, activeId, getSettings().tabs, recentRef.current));
    },
    [tabs, dirty, activeId, releaseFile],
  );

  // Debounced work after typing: structure, the class index and (sample) linting.
  const typingTimer = useRef<number>();
  const onEdit = useCallback(
    (path: string, text: string) => {
      liveText.current[path] = text;
      markBusy(400);
      setEditedFiles((s) => (s.has(path) ? s : new Set(s).add(path)));
      if (!largeFiles.current.has(path)) lspRef.current?.didChange(path, text);
      // Editing a previewed file keeps it open.
      if (text !== savedText.current[path]) pinTab(`file:${path}`);
      setDirty((d) => {
        const isDirty = text !== savedText.current[path];
        if (isDirty === d.has(path)) return d;
        const next = new Set(d);
        if (isDirty) next.add(path);
        else next.delete(path);
        return next;
      });
      window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => {
        setActiveText(text);
        if (path.endsWith('.php') && text.length <= CODE_INSIGHT_LIMIT) {
          void symbols.updateText(path, text).then(() => {
            refreshUsageHints();
            bumpStructure();
          });
        }
        checkFile(path, text, 0);
      }, ANALYSIS_DELAY);
    },
    [checkFile, pinTab],
  );

  /**
   * Typing in the editor: the cheap path. The text is read only when needed; the language server
   * gets just the changed ranges when it takes them; a length check decides most dirty states.
   */
  const onModelEdit = useCallback(
    (path: string, model: monaco.editor.ITextModel, e: monaco.editor.IModelContentChangedEvent) => {
      if (!(path in liveText.current)) return;
      staleModels.current.set(path, model);
      markBusy(400);
      setEditedFiles((s) => (s.has(path) ? s : new Set(s).add(path)));
      if (!largeFiles.current.has(path)) lspRef.current?.didEdit(path, e.changes, () => liveText.current[path]);
      const saved = savedText.current[path];
      // Most edits change the length: no need to compare the whole text then.
      const isDirty = saved === undefined || model.getValueLength() !== saved.length || liveText.current[path] !== saved;
      if (isDirty) pinTab(`file:${path}`);
      setDirty((d) => {
        if (isDirty === d.has(path)) return d;
        const next = new Set(d);
        if (isDirty) next.add(path);
        else next.delete(path);
        return next;
      });
      window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => {
        const text = liveText.current[path];
        setActiveText(text);
        if (path.endsWith('.php') && text.length <= CODE_INSIGHT_LIMIT) {
          void symbols.updateText(path, text).then(() => {
            refreshUsageHints();
            bumpStructure();
          });
        }
        checkFile(path, text, 0);
      }, ANALYSIS_DELAY);
    },
    [checkFile, pinTab],
  );

  /**
   * Edits several files as one refactoring (Rename). Open files change in their editor (undoable,
   * unsaved like any edit); the others are changed on disk. `edits`: 1-based line, UTF-16 columns.
   */
  const applyFileEdits = useCallback(
    async (byFile: Map<string, { line: number; column: number; endColumn: number; text: string }[]>) => {
      for (const [path, edits] of byFile) {
        const ranges = edits.map((e) => ({ range: new monaco.Range(e.line, e.column, e.line, e.endColumn), text: e.text }));
        if (path in liveText.current) {
          const uri = monaco.Uri.file(path);
          // A tab whose editor hasn't been shown yet has no model: make it from the editor's text.
          const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(liveText.current[path], languageOf(path), uri);
          model.pushStackElement();
          model.pushEditOperations([], ranges, () => null);
          model.pushStackElement();
          const text = model.getValue();
          onEdit(path, text);
          if (path.endsWith('.php')) void symbols.updateText(path, text);
          checkFile(path, text, 0);
          continue;
        }
        const text = await backend.readFile(path);
        const lines = text.split('\n');
        // Right to left on each line, so earlier columns stay valid.
        for (const e of [...edits].sort((a, b) => b.line - a.line || b.column - a.column)) {
          const l = lines[e.line - 1];
          if (l === undefined) continue;
          lines[e.line - 1] = l.slice(0, e.column - 1) + e.text + l.slice(e.endColumn - 1);
        }
        await backend.writeFile(path, lines.join('\n'));
        if (path.endsWith('.php') && symbols.rust) void symbols.update([path], []);
      }
      refreshUsageHints();
    },
    [backend, onEdit, checkFile],
  );

  useEffect(() => {
    setActiveText(activePath ? liveText.current[activePath] ?? '' : '');
  }, [activePath, loaded]);

  // Structure: exact from the index once it has the file's current text (the regex scan is the
  // fallback: browser sample, big files, files not indexed yet).
  const [indexStructure, setIndexStructure] = useState<{ path: string; symbols: PhpSymbol[] } | null>(null);
  const [structureTick, bumpStructure] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!activePath?.endsWith('.php') || !symbols.rust || activeText.length > CODE_INSIGHT_LIMIT) return;
    let live = true;
    void symbols.structure(activePath, activeText).then((found) => live && setIndexStructure(found ? { path: activePath, symbols: found } : null));
    return () => {
      live = false;
    };
    // activeText changes with the same pause that updates the index: structureTick follows that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, structureTick]);
  const structure = useMemo(() => {
    if (!activePath?.endsWith('.php') || activeText.length > CODE_INSIGHT_LIMIT) return [];
    if (indexStructure?.path === activePath) return indexStructure.symbols;
    return structureOf(activeText);
  }, [activePath, activeText, indexStructure]);

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    setBreakpoints((b) => {
      const lines = b[path] ?? [];
      return { ...b, [path]: lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line] };
    });
  }, []);

  // ── Indexing ──────────────────────────────────────────────────
  const [files, setFiles] = useState<string[]>([]);

  // File paths in terminal output open here (terminal/fileLinks.ts).
  useEffect(() => {
    const resolver = new FileResolver(backend.root, files);
    terminals.fileLinks = {
      resolve: (ref, cwd) => resolver.resolve(ref, cwd),
      open: (path, line, column) => void openFile(path, line ? { line, column } : undefined),
    };
  }, [backend, files, openFile]);
  // Laravel completion (route names, config keys, views…) reads the project's files.
  useEffect(() => {
    setLaravelProject({ root: backend.root, files, read: (path) => backend.readFile(path) });
  }, [backend, files]);
  useEffect(() => () => setLaravelProject(null), [backend]);
  // JS and TS projects inside this one (resources/js, a front end): loaded with the first .js/.ts file.
  useEffect(() => {
    if (files.length) setScriptContext({ backend, files, notify });
  }, [backend, files, notify]);
  useEffect(() => () => setScriptContext(null), [backend]);
  const [indexStats, setIndexStats] = useState<{ files: number; classes: number; ms: number } | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [indexVersion, bumpIndex] = useReducer((x: number) => x + 1, 0);

  const reindexRoutes = useCallback(
    (path: string, text: string) => {
      if (!/\/routes\/[^/]+\.php$/.test(path)) return;
      setRoutes((r) => [...r.filter((x) => x.path !== path), ...routesOf(path, text)]);
    },
    [],
  );

  // ── Git ───────────────────────────────────────────────────────
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitLoaded, setGitLoaded] = useState(false);
  /** Git commands for the Git tool window, branches popup, diffs and annotations. */
  const gitRepo = useMemo(() => new Git(backend), [backend]);
  const refreshGit = useCallback(async () => {
    gitRepo.clearHeads();
    setGit(await backend.gitInfo().catch(() => null));
    setGitLoaded(true);
  }, [backend, gitRepo]);

  /** Runs a Git action from the UI: refreshes the status after it, and reports failures. */
  const runGit = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
      setStatus(`${label}…`);
      try {
        await action();
        setStatus(`${label}: done`);
        return true;
      } catch (e) {
        notify({ title: `${label} failed`, body: String(e instanceof Error ? e.message : e), tone: 'error', action: { label: 'Show Git console', run: () => setGitLogRequest({ console: true, nonce: Date.now() }) } });
        setStatus('');
        return false;
      } finally {
        await refreshGit();
        setGitLogRequest((r) => ({ ...r, reload: Date.now() }));
      }
    },
    [refreshGit, notify],
  );

  const runGitRef = useRef(runGit);
  runGitRef.current = runGit;
  const gitRepoRef = useRef(gitRepo);
  gitRepoRef.current = gitRepo;

  /** What the Git tool window should show: a file's history, a commit, the console; `reload` after actions. */
  const [gitLogRequest, setGitLogRequest] = useState<{ path?: string; hash?: string; file?: string; console?: boolean; nonce?: number; reload?: number }>({});
  const showHistory = useCallback((path: string) => {
    setGitLogRequest({ path, nonce: Date.now() });
    showBottom('git');
  }, [showBottom]);
  /** A commit in the Git log; `file`: highlighted among its changed files (from an annotation). */
  const showCommit = useCallback((hash: string, file?: string) => {
    setGitLogRequest({ hash, file, nonce: Date.now() });
    showBottom('git');
  }, [showBottom]);

  /** Git dialogs (Push, New Branch, Stash…), opened from the branches popup, the Log and shortcuts. */
  const [gitDialog, setGitDialog] = useState<GitDialogRequest | null>(null);

  /** Files showing Git blame annotations in the gutter. */
  const [annotated, setAnnotated] = useState<Set<string>>(new Set());
  const toggleAnnotate = useCallback((path: string) => {
    setAnnotated((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openDiff = useCallback((path: string, commit?: string) => {
    const id = `diff:${commit ?? 'working'}:${path}`;
    setTabs((t) => (t.some((x) => x.id === id) ? t : [...t, { id, kind: 'diff', path, commit }]));
    setActiveId(id);
  }, []);

  const commit = useCallback(
    async (paths: string[], message: string, push: boolean, options: CommitOptions = {}) => {
      const summary = await backend.gitCommit(paths, message, push, options);
      notify({ title: push ? 'Committed and pushed' : 'Committed', body: summary, tone: 'success' });
      await refreshGit();
      return summary;
    },
    [backend, notify, refreshGit],
  );

  // ── Saving ────────────────────────────────────────────────────
  const save = useCallback(
    async (path: string) => {
      const text = liveText.current[path];
      if (text === undefined) return;
      try {
        await backend.writeFile(path, text);
      } catch (e) {
        notify({ title: `Could not save ${baseName(path)}`, body: String(e), tone: 'error' });
        return;
      }
      savedText.current[path] = text;
      invalidateLaravelFiles([path]);
      scriptFileChanged(path, text);
      lspRef.current?.didSave(path, text);
      setDirty((d) => {
        const next = new Set(d);
        next.delete(path);
        return next;
      });
      setStatus(`Saved ${baseName(path)}`);
      if (path.endsWith('.php')) {
        void symbols.updateText(path, text).then(() => {
          bumpIndex();
          refreshUsageHints();
        });
        reindexRoutes(path, text);
      }
      analyze(path, text).then(refreshProjectProblems);
      // Edited the Mago configuration: reload the project with it.
      if (path === `${backend.root}/mago.toml`) reanalyzeRef.current?.();
      refreshGit();
    },
    [backend, notify, refreshGit, reindexRoutes, refreshProjectProblems, analyze],
  );

  const saveActive = useCallback(() => {
    if (activePath) save(activePath);
  }, [activePath, save]);

  // ── Composer ──────────────────────────────────────────────────
  const [packages, setPackages] = useState<Package[]>([]);
  const [outdated, setOutdated] = useState<Record<string, string> | null>(null);
  const [composerBusy, setComposerBusy] = useState<string | null>(null);
  /** Whether the project root has a composer.json (the Composer actions need one). */
  const [hasComposer, setHasComposer] = useState(false);

  const checkOutdated = useCallback(async () => {
    setComposerBusy('Checking for updates…');
    try {
      const found = await backend.checkOutdated();
      setOutdated(found);
      const n = Object.keys(found).length;
      if (n) {
        notify({
          title: 'Composer updates available',
          body: `${n} ${n === 1 ? 'package' : 'packages'} can be updated.`,
          tone: 'warning',
          action: { label: 'Show packages', run: () => setRightTool('composer') },
        });
      }
    } catch (e) {
      notify({ title: 'Composer check failed', body: String(e), tone: 'error' });
    } finally {
      setComposerBusy(null);
    }
  }, [backend, notify, setRightTool]);

  const updatePackage = useCallback(
    async (name: string | null) => {
      setComposerBusy(name ? `Updating ${name}…` : 'Updating all packages…');
      try {
        await backend.updatePackage(name);
        setPackages(await backend.packages());
        setOutdated((o) => {
          if (!o) return o;
          if (name === null) return {};
          const { [name]: _, ...rest } = o;
          return rest;
        });
        notify({ title: 'Composer update finished', body: name ?? 'All packages', tone: 'success' });
      } catch (e) {
        notify({ title: 'Composer update failed', body: String(e), tone: 'error' });
      } finally {
        setComposerBusy(null);
      }
    },
    [backend, notify],
  );

  // ── Tests and terminal ────────────────────────────────────────
  // PHPUnit / Pest runs live in the test runner (tests/runner.ts); the Run window shows them.
  useEffect(() => {
    testRunner.setProject(backend);
    return () => testRunner.setProject(null);
  }, [backend]);
  /** Runs (or debugs) tests: a file, a test, the failed ones… The Run window opens. */
  const runTestScope = useCallback(
    (scope: Scope, opts?: { debug?: boolean }) => {
      showBottom('tests');
      void testRunner.start(scope, opts);
    },
    [showBottom],
  );
  /** The whole suite (toolbar ▶, Run ▸ Run Tests). */
  const runTests = useCallback(() => runTestScope({ kind: 'all' }), [runTestScope]);

  const [terminal, setTerminal] = useState<{ id: number; line: string; cwd: string; result?: RunResult }[]>([]);
  /** Folder commands run in; `cd` changes it (each command is its own process). */
  const [terminalCwd, setTerminalCwd] = useState(backend.root);
  const cwdRef = useRef(terminalCwd);
  cwdRef.current = terminalCwd;
  const runCommand = useCallback(
    async (line: string) => {
      const id = Date.now();
      const cwd = cwdRef.current;
      setTerminal((t) => [...t, { id, line, cwd }]);
      const cd = line.match(/^cd(?:\s+(.*))?$/i);
      if (cd) {
        // Built in: resolve the folder like a shell would, and keep it for the next commands.
        const arg = (cd[1] ?? '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
        let target = !arg || arg === '~' ? backend.root : /^([A-Za-z]:)?\//.test(arg) ? arg : `${cwd}/${arg}`;
        const parts: string[] = [];
        for (const seg of target.split('/')) {
          if (seg === '..') parts.length > 1 && parts.pop();
          else if (seg && seg !== '.') parts.push(seg);
        }
        target = (target.startsWith('/') ? '/' : '') + parts.join('/');
        let result: RunResult;
        try {
          await backend.listDir(target);
          setTerminalCwd(target);
          result = { code: 0, stdout: '', stderr: '' };
        } catch {
          result = { code: 1, stdout: '', stderr: `The folder "${arg}" does not exist.` };
        }
        setTerminal((t) => t.map((x) => (x.id === id ? { ...x, result } : x)));
        return;
      }
      const result = await backend.shell(line, cwd).catch((e): RunResult => ({ code: -1, stdout: '', stderr: String(e) }));
      setTerminal((t) => t.map((x) => (x.id === id ? { ...x, result } : x)));
    },
    [backend],
  );

  // ── Xdebug (mocked listener) ──────────────────────────────────
  // ── Debugger (Xdebug) ─────────────────────────────────────────
  const debugState = useDebug();
  const listening = debugState.listening;
  const setListening = useCallback((on: boolean) => void (on ? debug.startListening() : debug.stopListening()), []);
  const [phpVersion, setPhpVersion] = useState<string | null>(null);

  // ── Language server lifecycle ─────────────────────────────────
  const latestOpen = useRef(openFile);
  latestOpen.current = openFile;

  const startLanguageServer = useCallback(async () => {
    if (backend.kind !== 'disk' || !isTauri) return;
    await lspRef.current?.stop();
    lspRef.current = null;
    setActiveLsp(null);

    let spec: ServerSpec | null = null;
    for (const s of KNOWN_SERVERS) {
      const command = await invoke<string | null>('find_executable', { names: [s.executable] }).catch(() => null);
      if (command) {
        spec = { name: s.name, command, args: s.args };
        break;
      }
    }
    if (!spec) {
      // Optional: go to definition, find usages, completion and problems work without one (the
      // Rust index and Mago). The status bar says how to add one; no notification.
      setLspStatus({ state: 'missing' });
      return;
    }

    setLspStatus({ state: 'starting', name: spec.name });
    const client = new LspClient(spec, backend.root);
    client.on('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Diagnostic[] }) => {
      const path = uriToPath(p.uri);
      setOtherProblems((prev) => ({
        ...prev,
        [path]: p.diagnostics.map((d) => ({
          path,
          line: d.range.start.line + 1,
          message: d.source ? `${d.message} (${d.source})` : d.message,
          severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
        })),
      }));
    });
    client.on('window/showMessage', (p: { type: number; message: string }) => {
      notify({ title: spec!.name, body: p.message, tone: p.type === 1 ? 'error' : p.type === 2 ? 'warning' : 'info' });
    });
    // Server-initiated edits (e.g. from a code action command).
    client.on('$applyEdit', (edit: WorkspaceEdit) => applyEditNow(edit));
    client.on('$exit', () => {
      setLspStatus({ state: 'stopped', name: spec!.name });
      setActiveLsp(null);
      notify({
        title: `${spec!.name} stopped`,
        body: 'The language server exited. Code intelligence falls back to the built-in index.',
        tone: 'error',
        action: { label: 'Restart', run: () => startRef.current() },
      });
    });

    try {
      await client.start();
    } catch (e) {
      setLspStatus({ state: 'error', name: spec.name, message: String(e) });
      notify({ title: `${spec.name} failed to start`, body: String(e), tone: 'error' });
      return;
    }
    lspRef.current = client;
    setActiveLsp(client, {
      openAt: (path, line, column) => latestOpen.current(path, { line, column }),
      readText: (path) => (path in liveText.current ? Promise.resolve(liveText.current[path]) : backend.readFile(path)),
      writeText: async (path, text) => {
        await backend.writeFile(path, text);
        refreshGit();
      },
    });
    // Files opened before the server was ready.
    for (const [path, text] of Object.entries(liveText.current)) if (path.endsWith('.php')) client.didOpen(path, 'php', text);
    setLspStatus({ state: 'ready', name: spec.name });
    refreshUsageHints();
  }, [backend, notify, refreshGit]);

  const startRef = useRef(startLanguageServer);
  startRef.current = startLanguageServer;

  useEffect(() => {
    startLanguageServer();
    return () => {
      setActiveLsp(null);
      lspRef.current?.stop();
      lspRef.current = null;
    };
    // Once per opened project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  // ── File watcher: changes made outside PHPBlitz ───────────────
  const gitTimer = useRef<number>();
  const vendorTimer = useRef<number>();
  const problemsTimer = useRef<number>();

  const reloadFromDisk = useCallback((path: string, text: string) => {
    savedText.current[path] = text;
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model && model.getValue() !== text) {
      // A full-range edit (not setValue) keeps Ctrl+Z working across the reload.
      model.pushStackElement();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      model.pushStackElement();
    }
  }, []);

  /** Rollback: local changes go back to HEAD after a confirmation; open files are reloaded (unsaved edits too). */
  const rollbackFiles = useCallback(
    async (changes: { path: string; status: string }[]) => {
      if (!changes.length) return;
      const names = changes.length === 1 ? baseName(changes[0].path) : `${changes.length} files`;
      if (!(await confirmDialog(`Rollback ${names}? Local changes are lost.${changes.some((c) => c.status === 'A') ? ' Added files are unversioned again (kept on disk).' : ''}`))) return;
      const ok = await runGitRef.current('Rollback', () => gitRepoRef.current.rollback(changes));
      if (!ok) return;
      for (const c of changes) {
        if (!(c.path in liveText.current)) continue;
        const text = await backend.readFile(c.path).catch(() => null);
        if (text !== null) {
          reloadFromDisk(c.path, text);
          setDirty((d) => {
            const next = new Set(d);
            next.delete(c.path);
            return next;
          });
        }
      }
    },
    [backend, reloadFromDisk],
  );

  const handleFsChanges = useCallback(
    async (changes: { kind: 'file' | 'git' | 'vendor'; path: string; exists: boolean; isDir: boolean }[]) => {
      const files = changes.filter((c) => c.kind === 'file');
      invalidateLaravelFiles(files.map((c) => c.path));
      void scriptFilesChanged(files, (p) => backend.readFile(p));

      // Project tree and the file list used by Search Everywhere.
      const parents = new Set(files.map((c) => c.path.slice(0, c.path.lastIndexOf('/'))));
      parents.forEach((dir) => dir in childrenRef.current && loadDir(dir));
      setFiles((list) => {
        const set = new Set(list);
        let changed = false;
        for (const c of files) {
          const want = c.exists && !c.isDir;
          if (want !== set.has(c.path)) {
            changed = true;
            if (want) set.add(c.path);
            else set.delete(c.path);
          }
        }
        return changed ? [...set] : list;
      });

      const watched: { uri: string; type: 1 | 2 | 3 }[] = [];
      const magoChanged: string[] = [];
      const magoRemoved: string[] = [];
      const indexChanged_: string[] = [];
      const indexRemoved: string[] = [];
      let indexChanged = false;
      let reads = 0;
      for (const c of files) {
        if (c.isDir) continue;
        const path = c.path;
        const name = baseName(path);
        const open = path in liveText.current;
        if (!c.exists) {
          if (path === `${backend.root}/composer.json`) {
            setHasComposer(false);
            setOutdated(null);
          }
          if (path.endsWith('.php')) {
            if (symbols.rust) indexRemoved.push(path);
            else phpIndex.remove(path);
            setRoutes((r) => r.filter((x) => x.path !== path));
            magoRemoved.push(path);
            watched.push({ uri: pathToUri(path), type: 3 });
            indexChanged = true;
          }
          if (open) notify({ title: `${name} was deleted on disk`, body: 'The editor still has its text. Save to create the file again, or close the tab.', tone: 'warning' });
          continue;
        }
        const relevant = open || path.endsWith('.php') || ['composer.json', 'composer.lock', 'mago.toml'].includes(name);
        if (!relevant) continue;
        // The Rust index and Mago read changed PHP files themselves: no need to send their text here.
        if (symbols.rust && path.endsWith('.php') && !open && !/\/routes\/[^/]+\.php$/.test(path)) {
          indexChanged_.push(path);
          if (!dirMarks.isExcluded(path)) magoChanged.push(path);
          watched.push({ uri: pathToUri(path), type: 2 });
          indexChanged = true;
          continue;
        }
        // A checkout can change thousands of files: let the UI breathe between reads.
        if (++reads % 24 === 0) await lowPriority();
        let text: string;
        try {
          text = await backend.readFile(path);
        } catch {
          continue;
        }
        if (open) {
          if (text === savedText.current[path]) continue; // our own save
          if (dirtyRef.current.has(path)) {
            notify({
              title: `${name} changed on disk`,
              body: 'You also have unsaved changes in the editor. Keep yours, or load the version on disk.',
              tone: 'warning',
              action: { label: 'Load from disk', run: () => reloadFromDisk(path, text) },
            });
          } else {
            reloadFromDisk(path, text);
          }
          continue; // the editor's change handler updates the index, Mago and the language server
        }
        if (path.endsWith('.php')) {
          if (symbols.rust) indexChanged_.push(path);
          else phpIndex.update(path, text);
          reindexRoutes(path, text);
          if (!dirMarks.isExcluded(path)) magoChanged.push(path);
          watched.push({ uri: pathToUri(path), type: 2 });
          indexChanged = true;
        }
        if (name === 'mago.toml' && path === `${backend.root}/mago.toml`) reanalyzeRef.current?.();
        if (path === `${backend.root}/composer.json`) setHasComposer(true);
        if (name === 'composer.json' || name === 'composer.lock') backend.packages().then(setPackages).catch(() => {});
      }
      if (watched.length) lspRef.current?.notify('workspace/didChangeWatchedFiles', { changes: watched });
      if (magoAvailable && (magoChanged.length || magoRemoved.length)) {
        magoSync(magoChanged, magoRemoved)
          .then(() => {
            window.clearTimeout(problemsTimer.current);
            problemsTimer.current = window.setTimeout(refreshProjectProblems, 500);
          })
          .catch(() => {});
      }
      if (indexChanged_.length || indexRemoved.length) void symbols.update(indexChanged_, indexRemoved).then(() => refreshUsageHints());
      if (indexChanged) {
        bumpIndex();
        refreshUsageHints();
      }

      // Git status: after file changes or a checkout/commit made elsewhere.
      if (files.length || changes.some((c) => c.kind === 'git')) {
        window.clearTimeout(gitTimer.current);
        gitTimer.current = window.setTimeout(refreshGit, 400);
      }
      // `composer install/update` rewrote vendor: the analyzer needs the new types.
      if (changes.some((c) => c.kind === 'vendor')) {
        window.clearTimeout(vendorTimer.current);
        vendorTimer.current = window.setTimeout(() => reanalyzeRef.current?.(), 3000);
      }
    },
    [backend, loadDir, notify, reloadFromDisk, reindexRoutes, refreshGit, refreshProjectProblems],
  );

  // Mark Directory As: the project's marks, with defaults from composer.json's autoload sections.
  useEffect(() => {
    let live = true;
    dirMarks.open(backend.root, null);
    backend
      .readFile(`${backend.root}/composer.json`)
      .then((text) => live && dirMarks.open(backend.root, text))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [backend]);

  // The project's data sources (Database tool window); connections close with the project.
  useEffect(() => {
    db.open(backend.root, backend.kind !== 'disk');
    return () => db.closeAll();
  }, [backend]);

  const fsHandler = useRef(handleFsChanges);
  fsHandler.current = handleFsChanges;
  useEffect(() => {
    if (backend.kind !== 'disk' || !isTauri) return;
    let unlisten: (() => void) | undefined;
    let stopped = false;
    listen<Parameters<typeof handleFsChanges>[0]>('fs-changed', (e) => fsHandler.current(e.payload)).then((u) => {
      if (stopped) u();
      else unlisten = u;
    });
    perf
      .time('File watcher', invoke<{ watched: number; polled: number; limit: number | null; reason: string | null }>('watch_start', { root: backend.root }), (s) =>
        `${s.watched.toLocaleString()} folders watched` + (s.polled ? `, ${s.polled.toLocaleString()} polled` : '') + (s.limit !== null ? ` (limit ${s.limit.toLocaleString()})` : ''),
      )
      .then((s) => {
        if (!s.polled) return;
        // Linux: the inotify limit was reached. Those folders are polled (changes show within seconds).
        const command = 'echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/60-phpblitz.conf && sudo sysctl --system';
        const inotify = s.limit !== null;
        notify({
          title: 'External file changes sync may be slow',
          body:
            `${s.polled.toLocaleString()} ${s.polled === 1 ? 'folder is' : 'folders are'} checked every few seconds instead of watched` +
            (inotify ? `: the system's file watch limit (${s.limit!.toLocaleString()}) is too low for this project. To raise it, run:\n${command}\nthen reopen the project.` : ` (${s.reason ?? 'the file watcher is unavailable'}).`),
          tone: 'warning',
          action: inotify ? { label: 'Copy command', run: () => void navigator.clipboard.writeText(command) } : undefined,
        });
      })
      .catch((e) =>
      notify({ title: 'File watching is off', body: `Changes made outside PHPBlitz won't show until you reopen the project. ${e}`, tone: 'warning' }),
    );
    return () => {
      stopped = true;
      unlisten?.();
      invoke('watch_stop').catch(() => {});
      // Shells started for this project end with it.
      terminals.closeAll();
    };
    // Once per opened project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  // ── File operations (Project tree) ────────────────────────────
  const inside = (p: string, root: string) => p === root || p.startsWith(root + '/');

  /** Open editors follow a renamed/moved file or folder, unsaved changes included. */
  const transferOpenFiles = useCallback(
    (from: string, to: string) => {
      const map = (p: string) => to + p.slice(from.length);
      const paths = Object.keys(liveText.current).filter((p) => inside(p, from));
      for (const p of paths) {
        const np = map(p);
        savedText.current[np] = savedText.current[p];
        liveText.current[np] = liveText.current[p];
        delete savedText.current[p];
        delete liveText.current[p];
        if (lspRef.current?.running) {
          lspRef.current.didClose(p);
          if (np.endsWith('.php')) lspRef.current.didOpen(np, 'php', liveText.current[np]);
        }
        const uri = monaco.Uri.file(p);
        window.setTimeout(() => monaco.editor.getModel(uri)?.dispose(), 0);
      }
      if (paths.length) {
        setLoaded((l) => {
          const next = { ...l };
          for (const p of paths) {
            delete next[p];
            next[map(p)] = liveText.current[map(p)];
          }
          return next;
        });
        setDirty((d) => new Set([...d].map((p) => (inside(p, from) ? map(p) : p))));
        setMagoProblems((m) => Object.fromEntries(Object.entries(m).filter(([p]) => !inside(p, from))));
        for (const p of paths) checkFile(map(p), liveText.current[map(p)]);
      }
      const nextTabs = tabsRef.current.map((t) => (t.kind === 'file' && inside(t.path, from) ? { ...t, id: `file:${map(t.path)}`, path: map(t.path) } : t));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId((id) => (id?.startsWith('file:') && inside(id.slice(5), from) ? `file:${map(id.slice(5))}` : id));
      setFiles((list) => list.map((p) => (inside(p, from) ? map(p) : p)));
      setExpanded((e) => new Set([...e].map((p) => (inside(p, from) ? map(p) : p))));
    },
    [checkFile],
  );

  /** Keeps the class index in step when files move without the watcher (sample project). */
  const reindexMoved = useCallback(
    async (from: string, to: string | null) => {
      for (const p of phpIndex.all().map((c) => c.path).filter((p) => inside(p, from))) phpIndex.remove(p);
      setRoutes((r) => r.filter((x) => !inside(x.path, from)));
      if (to) {
        for (const f of await backend.listFiles()) {
          if (inside(f, to) && f.endsWith('.php')) {
            const text = await backend.readFile(f).catch(() => '');
            phpIndex.update(f, text);
            reindexRoutes(f, text);
          }
        }
      }
      bumpIndex();
      refreshUsageHints();
    },
    [backend, reindexRoutes],
  );

  const afterTreeChange = useCallback(
    (dirs: string[]) => {
      new Set(dirs).forEach((d) => loadDir(d));
      refreshGit();
      if (backend.kind === 'sample') backend.listFiles().then(setFiles);
    },
    [backend, loadDir, refreshGit],
  );

  /**
   * Renames a file or folder. For a PHP file whose class has the same name, `renameClass`
   * first renames the class through the language server, so its usages are updated too.
   */
  const renameItem = useCallback(
    async (path: string, newName: string, renameClass?: { from: string; to: string }) => {
      const parent = path.slice(0, path.lastIndexOf('/'));
      const to = `${parent}/${newName}`;
      let classNote = '';
      // The class and its usages: from the symbol index (fast), else the language server.
      if (renameClass && symbols.rust && !lspRef.current?.running) {
        const text = liveText.current[path] ?? (await backend.readFile(path));
        const ns = text.match(/^\s*namespace\s+([\w\\]+)\s*;/m)?.[1];
        const context = { backend, liveTextOf: (p: string) => liveText.current[p], dirty: dirtyRef.current };
        const plan = await planForTarget(context, { kind: 'class', name: ns ? `${ns}\\${renameClass.from}` : renameClass.from });
        if (plan.error) notify({ title: `Class ${renameClass.from} was not renamed`, body: plan.error, tone: 'warning' });
        else {
          await applyFileEdits(new Map([...renameEdits(plan, false)].map(([p, edits]) => [p, edits.map((e) => ({ ...e, text: renameClass.to }))])));
          classNote = ` and class ${renameClass.from} → ${renameClass.to} (${plan.usages.length} usages)`;
        }
      } else if (renameClass && lspRef.current?.running) {
        try {
          const text = liveText.current[path] ?? (await backend.readFile(path));
          const lines = text.split('\n');
          const re = new RegExp(String.raw`\b(class|interface|trait|enum)\s+(${renameClass.from})\b`);
          const line = lines.findIndex((l) => re.test(l));
          if (line >= 0) {
            const m = lines[line].match(re)!;
            const column = m.index! + m[0].length - m[2].length + 1; // where the class name starts
            await renameSymbol(path, line + 1, column, renameClass.to);
            classNote = ` and class ${renameClass.from} → ${renameClass.to}`;
          }
        } catch (e) {
          notify({ title: `Class ${renameClass.from} was not renamed`, body: `The file is renamed, but the language server could not rename the class: ${e}`, tone: 'warning' });
        }
      }
      await backend.renamePath(path, to);
      bookmarks.renamePath(path, to);
      transferOpenFiles(path, to);
      if (dirtyRef.current.has(path) || (to in liveText.current && liveText.current[to] !== savedText.current[to])) await save(to);
      if (backend.kind === 'sample') await reindexMoved(path, to);
      afterTreeChange([parent]);
      setStatus(`Renamed ${baseName(path)} → ${newName}${classNote}`);
      return to;
    },
    [backend, notify, transferOpenFiles, save, reindexMoved, afterTreeChange, applyFileEdits],
  );

  /** Deletes to the Recycle Bin; open editors for those files are closed. */
  const deleteItems = useCallback(
    async (paths: string[]) => {
      await backend.deletePaths(paths);
      const doomed = tabsRef.current.filter((t) => t.kind === 'file' && paths.some((p) => inside(t.path, p)));
      doomed.forEach((t) => t.kind === 'file' && releaseFile(t.path));
      if (doomed.length) {
        const rest = tabsRef.current.filter((t) => !doomed.includes(t));
        tabsRef.current = rest;
        setTabs(rest);
        setActiveId((id) => (rest.some((t) => t.id === id) ? id : rest[rest.length - 1]?.id ?? null));
      }
      setFiles((list) => list.filter((f) => !paths.some((p) => inside(f, p))));
      if (backend.kind === 'sample') for (const p of paths) await reindexMoved(p, null);
      afterTreeChange(paths.map((p) => p.slice(0, p.lastIndexOf('/'))));
      setStatus(backend.kind === 'disk' ? `Moved ${paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`} to the Recycle Bin` : 'Deleted');
    },
    [backend, releaseFile, reindexMoved, afterTreeChange],
  );

  /** Cut / Copy / Paste of files in the Project tree. */
  const [fileClipboard, setFileClipboard] = useState<{ mode: 'copy' | 'cut'; paths: string[] } | null>(null);

  const pasteInto = useCallback(
    async (dir: string) => {
      const clip = fileClipboard;
      if (!clip) return;
      const done: string[] = [];
      for (const src of clip.paths) {
        const name = baseName(src);
        const dot = name.lastIndexOf('.');
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
        if (clip.mode === 'cut' && src.slice(0, src.lastIndexOf('/')) === dir) continue; // moving onto itself
        // A free name: "User.php", then "User copy.php", "User copy 2.php"…
        for (let n = 0; n < 50; n++) {
          const target = `${dir}/${n === 0 ? name : `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`}`;
          try {
            if (clip.mode === 'copy') await backend.copyPath(src, target);
            else {
              await backend.renamePath(src, target);
              transferOpenFiles(src, target);
              if (backend.kind === 'sample') await reindexMoved(src, target);
            }
            done.push(target);
            break;
          } catch (e) {
            if (!String(e).includes('already exists')) {
              notify({ title: `Could not paste ${name}`, body: String(e), tone: 'error' });
              break;
            }
          }
        }
      }
      if (clip.mode === 'cut') setFileClipboard(null);
      if (backend.kind === 'sample' && clip.mode === 'copy') for (const t of done) await reindexMoved(t, t);
      afterTreeChange([dir, ...clip.paths.map((p) => p.slice(0, p.lastIndexOf('/')))]);
      return done;
    },
    [fileClipboard, backend, transferOpenFiles, reindexMoved, notify, afterTreeChange],
  );

  /** Re-reads a folder (or a file's folder and an open file) from disk. */
  const reloadItem = useCallback(
    async (path: string, isDir: boolean) => {
      if (isDir) {
        const dirs = Object.keys(childrenRef.current).filter((d) => inside(d, path));
        await Promise.all(dirs.map((d) => loadDir(d)));
      } else {
        await loadDir(path.slice(0, path.lastIndexOf('/')));
        if (path in liveText.current) {
          const text = await backend.readFile(path);
          if (dirtyRef.current.has(path)) {
            notify({ title: `${baseName(path)} has unsaved changes`, body: 'Reload anyway?', tone: 'warning', action: { label: 'Load from disk', run: () => reloadFromDisk(path, text) } });
          } else reloadFromDisk(path, text);
        }
      }
      refreshGit();
    },
    [backend, loadDir, notify, refreshGit, reloadFromDisk],
  );

  // ── Mago project analysis ─────────────────────────────────────
  /** `composer install` in the terminal; vendor/ appearing re-analyzes the project. */
  const composerInstall = useCallback(() => {
    showBottom('terminal');
    void terminals.run('composer install', backend.root);
  }, [backend, showBottom]);

  /**
   * After the declarations scan (phase 1): checks the open files right away, then analyzes the
   * whole project in the background (phase 2).
   */
  const analyzeProject = useCallback(
    async (scanned: MagoSummary) => {
      setMagoStatus({ state: 'analyzing', summary: scanned });
      for (const [path, text] of Object.entries(liveText.current)) checkFile(path, text);
      if (scanned.needsInstall) {
        notify({
          title: 'Install dependencies to turn on type checking',
          body: "composer.json lists packages, but vendor/ is missing, so framework and library classes are unknown and type checking would only report noise. Syntax errors and code style are still checked.",
          tone: 'warning',
          action: { label: 'Run composer install', run: composerInstall },
        });
      }
      try {
        const summary = await perf.time('Mago: whole-project analysis', magoAnalyze(), (s) =>
          s ? `${s.issues.toLocaleString()} errors and warnings` + (s.hidden ? `, ${s.hidden.toLocaleString()} held back (no vendor/)` : '') : 'replaced by a newer run',
        );
        if (!summary) return; // the project was reloaded meanwhile: that run reports instead
        setMagoStatus({ state: 'ready', summary });
        if (!summary.needsInstall) {
          const rules = summary.integrations.length ? ` · ${summary.integrations.join(', ')} rules` : '';
          notify({
            title: 'Mago analysis finished',
            body:
              `${summary.files.toLocaleString()} PHP files analyzed in ${(summary.millis / 1000).toFixed(1)} s · PHP ${summary.phpVersion}${rules}. ` +
              `${summary.issues.toLocaleString()} errors and warnings found.`,
            tone: 'success',
            action: summary.issues ? { label: 'Show problems', run: () => showBottom('problems') } : undefined,
          });
        }
        // Open files: now checked against the analyzed project (cross-file results).
        for (const [path, text] of Object.entries(liveText.current)) checkFile(path, text);
        refreshProjectProblems();
      } catch (e) {
        setMagoStatus({ state: 'error', message: String(e) });
        notify({ title: 'Mago could not analyze the project', body: String(e), tone: 'error' });
      }
    },
    [notify, checkFile, refreshProjectProblems, showBottom, composerInstall],
  );

  const openWithMago = useCallback(async () => {
    if (!magoAvailable || backend.kind !== 'disk') return;
    setMagoStatus((s) => ({ state: 'analyzing', summary: s.summary }));
    let scanned: MagoSummary;
    try {
      scanned = await perf.time('Mago: read files and declarations', magoOpen(backend.root, dirMarks.excludedFolders()), (s) => `${s.files.toLocaleString()} project files, PHP ${s.phpVersion}`);
    } catch (e) {
      setMagoStatus({ state: 'error', message: String(e) });
      notify({ title: 'Mago could not analyze the project', body: String(e), tone: 'error' });
      return;
    }
    await analyzeProject(scanned);
  }, [backend, notify, analyzeProject]);

  reanalyzeRef.current = openWithMago;

  // The debugger follows the project (interpreter → path mappings) and the editor's breakpoints.
  const interpretersVersion = useInterpreters();
  useEffect(() => {
    void debug.setProject(backend.root);
  }, [backend]);
  useEffect(() => {
    void debug.refreshInterpreter();
  }, [interpretersVersion]);
  useEffect(() => {
    debug.setBreakpoints(breakpoints);
  }, [breakpoints]);
  useEffect(() => {
    debug.onStop = (path, line) => {
      openFile(path, { line });
      showBottom('debug');
    };
    debug.onMessage = (title, body, tone) => notify({ title, body, tone });
  }, [openFile, notify, showBottom]);
  // Stop debugging (and listening) when the project closes.
  useEffect(() => () => {
    symbols.save();
    for (const s of debug.sessions) debug.closeSession(s.id);
    void debug.stopListening();
  }, [backend]);

  // Marking a folder Excluded (or un-excluding it) changes what Mago analyzes and what Go to File
  // lists: reload both.
  const excludedKey = useRef<string | null>(null);
  const excludeTimer = useRef<number>();
  const magoStatusRef = useRef(magoStatus.state);
  magoStatusRef.current = magoStatus.state;
  useEffect(() => {
    const check = () => {
      const key = dirMarks.excludedFolders().join('\n');
      const before = excludedKey.current;
      excludedKey.current = key;
      if (before !== null && before !== key) {
        void backend.listFiles().then(setFiles, () => {});
        if (magoStatusRef.current !== 'analyzing') {
          window.clearTimeout(excludeTimer.current);
          excludeTimer.current = window.setTimeout(() => reanalyzeRef.current?.(), 800);
        }
      }
    };
    check();
    const unsubscribe = dirMarks.subscribe(check);
    return () => {
      unsubscribe();
    };
  }, [backend]);

  // ── Mago actions (right-click ▸ Mago, Alt+Enter) ─────────────
  /** Applies a Mago fix to the open file, as one undoable edit. */
  const applyFix = useCallback((path: string, fix: NonNullable<Problem['fixes']>[number]) => {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return;
    model.pushStackElement();
    model.pushEditOperations(
      [],
      fix.edits.map((e) => ({ range: new monaco.Range(e.line, e.column, e.endLine, e.endColumn), text: e.text })),
      () => null,
    );
    model.pushStackElement();
  }, []);

  /** Adds `// @mago-expect category:code` above the problem's line, with the same indentation. */
  const suppressProblem = useCallback((path: string, p: Problem) => {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    const comment = suppressionComment(p);
    if (!model || !comment) return;
    const text = model.getLineContent(p.line);
    const indent = text.slice(0, text.length - text.trimStart().length);
    model.pushStackElement();
    model.pushEditOperations([], [{ range: new monaco.Range(p.line, 1, p.line, 1), text: `${indent}${comment}\n` }], () => null);
    model.pushStackElement();
  }, []);

  const afterConfigChange = useCallback(
    (summary: MagoSummary) => {
      loadDir(backend.root);
      void analyzeProject(summary);
    },
    [backend, analyzeProject, loadDir],
  );

  const openMagoConfig = useCallback(async () => {
    try {
      const path = await magoEnsureConfig();
      loadDir(backend.root);
      openFile(path);
    } catch (e) {
      notify({ title: 'Could not open mago.toml', body: String(e), tone: 'error' });
    }
  }, [backend, loadDir, openFile, notify]);

  /** Turns a rule off for the whole project in mago.toml. */
  const disableMagoRule = useCallback(
    async (p: Problem) => {
      if (!p.code || !p.category || p.category === 'syntax') return;
      setMagoStatus((s) => ({ ...s, state: 'analyzing' }));
      try {
        const summary = await magoDisableRule(p.category, p.code);
        // Reload an open mago.toml tab from disk so it shows the new entry.
        const configPath = `${backend.root}/mago.toml`;
        if (configPath in liveText.current && !dirty.has(configPath)) {
          const text = await backend.readFile(configPath);
          savedText.current[configPath] = text;
          monaco.editor.getModel(monaco.Uri.file(configPath))?.setValue(text);
        }
        afterConfigChange(summary);
        notify({
          title: `Disabled '${p.code}'`,
          body: `Turned off in mago.toml for the whole project (${p.category === 'lint' ? '[linter.rules]' : '[analyzer] ignore'}).`,
          tone: 'success',
          action: { label: 'Open mago.toml', run: openMagoConfig },
        });
      } catch (e) {
        setMagoStatus((s) => ({ ...s, state: 'ready' }));
        notify({ title: `Could not disable '${p.code}'`, body: String(e), tone: 'error' });
      }
    },
    [backend, dirty, afterConfigChange, notify, openMagoConfig],
  );

  useEffect(() => {
    openWithMago();
    return () => {
      magoClose();
    };
    // Once per opened project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  // ── Find usages ───────────────────────────────────────────────
  const [usages, setUsages] = useState<{ name: string; items: Usage[]; loading: boolean; error?: string } | null>(null);
  /**
   * Usages of what is at a position: from the language server when one runs, else the Rust index.
   * `vendor`: also search Composer packages (Project and Libraries).
   */
  const collectUsages = useCallback(
    async (model: monaco.editor.ITextModel, position: monaco.IPosition, vendor = false): Promise<UsageSearch> => {
      const word = model.getWordAtPosition(position)?.word ?? '';
      if (isScriptModel(model)) {
        const found = await scriptUsages(model, position);
        return { name: found.name || word, title: found.name || word, kind: '', container: '', items: found.usages, target: null };
      }
      if (lspRef.current?.running) {
        const found = await lspFindUsages(model, position);
        return { name: found?.name || word, title: found?.name || word, kind: '', container: '', items: found?.usages ?? [], target: null };
      }
      if (!symbols.rust) throw new Error('Find Usages needs the desktop app (or a language server).');
      const target = targetAt(model, position);
      if (!target) throw new Error('Put the caret on a class, method, property, constant or function.');
      // Unsaved editor texts are searched as they are.
      const overrides: Record<string, string> = {};
      for (const p of dirtyRef.current) if (liveText.current[p] !== undefined) overrides[p] = liveText.current[p];
      const found = await indexFindUsages(target, overrides, vendor);
      return { name: found.name, title: found.title, kind: found.kind, container: found.container, items: found.items, target };
    },
    [],
  );

  /** Find Usages (Alt+F7): results in the Find tool window. */
  const findUsagesAt = useCallback(
    async (model: monaco.editor.ITextModel, position: monaco.IPosition) => {
      const name = model.getWordAtPosition(position)?.word ?? '';
      setUsages({ name, items: [], loading: true });
      showBottom('usages');
      try {
        const found = await collectUsages(model, position);
        setUsages({ name: found.name, items: found.items, loading: false });
      } catch (e) {
        setUsages({ name, items: [], loading: false, error: String(e instanceof Error ? e.message : e) });
      }
    },
    [collectUsages, showBottom],
  );

  /** Show Usages (Ctrl+Alt+F7, a "N usages" lens): a popup at the code. One usage: jump there. */
  const [usagesPopup, setUsagesPopup] = useState<UsagesPopupState | null>(null);
  const showUsagesAt = useCallback(
    async (model: monaco.editor.ITextModel, position: monaco.IPosition, anchor: { x: number; y: number }) => {
      const name = model.getWordAtPosition(position)?.word ?? '';
      const request = { model, position, anchor };
      setUsagesPopup({ request, name, title: name, kind: '', container: '', items: [], loading: true, vendor: false });
      try {
        const found = await collectUsages(model, position);
        if (found.items.length === 1 && !found.items[0].dynamic) {
          setUsagesPopup(null);
          const u = found.items[0];
          openFile(u.path, { line: u.line, column: u.column });
          setStatus(`Only one usage of ${found.name}`);
          return;
        }
        setUsagesPopup({ request, ...found, loading: false, vendor: false });
      } catch (e) {
        setUsagesPopup({ request, name, title: name, kind: '', container: '', items: [], loading: false, vendor: false, error: String(e instanceof Error ? e.message : e) });
      }
    },
    [collectUsages, openFile],
  );
  /** The popup's scope: Project Files, or Project and Libraries (vendor). */
  const setUsagesScope = useCallback(
    async (vendor: boolean) => {
      const p = usagesPopup;
      if (!p) return;
      setUsagesPopup({ ...p, vendor, loading: true });
      try {
        const found = await collectUsages(p.request.model, p.request.position, vendor);
        setUsagesPopup((cur) => (cur && cur.request === p.request ? { ...cur, ...found, loading: false, vendor } : cur));
      } catch (e) {
        setUsagesPopup((cur) => (cur ? { ...cur, loading: false, error: String(e) } : cur));
      }
    },
    [usagesPopup, collectUsages],
  );
  /** The popup's results in the Find tool window. */
  const usagesToToolWindow = useCallback(() => {
    const p = usagesPopup;
    if (!p) return;
    setUsages({ name: p.name, items: p.items, loading: false });
    setUsagesPopup(null);
    showBottom('usages');
  }, [usagesPopup, showBottom]);

  // Go to Definition into another file (no language server): open it in a tab.
  useEffect(() => {
    setDefinitionOpener((path, line, column) => openFile(path, { line, column }));
    return () => setDefinitionOpener(null);
  }, [openFile]);

  // ── Startup ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    phpIndex.clear();
    resetHistory();
    bookmarks.open(backend.root);
    void perf.time('Project tree (top folder)', loadDir(backend.root));
    void perf.time('Git status', refreshGit());
    void perf.time('Composer packages', backend.packages(), (p) => `${p.length} packages`).then((p) => !cancelled && setPackages(p), () => {});
    setHasComposer(false);
    backend.readFile(`${backend.root}/composer.json`).then(
      () => !cancelled && setHasComposer(true),
      () => {},
    );
    perf.time('PHP version', backend.phpVersion(), (v) => v || 'PHP not found').then((v) => {
      if (cancelled) return;
      setPhpVersion(v);
      if (!v) {
        notify({
          title: 'PHP was not found',
          body: 'Install PHP and add it to PATH to get syntax checking and to run tests.',
          tone: 'warning',
        });
      }
    });

    (async () => {
      const started = performance.now();
      // Let the first files the user opens come first.
      await lowPriority();
      const all = await perf.time('File list', backend.listFiles().catch(() => [] as string[]), (l) => `${l.length.toLocaleString()} files`);
      if (cancelled) return;
      setFiles(all);
      if (isTauri && backend.kind === 'disk') {
        // Mago-parsed project + vendor, cached on disk: reopening only re-parses what changed.
        let stats;
        try {
          stats = await perf.time('Symbol index', symbols.open(backend.root, dirMarks.excludedFolders()), (s) =>
            s ? `${s.files.toLocaleString()} PHP files: ${s.parsed.toLocaleString()} parsed, ${(s.files - s.parsed).toLocaleString()} from the cache` : '',
          );
        } catch (e) {
          if (!cancelled) notify({ title: 'Indexing failed', body: String(e), tone: 'error' });
          return;
        }
        if (cancelled) return;
        // Laravel routes still come from the routes/ files (a few, small).
        const routeFiles = all.filter((f) => /\/routes\/[^/]+\.php$/.test(f));
        const texts = await Promise.all(routeFiles.map((p) => backend.readFile(p).catch(() => '')));
        if (cancelled) return;
        setRoutes(routeFiles.flatMap((p, i) => routesOf(p, texts[i])));
        setIndexStats({ files: all.length, classes: stats.classes, ms: stats.ms });
        bumpIndex();
        refreshUsageHints();
        const cached = stats.files - stats.parsed;
        notify({
          title: 'Indexing finished',
          body:
            `${stats.files.toLocaleString()} PHP files (vendor included), ${stats.classes.toLocaleString()} classes and ${stats.functions.toLocaleString()} functions indexed in ${(stats.ms / 1000).toFixed(1)} s` +
            (cached ? ` (${cached.toLocaleString()} from the cache).` : '.'),
          tone: 'success',
        });
        return;
      }
      symbols.useJs();
      const php = all.filter((f) => f.endsWith('.php') && !f.endsWith('.blade.php')).slice(0, MAX_INDEXED);
      const found: Route[] = [];
      for (let i = 0; i < php.length; i += INDEX_BATCH) {
        const batch = php.slice(i, i + INDEX_BATCH);
        // Low priority: only when the UI is idle and the user isn't opening files or typing.
        await lowPriority();
        if (cancelled) return;
        const texts = await Promise.all(batch.map((p) => backend.readFile(p).catch(() => '')));
        if (cancelled) return;
        batch.forEach((p, j) => {
          phpIndex.update(p, texts[j]);
          if (/\/routes\/[^/]+\.php$/.test(p)) found.push(...routesOf(p, texts[j]));
        });
      }
      const ms = Math.round(performance.now() - started);
      setRoutes(found);
      setIndexStats({ files: all.length, classes: phpIndex.size, ms });
      bumpIndex();
      refreshUsageHints();
      notify({
        title: 'Indexing finished',
        body: `${all.length.toLocaleString()} files and ${phpIndex.size.toLocaleString()} PHP classes indexed in ${(ms / 1000).toFixed(1)} s.`,
        tone: 'success',
      });
    })();

    if (backend.kind === 'sample') {
      const controller = `${backend.root}/app/Http/Controllers/UserController.php`;
      openFile(`${backend.root}/app/Models/User.php`);
      openFile(controller, { line: 22 });
      showTool('structure');
      showTool('notifications');
      notify({
        title: 'Xdebug 3.3 detected',
        body: 'PHP is configured for step debugging on port 9003.',
        tone: 'info',
        action: { label: 'Start listening', run: () => setListening(true) },
      });
      checkOutdated();
    }
    return () => {
      cancelled = true;
    };
    // Runs once per opened project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  return {
    backend,
    // tree
    children, expanded, toggleDir, loadDir, revealInTree, expandRecursively, collapseAll, pinTab,
    // files and index
    files, indexStats, indexVersion, routes,
    // tabs and editor
    isLargeFile: (path: string) => largeFiles.current.has(path),
    tabs, activeId, setActiveId, activeTab, activePath, loaded, dirty, openFile, openTable, openConsole, closeTab, closeTabs, moveTab,
    onEdit, onModelEdit, save, saveActive, goto, setGoto, breakpoints, toggleBreakpoint, structure, problems,
    // tool windows
    toolLayout, openTools, bottomSideTool, showTool, toggleTool, hideTool, isToolOpen, placeTool, resetToolLayout, toggleLeft, showLeft, setRightTool, toggleRight, bottomTab, bottomOpen, setBottomOpen, showBottom,
    searchOpen, setSearchOpen, searchTab, openSearch, recentFiles, forgetRecent, editedFiles, recentOpen, setRecentOpen,
    locationsOpen, setLocationsOpen, goToPlace, navigateBack, navigateForward, reopenClosedTab,
    settingsPage, openSettings: (page = 'terminal') => setSettingsPage(page), closeSettings: () => setSettingsPage(null),
    findInFiles, openFindInFiles, closeFindInFiles: () => setFindInFiles(null), findResults, setFindResults,
    savedTextOf: (path: string) => savedText.current[path], liveTextOf: (path: string) => liveText.current[path],
    // git
    git, gitLoaded, refreshGit, commit, gitRepo, runGit, rollbackFiles, gitLogRequest, showHistory, showCommit, annotated, toggleAnnotate, openDiff, gitDialog, setGitDialog,
    // composer
    packages, outdated, composerBusy, checkOutdated, updatePackage, hasComposer,
    // run
    runTests, runTestScope, terminal, runCommand, clearTerminal: () => setTerminal([]), terminalCwd,
    openTerminalAt: (dir: string) => {
      setTerminalCwd(dir);
      // Desktop: a new shell tab in that folder (Project tree ▸ Open In ▸ Terminal).
      if (isTauri && backend.kind === 'disk') terminals.create({ cwd: dir });
      showBottom('terminal');
    },
    renameItem, deleteItems, fileClipboard, setFileClipboard, pasteInto, reloadItem,
    // misc
    lspStatus, restartLanguageServer: startLanguageServer, usages, findUsagesAt, usagesPopup, showUsagesAt, closeUsagesPopup: () => setUsagesPopup(null), setUsagesScope, usagesToToolWindow,
    magoStatus, reanalyzeProject: openWithMago, projectProblems, projectProblemsTotal, projectProblemsHidden, refreshProjectProblems, composerInstall,
    applyFix, suppressProblem, disableMagoRule, openMagoConfig, applyFileEdits, prefetchFile, editorReady,
    notices, notify, dismissNotice, listening, setListening, phpVersion, status, setStatus,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;

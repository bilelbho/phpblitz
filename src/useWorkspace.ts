import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { Backend, Entry, GitInfo, Package, Problem, RunResult, TestResult } from './backend/types';
import { baseName } from './backend/types';
import { phpIndex, routesOf, structureOf, type Route } from './php';
import { aiReply, type AiMessage } from './mock';
import { refreshUsageHints } from './monaco';
import {
  magoAvailable,
  magoCheck,
  magoClose,
  magoDisableRule,
  magoEnsureConfig,
  magoOpen,
  magoProjectIssues,
  magoRemoveFile,
  suppressionComment,
  toProblem,
  type MagoSummary,
} from './mago';
import { confirmDialog, isTauri } from './platform';
import { invoke } from '@tauri-apps/api/core';
import { LspClient, pathToUri, uriToPath, type ServerSpec } from './lsp/client';
import { listen } from '@tauri-apps/api/event';
import type { SearchOptions, SearchResult } from './search';
import { applyEditNow, findUsages as lspFindUsages, renameSymbol, setActiveLsp, type Usage } from './lsp/monacoBridge';
import type { Diagnostic, WorkspaceEdit } from './lsp/protocol';

/** `preview`: PhpStorm's preview tab (italic), replaced by the next previewed file. */
export type Tab = { id: string; kind: 'file'; path: string; preview?: boolean } | { id: string; kind: 'table'; table: string };
/** Left tool windows. Structure docks in the bottom half, the others in the top half. */
export type LeftTool = 'project' | 'commit' | 'structure' | 'database';
type LeftTopTool = Exclude<LeftTool, 'structure'>;
export type RightTool = 'notifications' | 'ai' | 'endpoints' | 'composer';
export type BottomTab = 'problems' | 'terminal' | 'tests' | 'composer' | 'usages' | 'find';

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

  const loadDir = useCallback(
    async (path: string) => {
      try {
        const entries = await backend.listDir(path);
        setChildren((c) => ({ ...c, [path]: entries }));
      } catch (e) {
        notify({ title: 'Could not read folder', body: String(e), tone: 'error' });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend],
  );

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else {
          next.add(path);
          loadDir(path);
        }
        return next;
      });
    },
    [loadDir],
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
    setNotices((list) => [{ ...n, id }, ...list].slice(0, 30));
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices((list) => list.filter((n) => n.id !== id)), []);

  // ── Tool windows ──────────────────────────────────────────────
  const [leftTop, setLeftTop] = useState<LeftTopTool | null>('project');
  const [leftBottom, setLeftBottom] = useState<'structure' | null>(null);
  const [rightTool, setRightTool] = useState<RightTool | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('problems');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
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
  const toggleLeft = useCallback((t: LeftTool) => {
    if (t === 'structure') setLeftBottom((cur) => (cur ? null : 'structure'));
    else setLeftTop((cur) => (cur === t ? null : t));
  }, []);
  /** Opens a left tool window without toggling it closed when it is already open. */
  const showLeft = useCallback((t: LeftTool) => {
    if (t === 'structure') setLeftBottom('structure');
    else setLeftTop(t);
  }, []);
  const toggleRight = useCallback((t: RightTool) => setRightTool((cur) => (cur === t ? null : t)), []);
  const showBottom = useCallback((t: BottomTab) => {
    setBottomTab(t);
    setBottomOpen(true);
  }, []);

  // ── Editor tabs and documents ─────────────────────────────────
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const savedText = useRef<Record<string, string>>({});
  const liveText = useRef<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [activeText, setActiveText] = useState('');
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [goto, setGoto] = useState<GotoRequest | null>(null);
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  /** Problems from the language server or `php -l`; used when Mago is not available (browser). */
  const [otherProblems, setOtherProblems] = useState<Record<string, Problem[]>>({});
  /** Problems from Mago (lint + analysis) for open files. */
  const [magoProblems, setMagoProblems] = useState<Record<string, Problem[]>>({});
  const problems = magoAvailable ? magoProblems : otherProblems;
  const [status, setStatus] = useState('');

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const activePath = activeTab?.kind === 'file' ? activeTab.path : null;

  // ── Language server ───────────────────────────────────────────
  const lspRef = useRef<LspClient | null>(null);
  const [lspStatus, setLspStatus] = useState<LspStatus>({ state: 'off' });

  // ── Mago (lint + analysis, built into the Rust core) ──────────
  const [magoStatus, setMagoStatus] = useState<{ state: 'off' | 'analyzing' | 'ready' | 'error'; summary?: MagoSummary; message?: string }>({
    state: 'off',
  });
  const [projectProblems, setProjectProblems] = useState<Problem[] | null>(null);
  const checkSeq = useRef<Record<string, number>>({});
  /** Set once openWithMago exists (it is declared further down). */
  const reanalyzeRef = useRef<(() => void) | null>(null);

  /** Re-checks a file's current text. Responses for older text are dropped. */
  const checkFile = useCallback(
    async (path: string, text: string) => {
      if (!path.endsWith('.php')) return;
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

  const refreshProjectProblems = useCallback(async () => {
    if (!magoAvailable || backend.kind !== 'disk') return;
    const files = await magoProjectIssues().catch(() => []);
    setProjectProblems(files.flatMap((f) => f.diagnostics.map((d) => toProblem(f.path, d))));
  }, [backend]);
  const lint = checkFile;

  /** Forgets an editor document: model, texts, problems, language server sync. */
  const releaseFile = useCallback((path: string) => {
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
   * Opens a file in a tab. With `preview`, it reuses the preview tab (PhpStorm's
   * "Enable Preview Tab"): the next preview replaces it until it is edited or pinned.
   */
  const openFile = useCallback(
    async (path: string, at?: { line?: number; column?: number; find?: string }, opts?: { preview?: boolean }) => {
      const id = `file:${path}`;
      const current = tabsRef.current;
      const existing = current.find((x) => x.id === id);
      const old = !existing && opts?.preview ? current.find((x) => x.kind === 'file' && x.preview && !dirtyRef.current.has(x.path)) : undefined;
      let next: Tab[];
      if (existing) {
        // Opening a previewed file for real pins it.
        next = existing.kind === 'file' && existing.preview && !opts?.preview ? current.map((x) => (x.id === id ? { ...x, preview: false } : x)) : current;
      } else if (old) {
        next = current.map((x) => (x.id === old.id ? { id, kind: 'file', path, preview: true } : x));
      } else {
        next = [...current, { id, kind: 'file', path, preview: !!opts?.preview }];
      }
      tabsRef.current = next;
      setTabs(next);
      if (old?.kind === 'file') releaseFile(old.path);
      setActiveId(id);
      if (!(path in savedText.current)) {
        try {
          const text = await backend.readFile(path);
          savedText.current[path] = text;
          liveText.current[path] = text;
          setLoaded((l) => ({ ...l, [path]: text }));
          if (path.endsWith('.php') && lspRef.current?.running) lspRef.current.didOpen(path, 'php', text);
          lint(path, text);
        } catch (e) {
          setTabs((t) => t.filter((x) => x.id !== id));
          notify({ title: `Could not open ${baseName(path)}`, body: String(e), tone: 'error' });
          return;
        }
      }
      if (at) setGoto({ path, ...at, nonce: Date.now() });
    },
    [backend, lint, notify, releaseFile],
  );

  /** Turns a preview tab into a normal one (double-click on the tab, or editing it). */
  const pinTab = useCallback((id: string) => {
    setTabs((tabs) => (tabs.some((t) => t.id === id && t.kind === 'file' && t.preview) ? tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) : tabs));
  }, []);

  const openTable = useCallback((table: string) => {
    const id = `table:${table}`;
    setTabs((t) => (t.some((x) => x.id === id) ? t : [...t, { id, kind: 'table', table }]));
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
      if (tab.kind === 'file') releaseFile(tab.path);
      const rest = tabs.filter((t) => t.id !== id);
      setTabs(rest);
      if (activeId === id) setActiveId(rest[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]?.id ?? null);
    },
    [tabs, dirty, activeId, releaseFile],
  );

  // Debounced work after typing: structure, the class index and (sample) linting.
  const typingTimer = useRef<number>();
  const onEdit = useCallback(
    (path: string, text: string) => {
      liveText.current[path] = text;
      lspRef.current?.didChange(path, text);
      // Editing a previewed file keeps it open (PhpStorm pins the preview tab).
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
        if (path.endsWith('.php')) {
          phpIndex.update(path, text);
          refreshUsageHints();
        }
        checkFile(path, text);
      }, 300);
    },
    [backend, lint],
  );

  useEffect(() => {
    setActiveText(activePath ? liveText.current[activePath] ?? '' : '');
  }, [activePath, loaded]);

  const structure = useMemo(() => (activePath?.endsWith('.php') ? structureOf(activeText) : []), [activePath, activeText]);

  const toggleBreakpoint = useCallback((path: string, line: number) => {
    setBreakpoints((b) => {
      const lines = b[path] ?? [];
      return { ...b, [path]: lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line] };
    });
  }, []);

  // ── Indexing ──────────────────────────────────────────────────
  const [files, setFiles] = useState<string[]>([]);
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
  const refreshGit = useCallback(async () => {
    setGit(await backend.gitInfo().catch(() => null));
    setGitLoaded(true);
  }, [backend]);

  const commit = useCallback(
    async (paths: string[], message: string, push: boolean, amend = false) => {
      const summary = await backend.gitCommit(paths, message, push, amend);
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
      lspRef.current?.didSave(path, text);
      setDirty((d) => {
        const next = new Set(d);
        next.delete(path);
        return next;
      });
      setStatus(`Saved ${baseName(path)}`);
      if (path.endsWith('.php')) {
        phpIndex.update(path, text);
        bumpIndex();
        refreshUsageHints();
        reindexRoutes(path, text);
      }
      lint(path, text).then(refreshProjectProblems);
      // Edited the Mago configuration: reload the project with it.
      if (path === `${backend.root}/mago.toml`) reanalyzeRef.current?.();
      refreshGit();
    },
    [backend, lint, notify, refreshGit, reindexRoutes, refreshProjectProblems],
  );

  const saveActive = useCallback(() => {
    if (activePath) save(activePath);
  }, [activePath, save]);

  // ── Composer ──────────────────────────────────────────────────
  const [packages, setPackages] = useState<Package[]>([]);
  const [outdated, setOutdated] = useState<Record<string, string> | null>(null);
  const [composerBusy, setComposerBusy] = useState<string | null>(null);

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
  }, [backend, notify]);

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
  const [tests, setTests] = useState<{ running: boolean; result: TestResult | null }>({ running: false, result: null });
  const runTests = useCallback(async () => {
    showBottom('tests');
    setTests((t) => ({ ...t, running: true }));
    const result = await backend.runTests();
    setTests({ running: false, result });
  }, [backend, showBottom]);

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

  // ── AI assistant (mocked) ─────────────────────────────────────
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const askAi = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q) return;
      const file = activePath ? { name: baseName(activePath), content: liveText.current[activePath] ?? '' } : null;
      setAiMessages((m) => [...m, { who: 'you', text: q }, aiReply(q, file)]);
    },
    [activePath],
  );

  // ── Xdebug (mocked listener) ──────────────────────────────────
  const [listening, setListening] = useState(false);
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
      setLspStatus({ state: 'missing' });
      notify({
        title: 'No PHP language server found',
        body: 'Install one to get go to definition, find usages and rename: cargo install phpantom_lsp',
        tone: 'warning',
      });
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
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const gitTimer = useRef<number>();
  const vendorTimer = useRef<number>();

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

  const handleFsChanges = useCallback(
    async (changes: { kind: 'file' | 'git' | 'vendor'; path: string; exists: boolean; isDir: boolean }[]) => {
      const files = changes.filter((c) => c.kind === 'file');

      // Project tree and the file list used by Search Everywhere.
      const parents = new Set(files.map((c) => c.path.slice(0, c.path.lastIndexOf('/'))));
      parents.forEach((dir) => dir in childrenRef.current && loadDir(dir));
      setFiles((list) => {
        const set = new Set(list);
        files.forEach((c) => (c.exists && !c.isDir ? set.add(c.path) : set.delete(c.path)));
        return set.size === list.length && files.every((c) => c.exists === list.includes(c.path)) ? list : [...set];
      });

      const watched: { uri: string; type: 1 | 2 | 3 }[] = [];
      let indexChanged = false;
      for (const c of files) {
        if (c.isDir) continue;
        const path = c.path;
        const name = baseName(path);
        const open = path in liveText.current;
        if (!c.exists) {
          if (path.endsWith('.php')) {
            phpIndex.remove(path);
            setRoutes((r) => r.filter((x) => x.path !== path));
            if (magoAvailable) magoRemoveFile(path);
            watched.push({ uri: pathToUri(path), type: 3 });
            indexChanged = true;
          }
          if (open) notify({ title: `${name} was deleted on disk`, body: 'The editor still has its text. Save to create the file again, or close the tab.', tone: 'warning' });
          continue;
        }
        const relevant = open || path.endsWith('.php') || ['composer.json', 'composer.lock', 'mago.toml'].includes(name);
        if (!relevant) continue;
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
          phpIndex.update(path, text);
          reindexRoutes(path, text);
          if (magoAvailable) magoCheck(path, text).catch(() => {});
          watched.push({ uri: pathToUri(path), type: 2 });
          indexChanged = true;
        }
        if (name === 'mago.toml' && path === `${backend.root}/mago.toml`) reanalyzeRef.current?.();
        if (name === 'composer.json' || name === 'composer.lock') backend.packages().then(setPackages).catch(() => {});
      }
      if (watched.length) lspRef.current?.notify('workspace/didChangeWatchedFiles', { changes: watched });
      if (indexChanged) {
        bumpIndex();
        refreshUsageHints();
        window.setTimeout(refreshProjectProblems, 300);
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
    invoke('watch_start', { root: backend.root }).catch((e) =>
      notify({ title: 'File watching is off', body: `Changes made outside PHPBlitz won't show until you reopen the project. ${e}`, tone: 'warning' }),
    );
    return () => {
      stopped = true;
      unlisten?.();
      invoke('watch_stop').catch(() => {});
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
      if (renameClass && lspRef.current?.running) {
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
      transferOpenFiles(path, to);
      if (dirtyRef.current.has(path) || (to in liveText.current && liveText.current[to] !== savedText.current[to])) await save(to);
      if (backend.kind === 'sample') await reindexMoved(path, to);
      afterTreeChange([parent]);
      setStatus(`Renamed ${baseName(path)} → ${newName}${classNote}`);
      return to;
    },
    [backend, notify, transferOpenFiles, save, reindexMoved, afterTreeChange],
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
  const openWithMago = useCallback(async () => {
    if (!magoAvailable || backend.kind !== 'disk') return;
    setMagoStatus({ state: 'analyzing' });
    try {
      const summary = await magoOpen(backend.root);
      setMagoStatus({ state: 'ready', summary });
      const rules = summary.integrations.length ? ` · ${summary.integrations.join(', ')} rules` : '';
      notify({
        title: 'Mago analysis finished',
        body:
          `${summary.files.toLocaleString()} PHP files analyzed in ${(summary.millis / 1000).toFixed(1)} s · PHP ${summary.phpVersion}${rules}. ` +
          `${summary.issues.toLocaleString()} problems found.` +
          (summary.vendor ? '' : ' Run composer install so framework classes are known.'),
        tone: summary.vendor ? 'success' : 'warning',
        action: summary.issues ? { label: 'Show problems', run: () => showBottom('problems') } : undefined,
      });
      // Files opened while the project was loading: check them against the full project.
      for (const [path, text] of Object.entries(liveText.current)) checkFile(path, text);
      refreshProjectProblems();
    } catch (e) {
      setMagoStatus({ state: 'error', message: String(e) });
      notify({ title: 'Mago could not analyze the project', body: String(e), tone: 'error' });
    }
  }, [backend, notify, checkFile, refreshProjectProblems]);

  reanalyzeRef.current = openWithMago;

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
      setMagoStatus({ state: 'ready', summary });
      for (const [path, text] of Object.entries(liveText.current)) checkFile(path, text);
      refreshProjectProblems();
      loadDir(backend.root);
    },
    [backend, checkFile, refreshProjectProblems, loadDir],
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
  const findUsagesAt = useCallback(
    async (model: monaco.editor.ITextModel, position: monaco.IPosition) => {
      const name = model.getWordAtPosition(position)?.word ?? '';
      if (!lspRef.current?.running) {
        notify({ title: 'Find Usages needs a language server', body: 'Install PHPantom: cargo install phpantom_lsp', tone: 'warning' });
        return;
      }
      setUsages({ name, items: [], loading: true });
      showBottom('usages');
      try {
        const found = await lspFindUsages(model, position);
        setUsages({ name: found?.name || name, items: found?.usages ?? [], loading: false });
      } catch (e) {
        setUsages({ name, items: [], loading: false, error: String(e) });
      }
    },
    [notify, showBottom],
  );

  // ── Startup ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    phpIndex.clear();
    loadDir(backend.root);
    refreshGit();
    backend.packages().then((p) => !cancelled && setPackages(p));
    backend.phpVersion().then((v) => {
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
      const all = await backend.listFiles().catch(() => [] as string[]);
      if (cancelled) return;
      setFiles(all);
      const php = all.filter((f) => f.endsWith('.php') && !f.endsWith('.blade.php')).slice(0, MAX_INDEXED);
      const found: Route[] = [];
      for (let i = 0; i < php.length; i += INDEX_BATCH) {
        const batch = php.slice(i, i + INDEX_BATCH);
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
      setLeftBottom('structure');
      setRightTool('notifications');
      notify({
        title: 'Xdebug 3.3 detected',
        body: 'PHP is configured for step debugging on port 9003.',
        tone: 'info',
        action: { label: 'Start listening', run: () => setListening(true) },
      });
      checkOutdated();
      setAiMessages([
        { who: 'you', text: 'Why is line 22 in UserController marked as an error?' },
        {
          who: 'assistant',
          text: 'Line 22 ends with $user-> and nothing after it, so PHP expects a method or property name. Type after the arrow to see what User offers. orders() returns HasMany:',
          code: '$orders = $user->orders()->latest()->get();',
        },
      ]);
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
    tabs, activeId, setActiveId, activeTab, activePath, loaded, dirty, openFile, openTable, closeTab,
    onEdit, save, saveActive, cursor, setCursor, goto, setGoto, breakpoints, toggleBreakpoint, structure, problems,
    // tool windows
    leftTop, leftBottom, toggleLeft, showLeft, rightTool, setRightTool, toggleRight, bottomTab, bottomOpen, setBottomOpen, showBottom,
    searchOpen, setSearchOpen, searchTab, openSearch,
    findInFiles, openFindInFiles, closeFindInFiles: () => setFindInFiles(null), findResults, setFindResults,
    savedTextOf: (path: string) => savedText.current[path], liveTextOf: (path: string) => liveText.current[path],
    // git
    git, gitLoaded, refreshGit, commit,
    // composer
    packages, outdated, composerBusy, checkOutdated, updatePackage,
    // run
    tests, runTests, terminal, runCommand, clearTerminal: () => setTerminal([]), terminalCwd,
    openTerminalAt: (dir: string) => {
      setTerminalCwd(dir);
      setBottomTab('terminal');
      setBottomOpen(true);
    },
    renameItem, deleteItems, fileClipboard, setFileClipboard, pasteInto, reloadItem,
    // misc
    lspStatus, restartLanguageServer: startLanguageServer, usages, findUsagesAt,
    magoStatus, reanalyzeProject: openWithMago, projectProblems, refreshProjectProblems,
    applyFix, suppressProblem, disableMagoRule, openMagoConfig,
    notices, notify, dismissNotice, aiMessages, askAi, listening, setListening, phpVersion, status, setStatus,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;

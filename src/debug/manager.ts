// Step debugging with Xdebug: listen for connections (the phone icon), or debug a
// script through the project's PHP interpreter. Each connection is a session with its status,
// stack, variables, watches and output. Breakpoints come from the editor and are kept in sync.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../platform';
import { getSettings } from '../settings';
import { debugMappings, interpretersFor, mapPath, projectPhp, runPhp, type Interpreter, type PathMapping } from '../interpreters';
import { DbgpConnection, pathToUri, uriToPath, type Continuation, type Property, type StackFrame, type Status } from './dbgp';
import { projectStorage } from '../projectStorage';

export type SessionStatus = Status | 'connecting';

export interface Watch {
  expression: string;
  result?: Property;
  error?: string;
}

export interface DebugSession {
  id: number;
  /** Script or request being debugged, for the tab title. */
  label: string;
  remote: string;
  status: SessionStatus;
  engine: string;
  /** Call stack while stopped (top first) and the selected frame. */
  frames: StackFrame[];
  frame: number;
  /** Variables of the selected frame (Locals), and the other contexts' names (Superglobals, Constants). */
  variables: Property[] | null;
  contexts: { id: number; name: string }[];
  /** Children loaded by expanding, by context and fullname. */
  expanded: Map<string, Property[]>;
  output: string;
  /** Why it stopped, when it wasn't a breakpoint: an exception or error. */
  exception?: string;
  /** Message to show (path mapping problems, errors). */
  warning?: string;
  conn: DbgpConnection;
  /** Editor breakpoint key (path:line) → Xdebug breakpoint id. */
  breakpointIds: Map<string, string>;
}

const key = (path: string, line: number) => `${path}:${line}`;

class DebugManager {
  private listeners = new Set<() => void>();
  private version = 0;
  private unlisten: Promise<() => void> | null = null;

  listening = false;
  listenError = '';
  port = 9003;
  sessions: DebugSession[] = [];
  activeId: number | null = null;
  watches: Watch[] = [];
  /** Breakpoints muted: sessions run without them. */
  muted = false;

  private root = '';
  private interpreter: Interpreter | null = null;
  private mappings: PathMapping[] = [];
  private breakpoints: Record<string, number[]> = {};
  /** Label for the next connection (a script we launched). */
  private pendingLabel: string | null = null;

  /** Called when a session stops somewhere: open the file, show the Debug window. */
  onStop: (path: string, line: number) => void = () => {};
  onMessage: (title: string, body: string, tone: 'info' | 'warning' | 'error') => void = () => {};

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  get active(): DebugSession | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  /** Where the active session is stopped, in local terms (for the editor's execution line). */
  get position(): { path: string; line: number } | null {
    const s = this.active;
    const f = s?.status === 'break' ? s.frames[s.frame] : undefined;
    return f ? { path: this.toLocal(f.fileUri), line: f.line } : null;
  }

  // ── Project ──────────────────────────────────────────────────

  /** The open project: its interpreter gives the path mappings. */
  async setProject(root: string) {
    this.root = root;
    try {
      this.watches = JSON.parse(projectStorage.getItem(`phpblitz.watches:${root}`) ?? '[]').map((expression: string) => ({ expression }));
    } catch {
      this.watches = [];
    }
    await this.refreshInterpreter();
  }

  async refreshInterpreter() {
    const php = projectPhp(this.root);
    this.interpreter = interpretersFor(this.root).find((i) => i.id === php.interpreterId) ?? null;
    this.mappings = await debugMappings(this.interpreter, this.root);
    this.changed();
  }

  toRemote(path: string) {
    return mapPath(path, this.mappings, true);
  }
  toLocal(uri: string) {
    return mapPath(uriToPath(uri), this.mappings, false);
  }

  // ── Listening ────────────────────────────────────────────────

  async startListening(): Promise<boolean> {
    if (this.listening) return true;
    if (!isTauri) {
      this.listenError = 'Debugging needs the desktop app.';
      this.changed();
      return false;
    }
    this.port = getSettings().debug.port;
    this.unlisten ??= listen<{ kind: 'connected' | 'message' | 'closed'; session: number; remote?: string; xml?: string }>('xdebug', (e) => this.event(e.payload));
    try {
      await invoke('xdebug_listen', { port: this.port });
      this.listening = true;
      this.listenError = '';
    } catch (e) {
      this.listenError = String(e);
      this.onMessage('Cannot listen for Xdebug', this.listenError, 'error');
    }
    this.changed();
    return this.listening;
  }

  async stopListening() {
    if (!this.listening) return;
    await invoke('xdebug_stop_listening').catch(() => {});
    this.listening = false;
    this.changed();
  }

  // ── Breakpoints ──────────────────────────────────────────────

  /** The editor's breakpoints changed: add / remove them in live sessions. */
  setBreakpoints(next: Record<string, number[]>) {
    this.breakpoints = next;
    for (const s of this.sessions) if (s.status === 'break' || s.status === 'running') void this.syncBreakpoints(s);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const s of this.sessions) if (s.status === 'break' || s.status === 'running') void this.syncBreakpoints(s);
    this.changed();
  }

  private async syncBreakpoints(s: DebugSession) {
    const want = new Set<string>();
    if (!this.muted) for (const [path, lines] of Object.entries(this.breakpoints)) for (const l of lines) want.add(key(path, l));
    for (const [k, id] of [...s.breakpointIds]) {
      if (!want.has(k)) {
        s.breakpointIds.delete(k);
        await s.conn.breakpointRemove(id);
      }
    }
    for (const k of want) {
      if (s.breakpointIds.has(k)) continue;
      const at = k.lastIndexOf(':');
      const path = k.slice(0, at);
      const line = Number(k.slice(at + 1));
      try {
        s.breakpointIds.set(k, await s.conn.breakpointSet(pathToUri(this.toRemote(path)), line));
      } catch {
        // A file PHP can't see (not mounted): nothing to stop on.
      }
    }
  }

  // ── Connections ──────────────────────────────────────────────

  private event(e: { kind: 'connected' | 'message' | 'closed'; session: number; remote?: string; xml?: string }) {
    if (e.kind === 'connected') return void this.connected(e.session, e.remote ?? '');
    const s = this.sessions.find((x) => x.id === e.session);
    if (!s) return;
    if (e.kind === 'message' && e.xml) s.conn.handle(e.xml);
    if (e.kind === 'closed') {
      s.conn.closed();
      s.status = 'stopped';
      s.frames = [];
      s.variables = null;
      this.changed();
    }
  }

  private async connected(id: number, remote: string) {
    const conn = new DbgpConnection((command) => invoke('xdebug_send', { session: id, command }));
    const s: DebugSession = {
      id,
      label: this.pendingLabel ?? 'PHP',
      remote,
      status: 'connecting',
      engine: '',
      frames: [],
      frame: 0,
      variables: null,
      contexts: [],
      expanded: new Map(),
      output: '',
      conn,
      breakpointIds: new Map(),
    };
    this.pendingLabel = null;
    conn.onStream = (_type, text) => {
      s.output += text;
      this.changed();
    };
    // Finished sessions are replaced by new ones, reusing the tab.
    this.sessions = [...this.sessions.filter((x) => x.status !== 'stopped'), s];
    this.activeId = id;
    this.changed();

    try {
      const init = await conn.waitInit();
      const file = init.attrs.fileuri ?? '';
      if (s.label === 'PHP') s.label = file ? uriToPath(file).split('/').pop()! : remote;
      s.engine = `${init.children.find((c) => c.name === 'engine')?.text ?? 'Xdebug'} ${init.children.find((c) => c.name === 'engine')?.attrs.version ?? ''}`.trim();
      if (file && this.mappings.length && this.toLocal(file) === uriToPath(file) && !uriToPath(file).startsWith(this.root)) {
        s.warning = `${uriToPath(file)} is not inside a mapped folder: breakpoints may not be hit. Check the interpreter's path mappings (Settings ▸ PHP).`;
      }
      const settings = getSettings().debug;
      await Promise.all([
        conn.featureSet('max_children', settings.maxChildren),
        conn.featureSet('max_depth', 1),
        conn.featureSet('max_data', 4096),
        conn.featureSet('show_hidden', 1),
        conn.featureSet('extended_properties', 1),
        conn.featureSet('resolved_breakpoints', 1),
        conn.featureSet('notify_ok', 1),
        conn.command('stdout', { c: 1 }).catch(() => null),
      ]);
      s.status = 'starting';
      await this.syncBreakpoints(s);
      if (settings.breakOnExceptions) await conn.exceptionBreakpoint('*').catch(() => null);
      if (settings.breakAtFirstLine) await this.continueWith(s, 'step_into');
      else await this.continueWith(s, 'run');
    } catch (e) {
      if (s.status !== 'stopped') this.onMessage('Debug session failed', String(e instanceof Error ? e.message : e), 'error');
    }
  }

  // ── Stepping ─────────────────────────────────────────────────

  private async continueWith(s: DebugSession, cmd: 'run' | 'step_into' | 'step_over' | 'step_out') {
    s.status = 'running';
    s.exception = undefined;
    s.expanded = new Map();
    this.changed();
    let r: Continuation;
    try {
      r = await s.conn.continuation(cmd);
    } catch {
      return; // the connection closed (script ended or was stopped)
    }
    s.status = r.status;
    if (r.status === 'break') {
      if (r.exception) s.exception = `${r.exception}${r.message ? `: ${r.message}` : ''}`;
      await this.loadStop(s);
    } else if (r.status === 'stopping') {
      // The script finished: let it end.
      await s.conn.continuation('stop').catch(() => null);
      void invoke('xdebug_close', { session: s.id }).catch(() => {});
    }
    this.changed();
  }

  private async loadStop(s: DebugSession) {
    s.frames = await s.conn.stack().catch(() => []);
    s.frame = 0;
    if (!s.contexts.length) s.contexts = await s.conn.contextNames(0).catch(() => []);
    await Promise.all([this.loadVariables(s), this.evaluateWatches(s)]);
    const top = s.frames[0];
    if (top && s.id === this.activeId) this.onStop(this.toLocal(top.fileUri), top.line);
  }

  private async loadVariables(s: DebugSession) {
    s.variables = await s.conn.contextGet(0, s.frame).catch(() => []);
    this.changed();
  }

  private act(cmd: 'run' | 'step_into' | 'step_over' | 'step_out') {
    const s = this.active;
    if (s?.status === 'break') void this.continueWith(s, cmd);
  }
  resume = () => this.act('run');
  stepOver = () => this.act('step_over');
  stepInto = () => this.act('step_into');
  stepOut = () => this.act('step_out');

  /** Run to Cursor: a one-time breakpoint there, then resume. */
  async runToCursor(path: string, line: number) {
    const s = this.active;
    if (s?.status !== 'break') return;
    await s.conn.breakpointSet(pathToUri(this.toRemote(path)), line, { temporary: true }).catch(() => null);
    void this.continueWith(s, 'run');
  }

  async stop() {
    const s = this.active;
    if (!s || s.status === 'stopped') return;
    s.status = 'stopping';
    this.changed();
    await Promise.race([s.conn.continuation('stop').catch(() => null), new Promise((r) => setTimeout(r, 1500))]);
    await invoke('xdebug_close', { session: s.id }).catch(() => {});
    s.status = 'stopped';
    s.frames = [];
    this.changed();
  }

  selectSession(id: number) {
    this.activeId = id;
    this.changed();
    const pos = this.position;
    if (pos) this.onStop(pos.path, pos.line);
  }

  closeSession(id: number) {
    const s = this.sessions.find((x) => x.id === id);
    if (s && s.status !== 'stopped') void invoke('xdebug_close', { session: id }).catch(() => {});
    this.sessions = this.sessions.filter((x) => x.id !== id);
    if (this.activeId === id) this.activeId = this.sessions[this.sessions.length - 1]?.id ?? null;
    this.changed();
  }

  async selectFrame(index: number) {
    const s = this.active;
    if (!s || s.status !== 'break' || !s.frames[index]) return;
    s.frame = index;
    s.expanded = new Map();
    this.changed();
    const f = s.frames[index];
    this.onStop(this.toLocal(f.fileUri), f.line);
    await this.loadVariables(s);
  }

  // ── Variables ────────────────────────────────────────────────

  /** Children of an array / object (and the next page with `page`). */
  async expand(p: Property, context = 0, page = 0): Promise<Property[]> {
    const s = this.active;
    if (!s || s.status !== 'break') return [];
    const k = `${context}:${p.fullname}`;
    const got = await s.conn.propertyGet(p.fullname, s.frame, context, page).catch(() => null);
    const children = [...(page ? s.expanded.get(k) ?? [] : []), ...(got?.children ?? [])];
    s.expanded.set(k, children);
    this.changed();
    return children;
  }

  /** Variables of another context (Superglobals, User defined constants). */
  async contextVariables(context: number): Promise<Property[]> {
    const s = this.active;
    if (!s || s.status !== 'break') return [];
    return s.conn.contextGet(context, s.frame).catch(() => []);
  }

  async evaluate(expression: string): Promise<{ result?: Property; error?: string }> {
    const s = this.active;
    if (!s || s.status !== 'break') return { error: 'Not stopped at a breakpoint' };
    try {
      const result = await s.conn.evaluate(expression);
      return result ? { result: { ...result, name: expression, fullname: result.fullname || expression } } : { error: 'No result' };
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e) };
    }
  }

  /** The value of a variable or expression under the mouse in the editor. */
  async hoverValue(expression: string): Promise<Property | null> {
    const s = this.active;
    if (!s || s.status !== 'break') return null;
    const r = await this.evaluate(expression);
    return r.result ?? null;
  }

  private async evaluateWatches(s: DebugSession) {
    for (const w of this.watches) {
      const r = await (async () => {
        try {
          const result = await s.conn.evaluate(w.expression);
          return { result: result ? { ...result, name: w.expression, fullname: result.fullname || w.expression } : undefined, error: result ? undefined : 'No result' };
        } catch (e) {
          return { result: undefined, error: String(e instanceof Error ? e.message : e) };
        }
      })();
      w.result = r.result;
      w.error = r.error;
    }
    this.changed();
  }

  addWatch(expression: string) {
    const e = expression.trim();
    if (!e || this.watches.some((w) => w.expression === e)) return;
    this.watches = [...this.watches, { expression: e }];
    this.saveWatches();
    const s = this.active;
    if (s?.status === 'break') void this.evaluateWatches(s);
    this.changed();
  }

  removeWatch(expression: string) {
    this.watches = this.watches.filter((w) => w.expression !== expression);
    this.saveWatches();
    this.changed();
  }

  private saveWatches() {
    try {
      projectStorage.setItem(`phpblitz.watches:${this.root}`, JSON.stringify(this.watches.map((w) => w.expression)));
    } catch {
      // Kept for this session only.
    }
  }

  // ── Launching ────────────────────────────────────────────────

  /**
   * Something else launches PHP with Xdebug (the test runner): listen, and name the session that
   * connects next. Returns the port, or null when listening failed.
   */
  async prepareLaunch(label: string): Promise<number | null> {
    if (!(await this.startListening())) return null;
    await this.refreshInterpreter();
    this.pendingLabel = label;
    return this.port;
  }

  /**
   * Debug a PHP script with the project's interpreter: starts listening, then runs it with Xdebug on.
   * Resolves with the script's exit; output also streams into the session.
   */
  async debugScript(path: string, args: string[] = []) {
    if (!(await this.startListening())) return;
    await this.refreshInterpreter();
    const i = this.interpreter ?? ({ id: 'path', name: 'php', kind: 'local', phpPath: 'php', debuggerExtension: '', options: [] } as Interpreter);
    const name = path.split('/').pop() ?? path;
    this.pendingLabel = name;
    const remote = this.toRemote(path);
    const started = Date.now();
    const sessionsBefore = this.sessions.map((s) => s.id);
    try {
      // Project files among the arguments (a test file for PHPUnit) are mapped too.
      const mapped = args.map((x) => (x.startsWith(this.root + '/') ? this.toRemote(x) : x));
      const r = await runPhp(i, this.root, [remote, ...mapped], { port: this.port });
      const connected = this.sessions.some((s) => !sessionsBefore.includes(s.id));
      if (!connected) {
        this.pendingLabel = null;
        const out = `${r.stdout}${r.stderr}`.trim();
        const hint =
          i.kind === 'docker' || i.kind === 'compose'
            ? ' On Linux, the container may also need `extra_hosts: ["host.docker.internal:host-gateway"]`.'
            : '';
        this.onMessage(
          `${name} ran without the debugger`,
          `Xdebug didn't connect (${Math.round((Date.now() - started) / 100) / 10} s). Is Xdebug installed for this interpreter? See Settings ▸ PHP.${hint}${out ? `\n\n${out.slice(-600)}` : ''}`,
          'warning',
        );
      }
    } catch (e) {
      this.pendingLabel = null;
      this.onMessage(`Could not debug ${name}`, String(e instanceof Error ? e.message : e), 'error');
    }
  }
}

export const debug = new DebugManager();

if (import.meta.hot) import.meta.hot.dispose(() => location.reload());

/** Re-renders when anything about debugging changes. */
export function useDebug() {
  useSyncExternalStore(debug.subscribe, debug.getSnapshot);
  return debug;
}

// Terminal sessions: one xterm.js view + one shell in a pseudo-terminal (src-tauri/src/pty.rs).
//
// Sessions live outside React, so switching the bottom panel to Problems and back
// (which unmounts the view) keeps shells, scrollback and running programs.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { IMarker, ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useSyncExternalStore } from 'react';
import { getSettings, parseEnv, type TerminalSettings } from '../settings';

export interface ShellSpec {
  name: string;
  path: string;
  args: string[];
}

export interface Session {
  id: number;
  /** Tab name; `custom` once the user renamed it. */
  name: string;
  custom: boolean;
  /** Title set by the running program (OSC 0/2), if any. */
  title: string | null;
  shell: ShellSpec;
  cwd: string;
  ptyId: number | null;
  exited: boolean;
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  opened: boolean;
}

// JetBrains' dark terminal palette.
const THEME: ITheme = {
  background: '#1e1f22',
  foreground: '#bcbec4',
  cursor: '#ced0d6',
  cursorAccent: '#1e1f22',
  selectionBackground: '#214283',
  black: '#000000',
  red: '#f0524f',
  green: '#5c962c',
  yellow: '#a68a0d',
  blue: '#3993d4',
  magenta: '#a771bf',
  cyan: '#00a3a3',
  white: '#808080',
  brightBlack: '#595959',
  brightRed: '#ff4050',
  brightGreen: '#4fc414',
  brightYellow: '#e5bf00',
  brightBlue: '#1fb0ff',
  brightMagenta: '#ed7eed',
  brightCyan: '#00e5e5',
  brightWhite: '#ffffff',
};

function termOptions(t: TerminalSettings) {
  return {
    fontFamily: `'${t.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    cursorStyle: t.cursorShape,
    cursorBlink: t.cursorBlink,
  } as const;
}

function decode(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** A short beep for the terminal bell (no audio files needed). */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => ctx.close();
  } catch {
    // No audio device: stay silent.
  }
}

class TerminalManager {
  sessions: Session[] = [];
  activeId: number | null = null;
  /** Tabs being opened (waiting for the shell list), so the view doesn't open another. */
  creating = 0;
  private nextId = 1;
  private byPty = new Map<number, Session>();
  private listeners = new Set<() => void>();
  private snapshot = { sessions: this.sessions, activeId: this.activeId };
  private shellsPromise: Promise<ShellSpec[]> | null = null;
  private eventsReady: Promise<void> | null = null;
  /** The view element the active session is shown in. */
  private host: HTMLElement | null = null;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  private changed() {
    this.snapshot = { sessions: [...this.sessions], activeId: this.activeId };
    this.listeners.forEach((l) => l());
  }

  shells(): Promise<ShellSpec[]> {
    this.shellsPromise ??= invoke<ShellSpec[]>('terminal_shells').catch(() => []);
    return this.shellsPromise;
  }

  /** One listener pair for all sessions; output is routed by pty id. */
  private events() {
    this.eventsReady ??= Promise.all([
      listen<{ id: number; data: string }>('pty-output', (e) => this.byPty.get(e.payload.id)?.term.write(decode(e.payload.data))),
      listen<{ id: number; code: number | null }>('pty-exit', (e) => {
        const s = this.byPty.get(e.payload.id);
        if (s) this.onExit(s, e.payload.code);
      }),
    ]).then(() => undefined);
    return this.eventsReady;
  }

  private uniqueName(base: string) {
    const used = new Set(this.sessions.map((s) => s.name));
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(`${base} (${n})`)) return `${base} (${n})`;
  }

  /** Opens a new tab. Without `shell`, the shell from Settings (or the first one found). */
  async create(opts: { cwd: string; shell?: ShellSpec }): Promise<Session | null> {
    const settings = getSettings().terminal;
    this.creating++;
    const shells = await this.shells().finally(() => this.creating--);
    const configured = settings.shellPath ? shells.find((s) => s.path.toLowerCase() === settings.shellPath.toLowerCase()) ?? { name: settings.shellPath.split(/[\\/]/).pop()!, path: settings.shellPath, args: [] } : undefined;
    const shell = opts.shell ?? configured ?? shells[0];
    if (!shell) return null;
    const isDefault = !opts.shell || opts.shell.path === (configured ?? shells[0])?.path;
    const { Terminal, FitAddon, WebLinksAddon } = await import('./xterm');

    const term = new Terminal({
      ...termOptions(settings),
      theme: THEME,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      windowsPty: navigator.userAgent.includes('Windows') ? { backend: 'conpty' } : undefined,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (settings.highlightLinks) term.loadAddon(new WebLinksAddon((_e, uri) => invoke('open_external', { url: uri }).catch(() => {})));

    const element = document.createElement('div');
    element.className = 'term-surface';
    const session: Session = {
      id: this.nextId++,
      name: this.uniqueName(isDefault ? settings.defaultTabName || 'Local' : shell.name),
      custom: false,
      title: null,
      shell,
      cwd: opts.cwd,
      ptyId: null,
      exited: false,
      term,
      fit,
      element,
      opened: false,
    };
    this.wire(session);
    this.sessions.push(session);
    this.activeId = session.id;
    this.changed();

    await this.events();
    try {
      session.ptyId = await invoke<number>('pty_spawn', {
        shell: shell.path,
        args: shell.args,
        cwd: opts.cwd,
        cols: term.cols,
        rows: term.rows,
        env: parseEnv(settings.env),
      });
      this.byPty.set(session.ptyId, session);
      // The view may have sized the terminal before the shell existed.
      this.resizePty(session);
    } catch (e) {
      session.exited = true;
      term.write(`\x1b[31mCould not start ${shell.name}: ${e}\x1b[0m\r\n`);
      this.changed();
    }
    return session;
  }

  /**
   * Command blocks, like PhpStorm's terminal. The shell marks each prompt and the exit code of
   * the last command (OSC 133, set up in src-tauri/src/shell/): a line separates commands and a
   * red bar marks the output of one that failed.
   */
  private commandBlocks(term: Terminal) {
    let prompt: IMarker | null = null;
    const decorate = (marker: IMarker, height: number, className: string, title?: string) =>
      term.registerDecoration({ marker, x: 0, width: 1, height })?.onRender((el) => {
        el.classList.add(className);
        if (title) el.title = title;
      });
    term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(';');
      if (kind === 'A') {
        prompt = term.registerMarker(0) ?? null;
        if (prompt && prompt.line > 0) decorate(prompt, 1, 'term-sep');
      } else if (kind === 'D' && prompt && !prompt.isDisposed && arg !== undefined && arg !== '0') {
        const b = term.buffer.active;
        const end = b.baseY + b.cursorY + (b.cursorX ? 1 : 0);
        if (end > prompt.line) decorate(prompt, end - prompt.line, 'term-failed', `Exit code ${arg}`);
        prompt = null;
      }
      return true;
    });
  }

  private wire(s: Session) {
    const { term } = s;
    this.commandBlocks(term);
    term.onData((data) => {
      if (s.ptyId !== null && !s.exited) invoke('pty_write', { id: s.ptyId, data }).catch(() => {});
    });
    term.onTitleChange((title) => {
      // Shells set their own executable path as the title; only programs' titles are interesting.
      s.title = /\.exe$|^[A-Za-z]:\\|^\/(usr\/)?bin\//i.test(title) || title === s.shell.path ? null : title || null;
      this.changed();
    });
    term.onBell(() => getSettings().terminal.audibleBell && beep());
    term.onSelectionChange(() => {
      if (getSettings().terminal.copyOnSelect && term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    });
    // Ctrl+C copies when text is selected (otherwise it interrupts); Ctrl+Shift+C/V always copy/paste.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === 'c' && (e.shiftKey || term.hasSelection())) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (ctrl && e.shiftKey && key === 'v') {
        navigator.clipboard.readText().then((t) => term.paste(t)).catch(() => {});
        return false;
      }
      return true;
    });
    s.element.addEventListener('mousedown', (e) => {
      if (e.button === 1 && getSettings().terminal.pasteOnMiddleClick) {
        e.preventDefault();
        navigator.clipboard.readText().then((t) => term.paste(t)).catch(() => {});
      }
    });
  }

  private onExit(s: Session, code: number | null) {
    s.exited = true;
    if (s.ptyId !== null) this.byPty.delete(s.ptyId);
    if (getSettings().terminal.closeOnExit) {
      this.close(s.id);
      return;
    }
    s.term.write(`\r\n\x1b[90m[Process completed${code ? ` with exit code ${code}` : ''}. Close the tab or open a new one.]\x1b[0m\r\n`);
    this.changed();
  }

  /** Shows a session in the view's host element (the element itself survives detaching). */
  attach(s: Session, host: HTMLElement) {
    this.host = host;
    host.replaceChildren(s.element);
    if (!s.opened) {
      s.term.open(s.element);
      s.opened = true;
    }
    this.fit(s);
    s.term.focus();
  }

  detach(s: Session) {
    s.element.remove();
    if (this.host && !this.host.isConnected) this.host = null;
  }

  fit(s: Session) {
    if (!s.opened || !s.element.isConnected || !s.element.clientWidth) return;
    try {
      s.fit.fit();
    } catch {
      return;
    }
    this.resizePty(s);
  }

  private resizePty(s: Session) {
    if (s.ptyId !== null && !s.exited) invoke('pty_resize', { id: s.ptyId, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
  }

  setActive(id: number) {
    this.activeId = id;
    this.changed();
  }

  close(id: number) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = this.sessions[i];
    if (s.ptyId !== null) {
      invoke('pty_kill', { id: s.ptyId }).catch(() => {});
      this.byPty.delete(s.ptyId);
    }
    s.element.remove();
    s.term.dispose();
    this.sessions.splice(i, 1);
    if (this.activeId === id) this.activeId = (this.sessions[i] ?? this.sessions[i - 1])?.id ?? null;
    this.changed();
  }

  closeOthers(id: number) {
    this.sessions.filter((s) => s.id !== id).forEach((s) => this.close(s.id));
  }

  closeAll() {
    [...this.sessions].forEach((s) => this.close(s.id));
  }

  /** Drag and drop: moves the tab at `from` so it ends up at index `to`. */
  move(from: number, to: number) {
    if (from === to || from < 0 || from >= this.sessions.length) return;
    const [s] = this.sessions.splice(from, 1);
    this.sessions.splice(Math.max(0, Math.min(to, this.sessions.length)), 0, s);
    this.changed();
  }

  rename(id: number, name: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || !name.trim()) return;
    s.name = name.trim();
    s.custom = true;
    this.changed();
  }

  /** Types `command` into the active tab (a new one when there is none or it ended) and presses Enter. */
  async run(command: string, cwd: string) {
    let s = this.sessions.find((x) => x.id === this.activeId && !x.exited && x.ptyId !== null) ?? null;
    if (!s) s = await this.create({ cwd });
    if (!s || s.ptyId === null) return;
    this.setActive(s.id);
    const lines = command.replace(/\r\n/g, '\n').trim().split('\n').join('\r');
    await invoke('pty_write', { id: s.ptyId, data: lines + '\r' }).catch(() => {});
    s.term.focus();
  }

  /** Font, cursor… apply to open tabs right away; the shell applies to new tabs. */
  applySettings() {
    const opts = termOptions(getSettings().terminal);
    for (const s of this.sessions) {
      Object.assign(s.term.options, opts);
      this.fit(s);
    }
  }
}

export const terminals = new TerminalManager();

export function useTerminals() {
  return useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
}

/** The name shown on a tab: a program's title when allowed, else the session name. */
export function tabLabel(s: Session): string {
  return !s.custom && getSettings().terminal.useAppTitle && s.title ? s.title : s.name;
}

// Terminal sessions: one xterm.js view + one shell in a pseudo-terminal (src-tauri/src/pty.rs).
//
// Sessions live outside React, so switching the bottom panel to Problems and back
// (which unmounts the view) keeps shells, scrollback and running programs.

import { Channel, invoke } from '@tauri-apps/api/core';
import type { IMarker, ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import { useSyncExternalStore } from 'react';
import { getSettings, parseEnv, type TerminalSettings } from '../settings';
import { findFileRefs } from './fileLinks';

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
  search: SearchAddon;
  element: HTMLDivElement;
  opened: boolean;
  /** Each prompt (OSC 133 A) and where its command was typed (B), oldest first. */
  commands: { prompt: IMarker; input?: IMarker }[];
}

// The dark terminal palette.
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
  private listeners = new Set<() => void>();
  /** The session the find bar (Ctrl+F) searches, while it's open. */
  findId: number | null = null;
  /** Bumped by every Ctrl+F, so an open find bar selects its text again. */
  findRequests = 0;
  private snapshot = { sessions: this.sessions, activeId: this.activeId, findId: this.findId, findRequests: this.findRequests };
  private shellsPromise: Promise<ShellSpec[]> | null = null;
  /** The view element the active session is shown in. */
  private host: HTMLElement | null = null;
  /** File paths in output open in the editor; set by the workspace, which knows the project's files. */
  fileLinks: { resolve(ref: string, cwd: string): string | null; open(path: string, line?: number, column?: number): void } | null = null;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  private changed() {
    if (this.findId !== null && !this.sessions.some((s) => s.id === this.findId)) this.findId = null;
    this.snapshot = { sessions: [...this.sessions], activeId: this.activeId, findId: this.findId, findRequests: this.findRequests };
    this.listeners.forEach((l) => l());
  }

  /** Opens the find bar on a session (it takes the focus). */
  openFind(id: number) {
    this.findId = id;
    this.findRequests++;
    this.changed();
  }

  closeFind() {
    const s = this.sessions.find((x) => x.id === this.findId);
    s?.search.clearDecorations();
    this.findId = null;
    this.changed();
    s?.term.focus();
  }

  shells(): Promise<ShellSpec[]> {
    this.shellsPromise ??= invoke<ShellSpec[]>('terminal_shells').catch(() => []);
    return this.shellsPromise;
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
    const { Terminal, FitAddon, WebLinksAddon, SearchAddon } = await import('./xterm');

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
    const search = new SearchAddon();
    term.loadAddon(search);
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
      search,
      element,
      opened: false,
      commands: [],
    };
    this.wire(session);
    this.linkFiles(session);
    this.trackCommands(session);
    this.sessions.push(session);
    this.activeId = session.id;
    this.changed();

    try {
      // The shell's output: raw bytes, in frames, straight to xterm.js.
      // Then `{ code }` when the shell ends, after the last output.
      const output = new Channel<ArrayBuffer | { code: number | null }>();
      output.onmessage = (data) => (data instanceof ArrayBuffer ? term.write(new Uint8Array(data)) : this.onExit(session, data.code));
      session.ptyId = await invoke<number>('pty_spawn', {
        onOutput: output,
        shell: shell.path,
        args: shell.args,
        cwd: opts.cwd,
        cols: term.cols,
        rows: term.rows,
        env: parseEnv(settings.env),
      });
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
   * Command blocks. The shell marks each prompt and the exit code of
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

  /** Remembers the shell's prompts (OSC 133 A, B) for previous / next command and the last output. */
  private trackCommands(s: Session) {
    s.term.parser.registerOscHandler(133, (data) => {
      const kind = data.split(';')[0];
      if (kind === 'A') {
        const prompt = s.term.registerMarker(0);
        if (prompt) s.commands.push({ prompt });
        // Markers of lines that scrolled out of the buffer are disposed.
        s.commands = s.commands.filter((c) => !c.prompt.isDisposed);
      } else if (kind === 'B') {
        const last = s.commands[s.commands.length - 1];
        if (last && !last.input) last.input = s.term.registerMarker(0) ?? undefined;
      }
      // Not handled here only: the command blocks read these too.
      return false;
    });
  }

  /** Scrolls to the previous (-1) or next (1) prompt above / below the top of the view. */
  jumpToCommand(id: number, direction: -1 | 1): boolean {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return false;
    const top = s.term.buffer.active.viewportY;
    const lines = s.commands.map((c) => c.prompt.line).filter((l) => l >= 0);
    const target = direction < 0 ? [...lines].reverse().find((l) => l < top) : lines.find((l) => l > top);
    if (target === undefined) {
      if (direction > 0) s.term.scrollToBottom();
      return false;
    }
    s.term.scrollToLine(target);
    return true;
  }

  /** The output of the last command that finished: the lines between its command and the next prompt. */
  lastOutput(id: number): string | null {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    const done = s.commands.filter((c) => !c.prompt.isDisposed);
    // The last prompt is the one waiting for a command; the one before it ran the last command.
    const ran = done[done.length - 2];
    const next = done[done.length - 1];
    if (!ran?.input || !next) return null;
    const buffer = s.term.buffer.active;
    const lines: string[] = [];
    for (let y = ran.input.line + 1; y < next.prompt.line; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      // A wrapped line continues the one before it.
      if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  /** `app/Models/User.php:42` and the like in the output: click to open the file at that line. */
  private linkFiles(s: Session) {
    s.term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const links = this.fileLinks;
        if (!links) return callback(undefined);
        const text = s.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
        const found = findFileRefs(text).flatMap((ref) => {
          const path = links.resolve(ref.path, s.cwd);
          if (!path) return [];
          return [
            {
              range: { start: { x: ref.start + 1, y }, end: { x: ref.end, y } },
              text: text.slice(ref.start, ref.end),
              decorations: { underline: true, pointerCursor: true },
              activate: () => links.open(path, ref.line, ref.column),
            },
          ];
        });
        callback(found.length ? found : undefined);
      },
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
      if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        this.jumpToCommand(s.id, e.key === 'ArrowUp' ? -1 : 1);
        return false;
      }
      if (ctrl && !e.shiftKey && !e.altKey && key === 'f') {
        e.preventDefault();
        this.openFind(s.id);
        return false;
      }
      if (ctrl && e.shiftKey && key === 'v') {
        e.preventDefault();
        void readClipboard().then((t) => t && term.paste(t), () => {});
        return false;
      }
      return true;
    });
    s.element.addEventListener('mousedown', (e) => {
      if (e.button === 1 && getSettings().terminal.pasteOnMiddleClick) {
        e.preventDefault();
        void readClipboard().then((t) => t && term.paste(t), () => {});
      }
    });
  }

  private onExit(s: Session, code: number | null) {
    s.exited = true;
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

  /**
   * Opens a tab named `name` and runs a program in its shell (the shell stays when it ends).
   * `command` gets the shell, since PowerShell, cmd and bash quote paths differently.
   */
  async start(opts: { cwd: string; name: string; command: (shell: ShellSpec) => string }): Promise<Session | null> {
    const s = await this.create({ cwd: opts.cwd });
    if (!s || s.ptyId === null) return s;
    this.rename(s.id, opts.name);
    await invoke('pty_write', { id: s.ptyId, data: opts.command(s.shell) + '\r' }).catch(() => {});
    s.term.focus();
    return s;
  }

  /** Types text into a tab as a paste (bracketed, when the program asks for it), without Enter. */
  paste(id: number, text: string): boolean {
    const s = this.sessions.find((x) => x.id === id && !x.exited);
    if (!s) return false;
    this.setActive(s.id);
    s.term.paste(text);
    s.term.focus();
    return true;
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

/**
 * The clipboard's text, read by the Rust side: the web view's own clipboard read makes the user
 * allow it first. (The browser preview has no Rust side.)
 */
export function readClipboard(): Promise<string> {
  return '__TAURI_INTERNALS__' in window ? invoke<string>('clipboard_read_text') : navigator.clipboard.readText();
}

export function useTerminals() {
  return useSyncExternalStore(terminals.subscribe, terminals.getSnapshot);
}

/** The name shown on a tab: a program's title when allowed, else the session name. */
export function tabLabel(s: Session): string {
  return !s.custom && getSettings().terminal.useAppTitle && s.title ? s.title : s.name;
}

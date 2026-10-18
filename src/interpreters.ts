// PHP CLI interpreters (Settings ▸ PHP): a local php, a Docker image, a Docker Compose service or
// a server over SSH. They are kept for all projects; each project picks one, its language level and
// extra include paths. Running PHP through one: commandFor(); what it is: inspect().

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';
import { projectStorage } from './projectStorage';

export type InterpreterKind = 'local' | 'docker' | 'compose' | 'ssh';

export interface Interpreter {
  id: string;
  name: string;
  kind: InterpreterKind;
  /** php inside the container / on the server, or the local php.exe. */
  phpPath: string;
  /** Only listed in this project (its root). */
  projectRoot?: string;
  /** Debugger extension to load with -dzend_extension= when it isn't in php.ini. */
  debuggerExtension: string;
  /** Extra -d options, one "key=value" per entry. */
  options: string[];
  /** Docker: the image. */
  image?: string;
  /** Docker Compose: files (relative to the project), service, environment, how to reach the container. */
  composeFiles?: string[];
  service?: string;
  env?: string;
  lifecycle?: 'exec' | 'run';
  /** SSH. */
  host?: string;
  port?: number;
  user?: string;
  keyFile?: string;
  /** SSH: where this project lives on the server (the path mapping for debugging). */
  remoteRoot?: string;
}

/** Where Docker containers mount the project when PHPBlitz runs them. */
export const DOCKER_PROJECT = '/opt/project';

/** Running a script with step debugging: Xdebug connects back to PHPBlitz on `port`. */
export interface DebugTarget {
  port: number;
}

/** What `inspect` found out by running PHP through the interpreter. */
export interface PhpInfo {
  version: string;
  binary: string;
  ini: string | false;
  extensions: string[];
  xdebug: string | false;
  xdebugMode: string | false;
  os: string;
}

export interface PathMapping {
  local: string;
  remote: string;
}

export interface ProjectPhp {
  /** '' = none. */
  interpreterId: string;
  /** 'auto' = composer.json's "php" requirement, else the interpreter's version. */
  languageLevel: string;
  includePaths: string[];
}

const DEFAULT_PROJECT: ProjectPhp = { interpreterId: '', languageLevel: 'auto', includePaths: [] };

export const LANGUAGE_LEVELS: { id: string; features: string }[] = [
  { id: '8.5', features: 'pipe operator, clone with, #[\\NoDiscard]' },
  { id: '8.4', features: "'new' without parentheses, property hooks, asymmetric visibility" },
  { id: '8.3', features: 'typed class constants, #[\\Override], json_validate()' },
  { id: '8.2', features: 'readonly classes, DNF types, null/false/true types' },
  { id: '8.1', features: 'enums, readonly properties, first-class callables, never' },
  { id: '8.0', features: 'named arguments, match, nullsafe operator, union types, attributes' },
  { id: '7.4', features: 'typed properties, arrow functions, ??=' },
];

// ── Storage ────────────────────────────────────────────────────

const LIST_KEY = 'phpblitz.interpreters';
const projectKey = (root: string) => `phpblitz.php:${root}`;
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export function allInterpreters(): Interpreter[] {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]');
  } catch {
    return [];
  }
}

/** Interpreters a project can use: global ones and its own. */
export function interpretersFor(root: string): Interpreter[] {
  return allInterpreters().filter((i) => !i.projectRoot || i.projectRoot === root);
}

export function saveInterpreters(list: Interpreter[]) {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {
    // Kept for this session only.
  }
  changed();
}

export function projectPhp(root: string): ProjectPhp {
  try {
    return { ...DEFAULT_PROJECT, ...JSON.parse(projectStorage.getItem(projectKey(root)) ?? '{}') };
  } catch {
    return DEFAULT_PROJECT;
  }
}

export function saveProjectPhp(root: string, value: ProjectPhp) {
  try {
    projectStorage.setItem(projectKey(root), JSON.stringify(value));
  } catch {
    // Kept for this session only.
  }
  changed();
}

/** Re-renders when interpreters or a project's PHP settings change. */
export function useInterpreters() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

export function newInterpreter(kind: InterpreterKind, patch: Partial<Interpreter> = {}): Interpreter {
  return {
    id: `php-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'PHP',
    kind,
    phpPath: kind === 'local' ? '' : kind === 'ssh' ? '/usr/bin/php' : 'php',
    debuggerExtension: '',
    options: [],
    ...(kind === 'compose' ? { composeFiles: ['./docker-compose.yml'], service: '', env: '', lifecycle: 'exec' as const } : {}),
    ...(kind === 'ssh' ? { port: 22 } : {}),
    ...patch,
  };
}

export function kindLabel(i: Interpreter): string {
  switch (i.kind) {
    case 'local':
      return i.phpPath || 'local';
    case 'docker':
      return `Docker: ${i.image || '?'}`;
    case 'compose':
      return `Docker Compose: ${i.service || '?'}`;
    case 'ssh':
      return `SSH: ${i.user ? `${i.user}@` : ''}${i.host || '?'}`;
  }
}

// ── Running PHP through an interpreter ────────────────────────

/** -d options from the interpreter (and the debugger extension when set). */
function phpOptions(i: Interpreter): string[] {
  const out: string[] = [];
  if (i.debuggerExtension.trim()) out.push(`-dzend_extension=${i.debuggerExtension.trim()}`);
  for (const o of i.options) if (o.trim()) out.push(`-d${o.trim()}`);
  return out;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The host Xdebug connects back to, as seen from where PHP runs. */
export function debugClientHost(i: Interpreter): string {
  if (i.kind === 'docker' || i.kind === 'compose') return 'host.docker.internal';
  return '127.0.0.1'; // local; SSH goes through a reverse tunnel to this machine
}

function debugOptions(i: Interpreter, d: DebugTarget): string[] {
  return ['-dxdebug.mode=debug', '-dxdebug.start_with_request=yes', `-dxdebug.client_host=${debugClientHost(i)}`, `-dxdebug.client_port=${d.port}`];
}

/**
 * The program and arguments that run `php <args>` with this interpreter. `root` mounts the project
 * into a Docker container; `debug` turns step debugging on for this run.
 */
export function commandFor(
  i: Interpreter,
  args: string[],
  opts: { lifecycle?: 'exec' | 'run'; root?: string; debug?: DebugTarget } = {},
): { program: string; args: string[] } {
  const php = [i.phpPath || 'php', ...phpOptions(i), ...(opts.debug ? debugOptions(i, opts.debug) : []), ...args];
  switch (i.kind) {
    case 'local':
      return { program: php[0], args: php.slice(1) };
    case 'docker': {
      const mount = opts.root ? ['-v', `${opts.root}:${DOCKER_PROJECT}`, '-w', DOCKER_PROJECT] : [];
      // Linux has no host.docker.internal by default: map it to the host.
      const host = opts.debug ? ['--add-host=host.docker.internal:host-gateway'] : [];
      return { program: 'docker', args: ['run', '--rm', '-i', ...mount, ...host, i.image || '', ...php] };
    }
    case 'compose': {
      const files = (i.composeFiles?.length ? i.composeFiles : ['./docker-compose.yml']).flatMap((f) => ['-f', f]);
      const env = (i.env ?? '')
        .split(/[;\n]/)
        .map((s) => s.trim())
        .filter((s) => s.includes('='))
        .flatMap((s) => ['-e', s]);
      const mode = opts.lifecycle ?? i.lifecycle ?? 'exec';
      return mode === 'run'
        ? { program: 'docker', args: ['compose', ...files, 'run', '--rm', '-T', ...env, i.service || '', ...php] }
        : { program: 'docker', args: ['compose', ...files, 'exec', '-T', ...env, i.service || '', ...php] };
    }
    case 'ssh': {
      const target = `${i.user ? `${i.user}@` : ''}${i.host ?? ''}`;
      const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
      if (i.port && i.port !== 22) sshArgs.push('-p', String(i.port));
      if (i.keyFile) sshArgs.push('-i', i.keyFile);
      // Debugging: Xdebug on the server connects to its own port, tunnelled back to PHPBlitz.
      if (opts.debug) sshArgs.push('-R', `${opts.debug.port}:127.0.0.1:${opts.debug.port}`);
      // The remote shell joins its arguments: quote each one.
      return { program: 'ssh', args: [...sshArgs, target, php.map(shellQuote).join(' ')] };
    }
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `php <args>` through the interpreter, from the project folder. */
export async function runPhp(i: Interpreter, root: string, args: string[], debug?: DebugTarget): Promise<RunResult> {
  if (!isTauri) throw new Error('Running PHP needs the desktop app.');
  const first = commandFor(i, args, { root, debug });
  const r = await invoke<RunResult>('run_process', { cwd: root, program: first.program, args: first.args });
  // Docker Compose with "exec" needs a running container: fall back to a new one.
  if (r.code !== 0 && i.kind === 'compose' && (i.lifecycle ?? 'exec') === 'exec' && /is not running|no container found|not running/i.test(r.stderr)) {
    const second = commandFor(i, args, { lifecycle: 'run', root, debug });
    return invoke<RunResult>('run_process', { cwd: root, program: second.program, args: second.args });
  }
  return r;
}

const INSPECT = `echo json_encode(['version'=>PHP_VERSION,'binary'=>PHP_BINARY,'ini'=>php_ini_loaded_file(),'extensions'=>get_loaded_extensions(),'xdebug'=>phpversion('xdebug'),'xdebugMode'=>ini_get('xdebug.mode'),'os'=>PHP_OS_FAMILY]);`;

/** PHP version, php.ini, extensions and Xdebug, as the interpreter reports them. */
export async function inspect(i: Interpreter, root: string): Promise<PhpInfo> {
  const r = await runPhp(i, root, ['-r', INSPECT]);
  const json = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1);
  if (r.code !== 0 || !json) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || `exit code ${r.code}`);
  return JSON.parse(json) as PhpInfo;
}

/** inspect() results for this session, by interpreter id. */
const infoCache = new Map<string, Promise<PhpInfo>>();
export function cachedInspect(i: Interpreter, root: string, refresh = false): Promise<PhpInfo> {
  const key = `${i.id}:${JSON.stringify(i)}`;
  if (refresh) infoCache.delete(key);
  let p = infoCache.get(key);
  if (!p) {
    p = inspect(i, root);
    infoCache.set(key, p);
    p.catch(() => infoCache.delete(key));
  }
  return p;
}

// ── Docker Compose ─────────────────────────────────────────────

export interface ComposeService {
  name: string;
  image?: string;
  /** Bind mounts: host folder → container folder (the path mappings). */
  mounts: PathMapping[];
}

/** The services of a compose project (`docker compose config`; no containers are started). */
export async function composeServices(root: string, files: string[]): Promise<ComposeService[]> {
  if (!isTauri) throw new Error('Reading Docker Compose files needs the desktop app.');
  const args = ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'];
  const r = await invoke<RunResult>('run_process', { cwd: root, program: 'docker', args });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'docker compose config failed');
  const config = JSON.parse(r.stdout) as { services?: Record<string, { image?: string; volumes?: { type?: string; source?: string; target?: string }[] }> };
  return Object.entries(config.services ?? {}).map(([name, s]) => ({
    name,
    image: s.image,
    mounts: (s.volumes ?? [])
      .filter((v) => v.type === 'bind' && v.source && v.target)
      .map((v) => ({ local: v.source!.replace(/\\/g, '/'), remote: v.target! })),
  }));
}

/** Path mappings of an interpreter in this project: the service's bind mounts inside the project. */
export async function pathMappings(i: Interpreter, root: string): Promise<PathMapping[]> {
  if (i.kind !== 'compose') return [];
  const services = await composeServices(root, i.composeFiles ?? ['./docker-compose.yml']);
  const svc = services.find((s) => s.name === i.service);
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return (svc?.mounts ?? []).filter((m) => norm(m.local).startsWith(norm(root)) || norm(root).startsWith(norm(m.local)));
}

/**
 * Local folder ↔ path where PHP sees it, for breakpoints and stepping. Empty for a local
 * interpreter (same paths).
 */
export async function debugMappings(i: Interpreter | null, root: string): Promise<PathMapping[]> {
  if (!i || i.kind === 'local') return [];
  if (i.kind === 'docker') return [{ local: root, remote: DOCKER_PROJECT }];
  if (i.kind === 'ssh') return i.remoteRoot ? [{ local: root, remote: i.remoteRoot.replace(/\/+$/, '') }] : [];
  return pathMappings(i, root).catch(() => []);
}

/** Maps a local path to the server's, or back (longest mapping first). */
export function mapPath(path: string, mappings: PathMapping[], toRemote: boolean): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(path);
  const sorted = [...mappings].sort((a, b) => norm(toRemote ? b.local : b.remote).length - norm(toRemote ? a.local : a.remote).length);
  for (const m of sorted) {
    const from = norm(toRemote ? m.local : m.remote);
    const to = norm(toRemote ? m.remote : m.local);
    const same = toRemote && /^[A-Za-z]:/.test(from) ? p.toLowerCase().startsWith(from.toLowerCase()) : p.startsWith(from);
    if (same && (p.length === from.length || p[from.length] === '/')) return to + p.slice(from.length);
  }
  return p;
}

// ── Language level ─────────────────────────────────────────────

/** The lowest PHP version composer.json allows ("^8.2 || ^8.3" → 8.2). */
export function composerPhpLevel(composerJson: string | null): string | null {
  if (!composerJson) return null;
  try {
    const constraint = JSON.parse(composerJson)?.require?.php as string | undefined;
    const m = constraint?.match(/(\d+)\.(\d+)/);
    return m ? `${m[1]}.${m[2]}` : null;
  } catch {
    return null;
  }
}

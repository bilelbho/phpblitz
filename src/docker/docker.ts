// Docker through its CLI: the project's Compose services, every container and image, and what the
// Services tool window does with them (start, stop, logs…). The CLI prints JSON lines
// (--format '{{json .}}'), read here into plain objects.

import { invoke } from '@tauri-apps/api/core';
import type { RunResult } from '../backend/types';

export interface Container {
  id: string;
  name: string;
  image: string;
  /** running, exited, created, paused, restarting, dead */
  state: string;
  /** "Up 2 hours", "Exited (0) 3 minutes ago" */
  status: string;
  ports: string;
  created: string;
  labels: Record<string, string>;
}

export interface Image {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

export interface ComposeService {
  name: string;
  /** Its container, once `up` made one. */
  container: Container | null;
}

export interface DockerState {
  /** null: Docker answered; else why it didn't (not installed, daemon not running…). */
  error: string | null;
  containers: Container[];
  images: Image[];
  /** The project's compose file (relative), and its services; null when it has none. */
  compose: { file: string; project: string; services: ComposeService[]; error?: string } | null;
}

/** Each line of output that's a JSON object. */
export function jsonLines<T = Record<string, unknown>>(out: string): T[] {
  const rows: T[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      // `docker compose ps --format json` prints one array in older versions, a line per service in newer.
      if (Array.isArray(v)) rows.push(...v);
      else rows.push(v);
    } catch {
      // A warning line.
    }
  }
  return rows;
}

/** Docker's label list "a=b,c=d" (values may hold '='). */
export function parseLabels(s: unknown): Record<string, string> {
  if (s && typeof s === 'object') return s as Record<string, string>;
  const out: Record<string, string> = {};
  for (const part of String(s ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function toContainer(r: Record<string, unknown>): Container {
  return {
    id: str(r.ID).slice(0, 12),
    name: str(r.Names ?? r.Name).replace(/^\//, ''),
    image: str(r.Image),
    state: str(r.State).toLowerCase(),
    status: str(r.Status),
    ports: str(r.Ports ?? r.Publishers),
    created: str(r.CreatedAt ?? r.RunningFor),
    labels: parseLabels(r.Labels),
  };
}

export function toImage(r: Record<string, unknown>): Image {
  return { id: str(r.ID).replace(/^sha256:/, '').slice(0, 12), repository: str(r.Repository), tag: str(r.Tag), size: str(r.Size), created: str(r.CreatedSince ?? r.CreatedAt) };
}

/** Paths as Docker's labels write them, comparable: forward slashes, lower case on Windows. */
const samePath = (a: string, b: string) => {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(a) ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** The compose file's services, each with the container Compose made for it in this project (if any). */
export function composeServices(services: string[], containers: Container[], root: string): ComposeService[] {
  const mine = containers.filter((c) => c.labels['com.docker.compose.project.working_dir'] && samePath(c.labels['com.docker.compose.project.working_dir'], root));
  const names = [...new Set([...services, ...mine.map((c) => c.labels['com.docker.compose.service']).filter(Boolean)])];
  return names.map((name) => ({ name, container: mine.find((c) => c.labels['com.docker.compose.service'] === name) ?? null }));
}

/** Compose's project name for a folder: its name, lower case, letters, digits, - and _ only. */
export const composeProjectName = (root: string) =>
  root
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

// ── Running docker ─────────────────────────────────────────────

export async function docker(root: string, args: string[]): Promise<RunResult> {
  return invoke<RunResult>('run_process', { cwd: root, program: 'docker', args, env: null });
}

/** Docker's own words for a failure, or what to do when it isn't there at all. */
export function dockerError(r: RunResult | Error | unknown): string {
  const text = r && typeof r === 'object' && 'stderr' in r ? (r as RunResult).stderr || (r as RunResult).stdout : String(r instanceof Error ? r.message : r);
  if (/cannot find the file specified|program not found|not recognized|No such file or directory \(os error 2\)|os error 2/i.test(text) && !/pipe/i.test(text)) return 'Docker isn’t installed (or not on PATH).';
  if (/docker daemon|dockerDesktopLinuxEngine|Is the docker daemon running|failed to connect to the docker API|error during connect/i.test(text)) return 'Docker isn’t running. Start Docker Desktop (or the Docker service), then refresh.';
  return text.trim().split('\n').slice(-3).join('\n') || 'Docker failed.';
}

/** Everything the Services tool window lists. `composeFile`: the project's, if it has one. */
export async function loadDocker(root: string, composeFile: string | null): Promise<DockerState> {
  // Services from the compose file don't need the daemon: read them first.
  let services: string[] = [];
  let composeError: string | undefined;
  if (composeFile) {
    const r = await docker(root, ['compose', '-f', composeFile, 'config', '--services']).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }));
    if (r.code === 0) services = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    else composeError = dockerError(r);
  }
  const compose = (containers: Container[]) => (composeFile ? { file: composeFile, project: composeProjectName(root), services: composeServices(services, containers, root), error: composeError } : null);
  const ps = await docker(root, ['ps', '-a', '--no-trunc', '--format', '{{json .}}']).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }));
  if (ps.code !== 0) return { error: dockerError(ps), containers: [], images: [], compose: compose([]) };
  const containers = jsonLines(ps.stdout).map(toContainer);
  const im = await docker(root, ['images', '--format', '{{json .}}']).catch(() => null);
  const images = im?.code === 0 ? jsonLines(im.stdout).map(toImage) : [];
  return { error: null, containers, images, compose: compose(containers) };
}

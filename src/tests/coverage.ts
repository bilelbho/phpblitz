// Code coverage of a test run: the Clover XML PHPUnit (and Pest) write with --coverage-clover,
// read into lines hit per file. The editor marks covered and uncovered lines; the Coverage tool
// window lists files and folders with their percentages.

import { useSyncExternalStore } from 'react';
import type { Backend } from '../backend/types';
import { readCache, writeCache } from '../blitzCache';

export interface FileCoverage {
  path: string;
  /** Executable lines → times hit (0: never). */
  lines: Map<number, number>;
  statements: number;
  coveredStatements: number;
  methods: number;
  coveredMethods: number;
}

export interface CoverageReport {
  /** The run's label ('PHPUnit', 'UserTest'…). */
  label: string;
  at: number;
  files: Map<string, FileCoverage>;
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');


/** Files of a Clover report; `toLocal` maps the paths PHP saw (a container's, a server's) to the project's. */
export function parseClover(xml: string, toLocal: (path: string) => string = (p) => p): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  for (const m of xml.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    const path = toLocal(unescape(name).replace(/\\/g, '/'));
    const lines = new Map<number, number>();
    let methods = 0;
    let coveredMethods = 0;
    for (const l of m[2].matchAll(/<line\b[^>]*>/g)) {
      const num = Number(attr(l[0], 'num'));
      const count = Number(attr(l[0], 'count') ?? 0);
      if (!num) continue;
      if (attr(l[0], 'type') === 'method') {
        methods++;
        if (count > 0) coveredMethods++;
        continue;
      }
      lines.set(num, Math.max(lines.get(num) ?? 0, count));
    }
    let statements = 0;
    let covered = 0;
    for (const c of lines.values()) {
      statements++;
      if (c > 0) covered++;
    }
    // Several <file> entries for one path (classes and functions apart): add them up.
    const prev = files.get(path);
    if (prev) {
      for (const [n, c] of lines) prev.lines.set(n, Math.max(prev.lines.get(n) ?? 0, c));
      prev.statements = prev.lines.size;
      prev.coveredStatements = [...prev.lines.values()].filter((c) => c > 0).length;
      prev.methods += methods;
      prev.coveredMethods += coveredMethods;
    } else files.set(path, { path, lines, statements, coveredStatements: covered, methods, coveredMethods });
  }
  return files;
}

export interface CoverageNode {
  name: string;
  /** Folder or file path. */
  path: string;
  file?: FileCoverage;
  children: CoverageNode[];
  statements: number;
  coveredStatements: number;
  methods: number;
  coveredMethods: number;
}

/** Folders and files under `root`, each with the sums of what's in it; single-child folders joined (app/Models). */
export function coverageTree(files: Iterable<FileCoverage>, root: string): CoverageNode {
  const top: CoverageNode = { name: '', path: root, children: [], statements: 0, coveredStatements: 0, methods: 0, coveredMethods: 0 };
  for (const f of files) {
    const rel = f.path.startsWith(`${root}/`) ? f.path.slice(root.length + 1) : f.path;
    const parts = rel.split('/');
    let node = top;
    let path = root;
    for (let i = 0; i < parts.length; i++) {
      path = `${path}/${parts[i]}`;
      const last = i === parts.length - 1;
      let child = node.children.find((c) => c.name === parts[i] && !c.file === !last);
      if (!child) {
        child = { name: parts[i], path, children: [], statements: 0, coveredStatements: 0, methods: 0, coveredMethods: 0, ...(last ? { file: f } : {}) };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sum = (n: CoverageNode) => {
    if (n.file) {
      n.statements = n.file.statements;
      n.coveredStatements = n.file.coveredStatements;
      n.methods = n.file.methods;
      n.coveredMethods = n.file.coveredMethods;
      return;
    }
    for (const c of n.children) {
      sum(c);
      n.statements += c.statements;
      n.coveredStatements += c.coveredStatements;
      n.methods += c.methods;
      n.coveredMethods += c.coveredMethods;
    }
    // Folders first, then by name.
    n.children.sort((a, b) => (!a.file === !b.file ? a.name.localeCompare(b.name) : a.file ? 1 : -1));
    // A folder with only one folder in it: shown as one row.
    n.children = n.children.map((c) => {
      while (!c.file && c.children.length === 1 && !c.children[0].file) c = { ...c.children[0], name: `${c.name}/${c.children[0].name}` };
      return c;
    });
  };
  sum(top);
  return top;
}

/** "83%", or "–" when there's nothing to cover. */
export const percent = (covered: number, total: number) => (total ? `${Math.floor((covered / total) * 100)}%` : '–');

// ── The current report ─────────────────────────────────────────

let report: CoverageReport | null = null;
/** The last coverage run wrote no report: why. */
let problem: { label: string; message: string } | null = null;
/** Covered / uncovered lines shown in the editor. */
let shown = true;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export const coverage = {
  get report() {
    return report;
  },
  get shown() {
    return shown;
  },
  get problem() {
    return problem;
  },
  set(r: CoverageReport | null) {
    report = r;
    problem = null;
    shown = true;
    changed();
    if (project) void writeCache(project, 'coverage.json', r ? keptOf(r) : null);
  },
  /** A coverage run without a report: the message replaces the last one (the old report stays). */
  fail(label: string, message: string) {
    problem = { label, message };
    changed();
  },
  show(on: boolean) {
    shown = on;
    changed();
  },
  /** A file's lines when the editor should mark them. */
  of(path: string): FileCoverage | null {
    return shown ? (report?.files.get(path) ?? null) : null;
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

// ── Kept between sessions: .blitz/cache/coverage.json ──────────

interface Kept {
  version: 1;
  label: string;
  at: number;
  /** path, statements, covered, methods, covered methods, then line numbers and counts in pairs. */
  files: [string, number, number, number, number, number[]][];
}

let project: Backend | null = null;

export function keptOf(r: CoverageReport): Kept {
  return {
    version: 1,
    label: r.label,
    at: r.at,
    files: [...r.files.values()].map((f) => [f.path, f.statements, f.coveredStatements, f.methods, f.coveredMethods, [...f.lines].flat()]),
  };
}

export function reportOf(k: Kept): CoverageReport {
  const files = new Map<string, FileCoverage>();
  for (const [path, statements, coveredStatements, methods, coveredMethods, flat] of k.files) {
    const lines = new Map<number, number>();
    for (let i = 0; i + 1 < flat.length; i += 2) lines.set(flat[i], flat[i + 1]);
    files.set(path, { path, lines, statements, coveredStatements, methods, coveredMethods });
  }
  return { label: k.label, at: k.at, files };
}

/** The project's last coverage report (or none); null: no project. */
export async function openCoverage(backend: Backend | null) {
  project = backend;
  report = null;
  problem = null;
  shown = true;
  changed();
  if (!backend) return;
  const kept = await readCache<Kept>(backend, 'coverage.json');
  if (project !== backend || kept?.version !== 1 || !Array.isArray(kept.files)) return;
  report = reportOf(kept);
  changed();
}

export function useCoverage() {
  useSyncExternalStore(coverage.subscribe, () => version);
  return coverage;
}

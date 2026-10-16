// Mark Directory As (Project tree): Sources / Test Sources / Resource roots and Excluded folders,
// and the file colors that follow from them (tests green, libraries like vendor/ brown), as in
// PhpStorm. Defaults come from composer.json's autoload / autoload-dev; changes are kept per project.

import { useSyncExternalStore } from 'react';

export type DirMark = 'source' | 'test' | 'resource' | 'excluded';
export type FileColor = 'test' | 'library' | null;

export const MARK_LABELS: Record<DirMark, string> = {
  source: 'Sources Root',
  test: 'Test Sources Root',
  resource: 'Resource Root',
  excluded: 'Excluded',
};

/** Folders that hold other people's code (shown as "library root"). */
const LIBRARY_DIRS = new Set(['vendor', 'node_modules']);

class DirMarks {
  private root = '';
  /** Folder (relative) → mark from composer.json. */
  private defaults: Record<string, DirMark> = {};
  /** What the user set; 'none' unmarks a default. */
  private saved: Record<string, DirMark | 'none'> = {};
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.version;

  private changed() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private key() {
    return `phpblitz.dirMarks:${this.root}`;
  }

  /** Loads a project's marks; `composerJson` is the text of its composer.json, if any. */
  open(root: string, composerJson: string | null) {
    this.root = root;
    this.defaults = composerJson ? composerDefaults(composerJson) : {};
    try {
      this.saved = JSON.parse(localStorage.getItem(this.key()) ?? '{}');
    } catch {
      this.saved = {};
    }
    this.changed();
  }

  rel(path: string) {
    return path.startsWith(this.root + '/') ? path.slice(this.root.length + 1) : path === this.root ? '' : path;
  }

  markOf(path: string): DirMark | null {
    const rel = this.rel(path);
    const saved = this.saved[rel];
    if (saved === 'none') return null;
    return saved ?? this.defaults[rel] ?? null;
  }

  /** Sets (or with null, removes) a folder's mark. */
  set(path: string, mark: DirMark | null) {
    const rel = this.rel(path);
    if (mark) this.saved[rel] = mark;
    else if (this.defaults[rel]) this.saved[rel] = 'none';
    else delete this.saved[rel];
    try {
      localStorage.setItem(this.key(), JSON.stringify(this.saved));
    } catch {
      // Kept for this session only.
    }
    this.changed();
  }

  /** The mark that applies to a path: its own, or the nearest marked folder above it. */
  inherited(path: string): DirMark | null {
    const parts = this.rel(path).split('/');
    for (let i = parts.length; i > 0; i--) {
      const m = this.markOf(`${this.root}/${parts.slice(0, i).join('/')}`);
      if (m) return m;
    }
    return null;
  }

  isExcluded(path: string) {
    return this.inherited(path) === 'excluded';
  }

  /** Background color of a file or folder in the tree and of its editor tab. */
  colorOf(path: string): FileColor {
    const rel = this.rel(path);
    if (!rel) return null;
    if (LIBRARY_DIRS.has(rel.split('/')[0])) return 'library';
    return this.inherited(path) === 'test' ? 'test' : null;
  }
}

/** autoload → Sources Roots, autoload-dev → Test Sources Roots (PSR-4 and PSR-0 folders). */
function composerDefaults(text: string): Record<string, DirMark> {
  const out: Record<string, DirMark> = {};
  try {
    const json = JSON.parse(text);
    const add = (section: unknown, mark: DirMark) => {
      if (!section || typeof section !== 'object') return;
      for (const kind of ['psr-4', 'psr-0']) {
        const map = (section as Record<string, unknown>)[kind];
        if (!map || typeof map !== 'object') continue;
        for (const dirs of Object.values(map as Record<string, string | string[]>)) {
          for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
            const rel = String(d).replace(/^\.?\//, '').replace(/\/+$/, '');
            if (rel && !out[rel]) out[rel] = mark;
          }
        }
      }
    };
    add(json.autoload, 'source');
    add(json['autoload-dev'], 'test');
  } catch {
    // Not valid JSON: no defaults.
  }
  return out;
}

export const dirMarks = new DirMarks();

/** Re-renders when marks change. */
export function useDirMarks() {
  useSyncExternalStore(dirMarks.subscribe, dirMarks.getSnapshot);
  return dirMarks;
}

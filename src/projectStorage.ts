// Per-project state, kept in the project's .blitz folder (desktop app) .idea:
//
//   .blitz/project.json    settings to share with the team: PHP settings, Excluded folders
//   .blitz/workspace.json  this machine only (git-ignored): bookmarks, recent files, data sources,
//                          debugger watches, commit message history
//
// Modules keep their localStorage-style keys ("phpblitz.<name>:<root>"); this routes the ones for the
// open project to those files. State saved in localStorage by earlier versions moves over the first
// time it is read. The browser and the sample project keep using localStorage.
//
// Paths inside the project are written as $PROJECT_DIR$/…, so the files still work
// after the project folder is moved, and project.json reads the same on every machine.

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';

type FileName = 'project.json' | 'workspace.json';

/** Which file each kind of state goes to; others stay in localStorage. */
const FILE_OF: Record<string, FileName> = {
  php: 'project.json',
  dirMarks: 'project.json',
  bookmarks: 'workspace.json',
  recentFiles: 'workspace.json',
  dataSources: 'workspace.json',
  watches: 'workspace.json',
  commitMessages: 'workspace.json',
};

class BlitzFile {
  data: Record<string, unknown> = {};
  private timer = 0;
  constructor(
    private root: string,
    readonly name: FileName,
  ) {}

  async load() {
    try {
      const text = await invoke<string | null>('blitz_read', { root: this.root, name: this.name });
      this.data = text ? JSON.parse(text) : {};
    } catch {
      this.data = {};
    }
  }

  /** Writes soon (several changes in a row become one write). */
  save() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 300);
  }

  async flush() {
    window.clearTimeout(this.timer);
    // Sorted keys and indentation: readable, and small diffs when project.json is committed.
    const sorted = Object.fromEntries(Object.entries(this.data).sort(([a], [b]) => a.localeCompare(b)));
    await invoke('blitz_write', { root: this.root, name: this.name, text: JSON.stringify(sorted, null, 2) + '\n' }).catch((e) => console.warn(`Could not write .blitz/${this.name}`, e));
  }
}

let root = '';
const files = new Map<FileName, BlitzFile>();

/** Where a key of the open project lives: [file, entry name]; null for other keys. */
function route(key: string): [BlitzFile, string] | null {
  if (!root) return null;
  const m = key.match(/^phpblitz\.([A-Za-z]+):(.*)$/);
  if (!m || m[2] !== root) return null;
  const file = FILE_OF[m[1]] && files.get(FILE_OF[m[1]]);
  return file ? [file, m[1]] : null;
}

export const projectStorage = {
  /** Loads a disk project's .blitz files before its workspace opens. */
  async open(projectRoot: string) {
    void projectStorage.close();
    if (!isTauri) return;
    const loaded = (['project.json', 'workspace.json'] as const).map((name) => new BlitzFile(projectRoot, name));
    await Promise.all(loaded.map((f) => f.load()));
    files.clear();
    for (const f of loaded) files.set(f.name, f);
    root = projectRoot;
  },

  /** Writes what is pending and stops routing (the project closed). */
  async close() {
    const pending = [...files.values()];
    root = '';
    files.clear();
    await Promise.all(pending.map((f) => f.flush()));
  },

  getItem(key: string): string | null {
    const at = route(key);
    if (!at) return safe(() => localStorage.getItem(key));
    const [file, name] = at;
    if (name in file.data) return expand(JSON.stringify(file.data[name]));
    // Saved by an earlier version: move it to the file.
    const legacy = safe(() => localStorage.getItem(key));
    if (legacy !== null) {
      try {
        file.data[name] = JSON.parse(collapse(legacy));
        file.save();
      } catch {
        return legacy;
      }
    }
    return legacy;
  },

  setItem(key: string, value: string) {
    const at = route(key);
    if (!at) {
      localStorage.setItem(key, value);
      return;
    }
    const [file, name] = at;
    file.data[name] = JSON.parse(collapse(value));
    file.save();
  },
};

const PROJECT_DIR = '$PROJECT_DIR$';
/** The project root as it appears inside a JSON string. */
const rootInJson = () => JSON.stringify(root).slice(1, -1);
/** Paths in the project → $PROJECT_DIR$/… (only whole paths: the root followed by / or the string's end). */
const collapse = (json: string) => json.replace(new RegExp(escapeRegExp(rootInJson()) + '(?=/|")', 'g'), PROJECT_DIR);
const expand = (json: string) => json.split(PROJECT_DIR).join(rootInJson());

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

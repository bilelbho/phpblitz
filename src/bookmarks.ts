// Bookmarks: F11 toggles one on the caret line, Ctrl+F11 adds one with a
// mnemonic (0-9, A-Z) that Ctrl+<digit> jumps to, Shift+F11 lists them all. Kept per project.

import { useSyncExternalStore } from 'react';
import { projectStorage } from './projectStorage';

export interface Bookmark {
  path: string;
  /** 1-based; follows edits while the file is open (see EditorArea). */
  line: number;
  /** "1", "A"… */
  mnemonic?: string;
  description?: string;
}

export const MNEMONICS = [...'1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

class Bookmarks {
  private root = '';
  private list: Bookmark[] = [];
  private listeners = new Set<() => void>();

  /** Loads the project's bookmarks. */
  open(root: string) {
    this.root = root;
    try {
      this.list = JSON.parse(projectStorage.getItem(this.key()) ?? '[]');
    } catch {
      this.list = [];
    }
    this.emit();
  }

  all = () => this.list;
  inFile = (path: string) => this.list.filter((b) => b.path === path);
  at = (path: string, line: number) => this.list.find((b) => b.path === path && b.line === line);
  byMnemonic = (m: string) => this.list.find((b) => b.mnemonic === m);

  /** Adds a bookmark on a line, or removes the one there. */
  toggle(path: string, line: number) {
    if (this.at(path, line)) this.remove(path, line);
    else this.set({ path, line });
  }

  /** Adds or replaces the bookmark on a line. A mnemonic moves from wherever it was. */
  set(b: Bookmark) {
    this.list = this.list.filter((x) => !(x.path === b.path && x.line === b.line) && !(b.mnemonic && x.mnemonic === b.mnemonic));
    this.list.push(b);
    this.save();
  }

  remove(path: string, line: number) {
    this.list = this.list.filter((x) => !(x.path === path && x.line === line));
    this.save();
  }

  /** The editor moved a file's bookmarks (lines inserted or deleted above them). */
  moveLines(path: string, lines: { from: number; to: number }[]) {
    if (!lines.some((l) => l.from !== l.to)) return;
    this.list = this.list.map((b) => {
      const moved = b.path === path ? lines.find((l) => l.from === b.line) : undefined;
      return moved ? { ...b, line: moved.to } : b;
    });
    this.save();
  }

  /** A file was renamed or moved. */
  renamePath(from: string, to: string) {
    const inside = (p: string) => p === from || p.startsWith(from + '/');
    if (!this.list.some((b) => inside(b.path))) return;
    this.list = this.list.map((b) => (inside(b.path) ? { ...b, path: to + b.path.slice(from.length) } : b));
    this.save();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private key = () => `phpblitz.bookmarks:${this.root}`;

  private save() {
    try {
      projectStorage.setItem(this.key(), JSON.stringify(this.list));
    } catch {
      // Bookmarks still work for this session.
    }
    this.emit();
  }

  private emit() {
    this.list = [...this.list];
    for (const l of this.listeners) l();
  }
}

export const bookmarks = new Bookmarks();

export function useBookmarks(): Bookmark[] {
  return useSyncExternalStore(bookmarks.subscribe, bookmarks.all);
}

// Git operations for the Git tool window, branches popup, diff and annotations, on top of the
// git CLI (Backend.git). Every command is logged for the Git ▸ Console tab.

import { invoke } from '@tauri-apps/api/core';
import type { Backend, GitOperation, RunResult } from '../backend/types';
import { isTauri } from '../platform';
import { rebaseTodo, type RebaseStep } from './rebase';
import { eolOf, mergeWithMarkers } from './merge';

export interface Commit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** ISO 8601. */
  date: string;
  subject: string;
  /** "HEAD -> main", "origin/main", "tag: v1.0"… */
  refs: string[];
}

export interface Branch {
  /** "main" or "origin/main". */
  name: string;
  remote: boolean;
  current: boolean;
  hash: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;
  /** Renames: the old path. */
  from?: string;
}

export interface Stash {
  /** stash@{n}: it changes as stashes are added and dropped. */
  ref: string;
  message: string;
  date: string;
  /** The stash commit: stays the same. */
  hash: string;
}

/** Changes put aside with Shelve: one patch against `base`, and the files in it. */
export interface Shelf {
  id: string;
  name: string;
  /** ISO 8601. */
  date: string;
  /** The commit the patch was made on. */
  base: string;
  /** Relative paths, their change (A, M, D, R) and their text as shelved (null: deleted; absent: not text). */
  files: { path: string; status: string; after?: string | null }[];
  /** Files already unshelved (the shelf goes once all are). */
  applied: string[];
  patch: string;
}

export interface StashFile {
  /** U: an untracked file the stash took along. */
  status: 'A' | 'M' | 'D' | 'T' | 'U';
  path: string;
}

export interface BlameLine {
  hash: string;
  author: string;
  /** Without the angle brackets. */
  email: string;
  date: string;
  summary: string;
}

export interface ConsoleEntry {
  time: string;
  command: string;
  output: string;
  ok: boolean;
}

const SEP = '\x1f';
const END = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s', '%D'].join('%x1f') + '%x1e';

export class GitError extends Error {}

export class Git {
  private listeners = new Set<() => void>();
  console: ConsoleEntry[] = [];

  constructor(readonly backend: Backend) {}

  get root() {
    return this.backend.root;
  }

  /** The project's repositories (this one among them): a file's commands go to the one it's in. */
  private all: Git[] = [this];

  setRepositories(all: Git[]) {
    this.all = all.includes(this) ? all : [this, ...all];
  }

  /** The repository a file is in: the deepest one whose folder holds it (this one when none does). */
  owner(path: string): Git {
    const holding = this.all.filter((g) => path.startsWith(g.root + '/'));
    return holding.length ? holding.reduce((a, b) => (b.root.length > a.root.length ? b : a)) : this;
  }

  /** The one repository these files are in; files from several are refused (`what` names the action). */
  private oneOwner(changes: { path: string }[], what: string): Git {
    const groups = [...this.byOwner(changes).keys()];
    if (groups.length > 1) throw new GitError(`${what}: the files are in ${groups.length} repositories (${groups.map((g) => g.name).join(', ')}). Choose the files of one.`);
    return groups[0] ?? this;
  }

  /** The repository's folder name ("shop", "packages/api" shows as "api"). */
  get name() {
    return this.root.split('/').pop() || this.root;
  }

  /** Paths by the repository they're in. */
  private byOwner<T extends string | { path: string }>(items: T[]): Map<Git, T[]> {
    const out = new Map<Git, T[]>();
    for (const item of items) {
      const g = this.owner(typeof item === 'string' ? item : item.path);
      out.set(g, [...(out.get(g) ?? []), item]);
    }
    return out;
  }

  rel(path: string): string {
    return path.startsWith(this.root + '/') ? path.slice(this.root.length + 1) : path;
  }

  onConsole(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Runs git; throws GitError with git's message when it fails (unless `allowFail`). */
  async run(args: string[], opts: { allowFail?: boolean; quiet?: boolean; env?: Record<string, string> } = {}): Promise<RunResult> {
    const r = await this.backend.git(['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], opts.env);
    // Reads are frequent; the console shows what changes things (and every failure).
    if (!opts.quiet || r.code !== 0) {
      this.console = [
        ...this.console.slice(-200),
        { time: new Date().toLocaleTimeString(), command: `git ${args.join(' ')}`, output: (r.stdout + r.stderr).trim(), ok: r.code === 0 },
      ];
      this.listeners.forEach((l) => l());
    }
    if (r.code !== 0 && !opts.allowFail) throw new GitError((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
    return r;
  }

  private async out(args: string[]): Promise<string> {
    return (await this.run(args, { quiet: true })).stdout;
  }

  // ── History ──────────────────────────────────────────────

  async log(opts: { max?: number; skip?: number; branch?: string; path?: string; search?: string; author?: string } = {}): Promise<Commit[]> {
    // A file's history: in its own repository (a folder holding repositories: this one's).
    if (opts.path && this.owner(opts.path) !== this) return this.owner(opts.path).log(opts);
    const args = ['log', `--format=${LOG_FORMAT}`, `--max-count=${opts.max ?? 300}`, '--date-order'];
    if (opts.skip) args.push(`--skip=${opts.skip}`);
    if (opts.search) args.push(`--grep=${opts.search}`, '-i');
    if (opts.author) args.push(`--author=${opts.author}`);
    args.push(opts.branch || '--all');
    if (opts.path) args.push('--follow', '--', this.rel(opts.path));
    const text = await this.out(args).catch((e) => {
      // A repository without commits yet.
      if (/does not have any commits|unknown revision/i.test(String(e))) return '';
      throw e;
    });
    return text
      .split(END)
      .map((rec) => rec.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, short, parents, author, email, date, subject, refs] = rec.split(SEP);
        return {
          hash,
          short,
          parents: parents ? parents.split(' ') : [],
          author,
          email,
          date,
          subject,
          refs: refs ? refs.split(', ').map((r) => r.trim()).filter(Boolean) : [],
        };
      });
  }

  async commitMessage(hash: string): Promise<string> {
    return (await this.out(['log', '-1', '--format=%B', hash])).trim();
  }

  /** Files a commit changed (against its first parent). */
  async commitFiles(hash: string): Promise<FileChange[]> {
    const text = await this.out(['diff-tree', '--no-commit-id', '-r', '-M', '--root', '--name-status', '-m', '--first-parent', hash]);
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, a, b] = line.split('\t');
        const s = status[0] as FileChange['status'];
        return s === 'R' || s === 'C' ? { status: s, path: `${this.root}/${b}`, from: `${this.root}/${a}` } : { status: s, path: `${this.root}/${a}` };
      });
  }

  private heads = new Map<string, Promise<string | null>>();

  /** HEAD version of a file (cached until the status refreshes), for change markers and diffs. */
  head(path: string): Promise<string | null> {
    if (this.owner(path) !== this) return this.owner(path).head(path);
    let p = this.heads.get(path);
    if (!p) {
      p = this.show('HEAD', path).catch(() => null);
      this.heads.set(path, p);
    }
    return p;
  }

  clearHeads() {
    for (const g of this.all) g.heads.clear();
  }

  /** A file's content at a revision, or null when it doesn't exist there. */
  async show(rev: string, path: string): Promise<string | null> {
    if (this.owner(path) !== this) return this.owner(path).show(rev, path);
    const r = await this.run(['show', `${rev}:${this.rel(path)}`], { allowFail: true, quiet: true });
    return r.code === 0 ? r.stdout : null;
  }

  async blame(path: string): Promise<BlameLine[]> {
    if (this.owner(path) !== this) return this.owner(path).blame(path);
    const text = await this.out(['blame', '--porcelain', '--', this.rel(path)]);
    const info = new Map<string, Omit<BlameLine, 'hash'>>();
    const lines: BlameLine[] = [];
    let current = '';
    for (const line of text.split('\n')) {
      const head = line.match(/^([0-9a-f]{40}) \d+ \d+/);
      if (head) {
        current = head[1];
        if (!info.has(current)) info.set(current, { author: '', email: '', date: '', summary: '' });
        continue;
      }
      const meta = info.get(current);
      if (!meta) continue;
      if (line.startsWith('author ')) meta.author = line.slice(7);
      else if (line.startsWith('author-mail ')) meta.email = line.slice(12).replace(/^<|>$/g, '');
      else if (line.startsWith('author-time ')) meta.date = new Date(Number(line.slice(12)) * 1000).toISOString();
      else if (line.startsWith('summary ')) meta.summary = line.slice(8);
      else if (line.startsWith('\t')) lines.push({ hash: current, ...meta });
    }
    return lines;
  }

  // ── Branches ─────────────────────────────────────────────

  async branches(): Promise<Branch[]> {
    const text = await this.out(['for-each-ref', '--format=%(refname)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)', 'refs/heads', 'refs/remotes']);
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, hash, upstream, track, head] = line.split(SEP);
        const remote = ref.startsWith('refs/remotes/');
        const ahead = track.match(/ahead (\d+)/);
        const behind = track.match(/behind (\d+)/);
        return {
          name: ref.replace(/^refs\/(heads|remotes)\//, ''),
          remote,
          current: head === '*',
          hash,
          upstream: upstream || undefined,
          ahead: ahead ? Number(ahead[1]) : undefined,
          behind: behind ? Number(behind[1]) : undefined,
        };
      })
      .filter((b) => !b.name.endsWith('/HEAD'));
  }

  async currentBranch(): Promise<string> {
    return (await this.out(['branch', '--show-current'])).trim();
  }

  checkout(ref: string) {
    return this.run(['checkout', ref]);
  }
  /** A remote branch: a local branch tracking it (origin/feature → feature). */
  checkoutRemote(remoteBranch: string) {
    const local = remoteBranch.split('/').slice(1).join('/');
    return this.run(['checkout', '-b', local, '--track', remoteBranch]);
  }
  newBranch(name: string, from?: string, checkout = true) {
    return checkout ? this.run(['checkout', '-b', name, ...(from ? [from] : [])]) : this.run(['branch', name, ...(from ? [from] : [])]);
  }
  renameBranch(from: string, to: string) {
    return this.run(['branch', '-m', from, to]);
  }
  deleteBranch(name: string, force = false) {
    return this.run(['branch', force ? '-D' : '-d', name]);
  }
  deleteRemoteBranch(remoteBranch: string) {
    const [remote, ...rest] = remoteBranch.split('/');
    return this.run(['push', remote, '--delete', rest.join('/')]);
  }
  merge(ref: string) {
    return this.run(['merge', ref]);
  }
  rebase(onto: string) {
    return this.run(['rebase', onto]);
  }

  // ── Remotes ──────────────────────────────────────────────

  fetch() {
    return this.run(['fetch', '--all', '--prune']);
  }
  pull() {
    return this.run(['pull', '--no-edit']);
  }

  /** The address of origin (else the first remote); null without remotes. */
  async remoteUrl(): Promise<string | null> {
    const remotes = (await this.out(['remote']).catch(() => '')).split('\n').filter(Boolean);
    const name = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!name) return null;
    return (await this.run(['remote', 'get-url', name], { allowFail: true, quiet: true })).stdout.trim() || null;
  }

  /** Commits push would send: ahead of the upstream, or not on any remote yet. */
  async outgoing(): Promise<{ commits: Commit[]; upstream: string | null; remote: string | null }> {
    const upstream = (await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true, quiet: true })).stdout.trim() || null;
    const remotes = (await this.out(['remote'])).split('\n').filter(Boolean);
    const commits = upstream ? await this.log({ branch: `${upstream}..HEAD`, max: 200 }) : await this.logNotOnRemotes();
    return { commits, upstream, remote: upstream?.split('/')[0] ?? remotes[0] ?? null };
  }

  private async logNotOnRemotes(): Promise<Commit[]> {
    const text = await this.out(['log', `--format=${LOG_FORMAT}`, '--max-count=200', 'HEAD', '--not', '--remotes']).catch(() => '');
    return text
      .split(END)
      .map((rec) => rec.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, short, parents, author, email, date, subject, refs] = rec.split(SEP);
        return { hash, short, parents: parents ? parents.split(' ') : [], author, email, date, subject, refs: refs ? refs.split(', ') : [] };
      });
  }

  async push(opts: { force?: boolean; setUpstream?: { remote: string; branch: string } } = {}) {
    const args = ['push'];
    if (opts.force) args.push('--force-with-lease');
    if (opts.setUpstream) args.push('-u', opts.setUpstream.remote, opts.setUpstream.branch);
    return this.run(args);
  }

  // ── Working tree ─────────────────────────────────────────

  /** Ignored files and folders (folders end with /), relative to the project. */
  async ignored(): Promise<string[]> {
    const text = await this.out(['status', '--porcelain=v1', '--ignored=matching']);
    return text
      .split('\n')
      .filter((line) => line.startsWith('!! '))
      .map((line) => line.slice(3).replace(/^"|"$/g, ''))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
  }

  /** Add to VCS (git add). */
  async add(paths: string[]) {
    for (const [g, mine] of this.byOwner(paths)) await g.run(['add', '--', ...mine.map((p) => g.rel(p))]);
  }

  /** Undoes local changes: modified/deleted files go back to HEAD; added files leave the index (kept on disk). */
  async rollback(changes: { path: string; status: string }[]) {
    const groups = this.byOwner(changes);
    if (groups.size > 1 || !groups.has(this)) {
      for (const [g, mine] of groups) await g.rollback(mine);
      return;
    }
    const tracked = changes.filter((c) => c.status !== 'A' && c.status !== 'U').map((c) => this.rel(c.path));
    const added = changes.filter((c) => c.status === 'A').map((c) => this.rel(c.path));
    if (tracked.length) await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
    if (added.length) await this.run(['rm', '--cached', '--quiet', '--', ...added]);
  }

  async stashList(): Promise<Stash[]> {
    const text = await this.out(['stash', 'list', `--format=%gd${'%x1f'}%gs${'%x1f'}%aI${'%x1f'}%H`]);
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, message, date, hash] = line.split(SEP);
        return { ref, message, date, hash };
      });
  }

  /**
   * What a stash holds: its changes to tracked files (the stash commit against the commit it was
   * made on) and, when it was made with untracked files, those (its third parent).
   */
  async stashFiles(hash: string): Promise<StashFile[]> {
    const tracked = await this.out(['diff', '--name-status', '-z', '--no-renames', `${hash}^1`, hash]);
    const parts = tracked.split('\0');
    const files: StashFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0] as StashFile['status'], path: `${this.root}/${parts[i + 1]}` });
    const untracked = await this.run(['ls-tree', '-r', '-z', '--name-only', `${hash}^3`], { allowFail: true, quiet: true });
    if (untracked.code === 0) for (const p of untracked.stdout.split('\0').filter(Boolean)) files.push({ status: 'U', path: `${this.root}/${p}` });
    return files;
  }
  stash(message: string, includeUntracked: boolean) {
    return this.run(['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])]);
  }
  unstash(ref: string, pop: boolean) {
    return this.run(['stash', pop ? 'pop' : 'apply', ref]);
  }
  dropStash(ref: string) {
    return this.run(['stash', 'drop', ref]);
  }

  // ── Commit actions (Log context menu) ────────────────────

  /**
   * Squashes fixup! commits into their targets: a non-interactive `rebase -i --autosquash` from the
   * fixed commit's parent (the root when it has none). Other local changes are stashed and restored.
   */
  async autosquash(target: string) {
    const parent = await this.run(['rev-parse', '--verify', '--quiet', `${target}~1`], { allowFail: true, quiet: true });
    const base = parent.code === 0 ? [parent.stdout.trim()] : ['--root'];
    return this.run(['-c', 'sequence.editor=:', 'rebase', '-i', '--autosquash', '--autostash', ...base]);
  }

  reset(hash: string, mode: 'soft' | 'mixed' | 'hard') {
    return this.run(['reset', `--${mode}`, hash]);
  }
  revert(hash: string) {
    return this.run(['revert', '--no-edit', hash]);
  }
  cherryPick(hash: string) {
    return this.run(['cherry-pick', hash]);
  }
  tag(name: string, hash: string) {
    return this.run(['tag', name, hash]);
  }

  // ── Shelf ────────────────────────────────────────────────
  // Changes put aside as named patches, kept in the repository's .git folder (never committed).

  private async gitDir(): Promise<string> {
    return (await this.out(['rev-parse', '--absolute-git-dir'])).trim().replace(/\\/g, '/');
  }

  private async shelfFile() {
    return `${await this.gitDir()}/phpblitz-shelf.json`;
  }

  async shelves(): Promise<Shelf[]> {
    try {
      return JSON.parse(await this.backend.readFile(await this.shelfFile()));
    } catch {
      return [];
    }
  }

  private async saveShelves(list: Shelf[]) {
    // A scratch file of ours, not a project file (no Local History).
    await invoke<void>('write_file', { path: await this.shelfFile(), content: JSON.stringify(list, null, 1) });
  }

  /**
   * Shelves these changes as one patch named `name`. Unless `keep`, the files then go back to HEAD
   * (new ones to the Recycle Bin), as after a rollback.
   */
  async shelve(changes: { path: string; status: string }[], name: string, keep: boolean): Promise<Shelf> {
    if (!isTauri) throw new GitError('The shelf needs the desktop app.');
    const other = this.oneOwner(changes, 'Shelve');
    if (other !== this) return other.shelve(changes, name, keep);
    const rel = changes.map((c) => this.rel(c.path));
    const untracked = changes.filter((c) => c.status === 'U').map((c) => this.rel(c.path));
    // New files show in the diff once git knows they're meant to be added.
    if (untracked.length) await this.run(['add', '--intent-to-add', '--', ...untracked]);
    let patch: string;
    try {
      patch = await this.out(['diff', '--binary', 'HEAD', '--', ...rel]);
    } finally {
      if (untracked.length) await this.run(['reset', '--quiet', '--', ...untracked], { allowFail: true });
    }
    if (!patch.trim()) throw new GitError('There are no changes in these files to shelve.');
    // Each file's text as shelved: unshelving merges it with the file as it is by then.
    const after = await Promise.all(changes.map((c) => (c.status === 'D' ? Promise.resolve(null) : this.backend.readFile(c.path).then((t) => t, () => undefined))));
    const shelf: Shelf = {
      id: String(Date.now()),
      name: name.trim() || `Changes from ${new Date().toLocaleString()}`,
      date: new Date().toISOString(),
      base: (await this.out(['rev-parse', 'HEAD'])).trim(),
      files: changes.map((c, i) => ({ path: this.rel(c.path), status: c.status === 'U' ? 'A' : c.status, ...(after[i] !== undefined ? { after: after[i] } : {}) })),
      applied: [],
      patch,
    };
    await this.saveShelves([shelf, ...(await this.shelves())]);
    if (!keep) {
      const tracked = changes.filter((c) => c.status !== 'U' && c.status !== 'A').map((c) => this.rel(c.path));
      const added = changes.filter((c) => c.status === 'A').map((c) => this.rel(c.path));
      if (tracked.length) await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
      if (added.length) await this.run(['rm', '--cached', '--quiet', '--', ...added]);
      const removed = changes.filter((c) => c.status === 'U' || c.status === 'A').map((c) => c.path);
      if (removed.length) await this.backend.deletePaths(removed);
    }
    return shelf;
  }

  /**
   * Brings back a shelf (or only these of its files, relative paths). Each file is merged three
   * ways: the commit it was shelved on, the file as it is now, and the file as shelved. Lines both
   * changed get conflict markers (returned). Brought-back files leave the shelf; an empty shelf goes.
   */
  async unshelve(id: string, only?: string[]): Promise<{ conflicted: string[] }> {
    const list = await this.shelves();
    const shelf = list.find((s) => s.id === id);
    if (!shelf) throw new GitError('This shelf is gone.');
    const pending = shelf.files.filter((f) => !shelf.applied.includes(f.path));
    const files = only ? pending.filter((f) => only.includes(f.path)) : pending;
    const conflicted: string[] = [];
    const done: string[] = [];
    try {
      for (const f of files) {
        const abs = `${this.root}/${f.path}`;
        if (f.after === undefined) {
          // Not text (an image…): git's own patch, for this file only.
          const scratch = `${await this.gitDir()}/phpblitz-shelf.patch`;
          await invoke<void>('write_file', { path: scratch, content: shelf.patch });
          await this.run(['apply', '--whitespace=nowarn', `--include=${f.path}`, scratch]);
          done.push(f.path);
          continue;
        }
        if (await this.mergeIntoWorkingFile(abs, await this.show(shelf.base, abs), f.after, `Shelf: ${shelf.name}`)) conflicted.push(f.path);
        done.push(f.path);
      }
    } finally {
      const next = { ...shelf, applied: [...shelf.applied, ...done] };
      await this.saveShelves(list.flatMap((s) => (s.id !== id ? [s] : next.applied.length >= next.files.length ? [] : [next])));
    }
    return { conflicted };
  }

  async dropShelf(id: string) {
    await this.saveShelves((await this.shelves()).filter((s) => s.id !== id));
  }

  // ── Patches ──────────────────────────────────────────────

  /** A patch of these changes against HEAD (new files included). */
  async changesPatch(changes: { path: string; status: string }[]): Promise<string> {
    const other = this.oneOwner(changes, 'A patch');
    if (other !== this) return other.changesPatch(changes);
    const rel = changes.map((c) => this.rel(c.path));
    const untracked = changes.filter((c) => c.status === 'U').map((c) => this.rel(c.path));
    if (untracked.length) await this.run(['add', '--intent-to-add', '--', ...untracked]);
    try {
      return await this.out(['diff', '--binary', 'HEAD', '--', ...rel]);
    } finally {
      if (untracked.length) await this.run(['reset', '--quiet', '--', ...untracked], { allowFail: true });
    }
  }

  /** A commit as a patch with its author and message (`git format-patch`): `git am` or Apply Patch takes it. */
  commitPatch(hash: string): Promise<string> {
    return this.out(['format-patch', '-1', '--stdout', '--binary', hash]);
  }

  /**
   * Applies a patch to the working tree. When it doesn't apply as it is (the files changed since,
   * or have other line endings), it's applied to HEAD in an index of its own, and each file's
   * patched version is merged with the working file: lines both changed get conflict markers.
   */
  async applyPatch(patch: string): Promise<{ conflicted: string[] }> {
    if (!isTauri) throw new GitError('Applying a patch needs the desktop app.');
    const dir = await this.gitDir();
    const scratch = `${dir}/phpblitz-apply.patch`;
    await invoke<void>('write_file', { path: scratch, content: patch.endsWith('\n') ? patch : patch + '\n' });
    const plain = await this.run(['apply', '--whitespace=nowarn', scratch], { allowFail: true });
    if (plain.code === 0) return { conflicted: [] };
    const env = { GIT_INDEX_FILE: `${dir}/phpblitz-apply-index` };
    await this.run(['read-tree', 'HEAD'], { env, quiet: true });
    const onHead = await this.run(['apply', '--cached', '--whitespace=nowarn', scratch], { env, allowFail: true });
    if (onHead.code !== 0) throw new GitError(`The patch doesn't apply here: ${(onHead.stderr || plain.stderr).trim()}`);
    const files = [...new Set([...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]))];
    const conflicted: string[] = [];
    for (const rel of files) {
      const abs = `${this.root}/${rel}`;
      const patched = await this.run(['show', `:${rel}`], { env, allowFail: true, quiet: true });
      const conflict = await this.mergeIntoWorkingFile(abs, await this.show('HEAD', abs), patched.code === 0 ? patched.stdout : null, 'Patch');
      if (conflict) conflicted.push(rel);
    }
    return { conflicted };
  }

  /**
   * Brings a file's other version (`after`; null: deleted) into the working file, merged three ways
   * with `base` (what that version started from) and the file as it is. True when lines both
   * changed got conflict markers (or a file deleted there was changed here: it stays).
   */
  private async mergeIntoWorkingFile(abs: string, base: string | null, after: string | null, label: string): Promise<boolean> {
    const current = await this.backend.readFile(abs).then((t) => t, () => null);
    const same = (a: string | null, b: string | null) => (a ?? '').replace(/\r\n/g, '\n') === (b ?? '').replace(/\r\n/g, '\n');
    if (after === null) {
      if (current !== null && !same(current, base)) return true;
      if (current !== null) await this.backend.deletePaths([abs]);
      return false;
    }
    if (current === null || same(current, base)) {
      // Unchanged here: the other version as it is, in the file's own line endings.
      await this.backend.writeFile(abs, current === null ? after : after.replace(/\r?\n/g, eolOf(current)));
      return false;
    }
    const merged = mergeWithMarkers(base ?? '', current, after, { ours: 'Your version', theirs: label });
    await this.backend.writeFile(abs, merged.text);
    return merged.conflicts > 0;
  }

  // ── Comparing ────────────────────────────────────────────

  /** Files that differ between two revisions, or a revision and the working tree (`right` null). */
  async compareFiles(left: string, right: string | null): Promise<FileChange[]> {
    const text = await this.out(['diff', '--name-status', '-z', '-M', left, ...(right ? [right] : []), '--']);
    const parts = text.split('\0').filter((p) => p !== '');
    const out: FileChange[] = [];
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i][0] as FileChange['status'];
      if (s === 'R' || s === 'C') {
        out.push({ status: s, from: `${this.root}/${parts[i + 1]}`, path: `${this.root}/${parts[i + 2]}` });
        i += 2;
      } else out.push({ status: s, path: `${this.root}/${parts[++i]}` });
    }
    return out;
  }

  /** Commits in `b` that aren't in `a` (newest first). */
  commitsBetween(a: string, b: string): Promise<Commit[]> {
    return this.log({ branch: `${a}..${b}`, max: 500 });
  }

  // ── Interactive rebase ───────────────────────────────────

  /**
   * The commits an interactive rebase from `from` goes through: it and every commit after it up
   * to HEAD, oldest first, with their whole messages. Throws when `from` isn't in HEAD's history.
   */
  async rebaseCommits(from: string): Promise<{ commit: Commit; message: string }[]> {
    if ((await this.run(['merge-base', '--is-ancestor', from, 'HEAD'], { allowFail: true, quiet: true })).code !== 0) {
      throw new GitError('This commit isn’t in the current branch’s history.');
    }
    const hasParent = (await this.run(['rev-parse', '--verify', '--quiet', `${from}^`], { allowFail: true, quiet: true })).code === 0;
    const text = await this.out(['log', '--reverse', '--topo-order', `--format=${LOG_FORMAT.replace('%x1e', '%x1f%B%x1e')}`, hasParent ? `${from}^..HEAD` : 'HEAD']);
    return text
      .split(END)
      .map((rec) => rec.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [hash, short, parents, author, email, date, subject, refs, message] = rec.split(SEP);
        const commit = { hash, short, parents: parents ? parents.split(' ') : [], author, email, date, subject, refs: refs ? refs.split(', ').filter(Boolean) : [] };
        return { commit, message: (message ?? subject).trim() };
      });
  }

  /**
   * Runs an interactive rebase from `from` with these steps (no editor opens: the todo list and
   * the new messages are written for git first). Uncommitted changes are set aside and put back.
   */
  async interactiveRebase(from: string, steps: RebaseStep[]) {
    if (!isTauri) throw new GitError('Interactive rebase needs the desktop app.');
    const dir = (await this.out(['rev-parse', '--absolute-git-dir'])).trim().replace(/\\/g, '/');
    const file = (name: string) => `${dir}/phpblitz-rebase-${name}`;
    // Scratch files for git (not project files: no Local History).
    const write = (path: string, content: string) => invoke<void>('write_file', { path, content });
    await Promise.all(steps.map((s, i) => (s.action === 'reword' ? write(file(`msg-${i}`), s.message!.trim() + '\n') : null)));
    await write(file('todo'), rebaseTodo(steps, (i) => file(`msg-${i}`)));
    const hasParent = (await this.run(['rev-parse', '--verify', '--quiet', `${from}^`], { allowFail: true, quiet: true })).code === 0;
    return this.run(['-c', `sequence.editor=cp "${file('todo')}"`, '-c', 'core.editor=:', 'rebase', '-i', '--autostash', hasParent ? `${from}^` : '--root']);
  }

  // ── Conflicts (a merge, rebase, cherry-pick or revert that stopped) ──

  /** A conflicted file's three versions from the index: the common base, ours and theirs (null where that side has no file). */
  async conflictVersions(path: string): Promise<{ base: string | null; ours: string | null; theirs: string | null }> {
    if (this.owner(path) !== this) return this.owner(path).conflictVersions(path);
    const rel = this.rel(path);
    const stage = async (n: number) => {
      const r = await this.run(['show', `:${n}:${rel}`], { allowFail: true, quiet: true });
      return r.code === 0 ? r.stdout : null;
    };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    return { base, ours, theirs };
  }

  /** Marks files resolved as they are on disk; one deleted on disk is resolved as deleted. */
  async markResolved(paths: string[], deleted: string[] = []) {
    for (const [g, mine] of this.byOwner(paths)) await g.run(['add', '--', ...mine.map((p) => g.rel(p))]);
    for (const [g, mine] of this.byOwner(deleted)) await g.run(['rm', '--quiet', '--', ...mine.map((p) => g.rel(p))]);
  }

  /** Accept Yours / Accept Theirs: the whole file from that side, resolved (removed when that side deleted it). */
  async acceptSide(path: string, side: 'ours' | 'theirs', sideDeleted: boolean): Promise<RunResult> {
    if (this.owner(path) !== this) return this.owner(path).acceptSide(path, side, sideDeleted);
    const rel = this.rel(path);
    if (sideDeleted) return this.run(['rm', '--quiet', '--', rel]);
    await this.run(['checkout', `--${side}`, '--', rel]);
    return this.run(['add', '--', rel]);
  }

  /** Continues after the conflicts are resolved, keeping git's prepared commit message (no editor opens). */
  continueOperation(kind: GitOperation['kind']) {
    return this.run(['-c', 'core.editor=:', kind, '--continue']);
  }
  abortOperation(kind: GitOperation['kind']) {
    return this.run([kind, '--abort']);
  }
  /** Rebase, cherry-pick, revert: leaves out the commit that stopped and goes on with the next. */
  skipCommit(kind: GitOperation['kind']) {
    return this.run(['-c', 'core.editor=:', kind, '--skip']);
  }
}

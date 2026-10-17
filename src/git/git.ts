// Git operations for the Git tool window, branches popup, diff and annotations, on top of the
// git CLI (Backend.git). Every command is logged for the Git ▸ Console tab.

import type { Backend, RunResult } from '../backend/types';

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
  ref: string;
  message: string;
  date: string;
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

  constructor(private backend: Backend) {}

  get root() {
    return this.backend.root;
  }

  rel(path: string): string {
    return path.startsWith(this.root + '/') ? path.slice(this.root.length + 1) : path;
  }

  onConsole(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Runs git; throws GitError with git's message when it fails (unless `allowFail`). */
  async run(args: string[], opts: { allowFail?: boolean; quiet?: boolean } = {}): Promise<RunResult> {
    const r = await this.backend.git(['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args]);
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
    let p = this.heads.get(path);
    if (!p) {
      p = this.show('HEAD', path).catch(() => null);
      this.heads.set(path, p);
    }
    return p;
  }

  clearHeads() {
    this.heads.clear();
  }

  /** A file's content at a revision, or null when it doesn't exist there. */
  async show(rev: string, path: string): Promise<string | null> {
    const r = await this.run(['show', `${rev}:${this.rel(path)}`], { allowFail: true, quiet: true });
    return r.code === 0 ? r.stdout : null;
  }

  async blame(path: string): Promise<BlameLine[]> {
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
  add(paths: string[]) {
    return this.run(['add', '--', ...paths.map((p) => this.rel(p))]);
  }

  /** Undoes local changes: modified/deleted files go back to HEAD; added files leave the index (kept on disk). */
  async rollback(changes: { path: string; status: string }[]) {
    const tracked = changes.filter((c) => c.status !== 'A' && c.status !== 'U').map((c) => this.rel(c.path));
    const added = changes.filter((c) => c.status === 'A').map((c) => this.rel(c.path));
    if (tracked.length) await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
    if (added.length) await this.run(['rm', '--cached', '--quiet', '--', ...added]);
  }

  async stashList(): Promise<Stash[]> {
    const text = await this.out(['stash', 'list', `--format=%gd${'%x1f'}%gs${'%x1f'}%aI`]);
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, message, date] = line.split(SEP);
        return { ref, message, date };
      });
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
}

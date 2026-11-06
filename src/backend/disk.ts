import { invoke } from '@tauri-apps/api/core';
import { mergeSource, parseStatusV2, toChanges } from '../git/status';
import { dirMarks } from '../dirMarks';
import { composerShellLine } from '../composer';
import { projectLocalPhp } from '../interpreters';
import type { Backend, CommitOptions, Entry, GitInfo, GitOperation, Package, Problem, RunResult } from './types';

const PACKAGE_NAME = /^[\w.-]+\/[\w.-]+$/;

/** A real project folder, accessed through the Rust commands in src-tauri/src/lib.rs. */
export class DiskBackend implements Backend {
  readonly kind = 'disk' as const;
  readonly root: string;
  readonly name: string;
  /** Opened in Restricted Mode (trust.ts): set before the workspace starts. */
  restricted = false;

  constructor(root: string) {
    this.root = root.replace(/\\/g, '/').replace(/\/+$/, '');
    this.name = this.root.split('/').pop() || this.root;
  }

  private proc(program: string, args: string[]): Promise<RunResult> {
    return invoke<RunResult>('run_process', { cwd: this.root, program, args });
  }

  private rel(path: string): string {
    return path.startsWith(this.root + '/') ? path.slice(this.root.length + 1) : path;
  }

  listDir(path: string) {
    return invoke<Entry[]>('list_dir', { path });
  }

  /** Every file, without tool and generated folders, vendor/, and the folders marked Excluded. */
  listFiles() {
    return invoke<string[]>('list_files', { root: this.root, excludes: dirMarks.excludedFolders() });
  }

  readFile(path: string) {
    return invoke<string>('read_file', { path });
  }

  readBinary(path: string) {
    return invoke<ArrayBuffer>('read_binary', { path });
  }

  writeFile(path: string, content: string) {
    return invoke<void>('write_file', { path, content, root: this.root });
  }

  createFile(path: string, content: string) {
    return invoke<void>('create_file', { path, content });
  }

  createDir(path: string) {
    return invoke<void>('create_dir', { path });
  }

  renamePath(from: string, to: string) {
    return invoke<void>('rename_path', { from, to });
  }

  copyPath(from: string, to: string) {
    return invoke<void>('copy_path', { from, to });
  }

  deletePaths(paths: string[]) {
    return invoke<void>('delete_to_trash', { paths });
  }

  async gitInfo(): Promise<GitInfo | null> {
    let status: RunResult;
    try {
      // One call for the branch and the changes; -z keeps non-ASCII and quoted paths intact.
      status = await this.proc('git', ['status', '--porcelain=v2', '--branch', '-z', '-uall']);
    } catch {
      return null;
    }
    if (status.code !== 0) return null;
    const parsed = parseStatusV2(status.stdout);
    const operation = await this.gitOperation().catch(() => undefined);
    return { branch: parsed.branch, changes: toChanges(this.root, parsed), ...(operation ? { operation } : {}) };
  }

  /**
   * A commit where some files go in only partly. It's built in an index file of its own (from HEAD,
   * plus the chosen files, plus the partial files' texts), so what's staged otherwise stays out of
   * it, as with `git commit -- <files>`. Afterwards the real index has the committed files as HEAD.
   */
  private async commitPartial(rel: string[], partial: Record<string, string>, args: string[]): Promise<RunResult> {
    const dir = await this.gitDirPath();
    if (!dir) throw new Error('Not a Git repository');
    const env = { GIT_INDEX_FILE: `${dir}/phpblitz-commit-index` };
    const git = async (a: string[]) => {
      const r = await invoke<RunResult>('run_process', { cwd: this.root, program: 'git', args: a, env });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${a[0]} failed`);
      return r;
    };
    const hasHead = (await this.proc('git', ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    await git(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty']);
    const partRel = new Set(Object.keys(partial).map((p) => this.rel(p)));
    const whole = rel.filter((r) => !partRel.has(r));
    // -A: a deleted file is staged as deleted.
    if (whole.length) await git(['add', '-A', '--', ...whole]);
    const scratch = `${dir}/phpblitz-partial`;
    for (const [path, text] of Object.entries(partial)) {
      const r = this.rel(path);
      // Without the project root: a scratch file, not a version for Local History.
      await invoke<void>('write_file', { path: scratch, content: text });
      // --path: the file's own filters (line endings) apply, as `git add` would.
      const blob = (await git(['hash-object', '-w', '--path', r, scratch])).stdout.trim();
      const mode = (await git(['ls-files', '-s', '--', r])).stdout.split(' ')[0] || '100644';
      await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${r}`]);
    }
    const commit = await invoke<RunResult>('run_process', { cwd: this.root, program: 'git', args, env });
    // The real index: the committed files as the new HEAD has them (the rest of a partial file stays a change).
    if (commit.code === 0) await this.proc('git', ['reset', '-q', '--', ...rel]);
    return commit;
  }

  private async gitDirPath(): Promise<string | null> {
    this.gitDir ??= this.proc('git', ['rev-parse', '--absolute-git-dir']).then(
      (r) => (r.code === 0 ? r.stdout.trim().replace(/\\/g, '/') : null),
      () => null,
    );
    return this.gitDir;
  }

  /** The repository's .git folder (a worktree's is elsewhere); asked of git once. */
  private gitDir: Promise<string | null> | null = null;

  /** A merge, rebase, cherry-pick or revert in progress: the files git keeps in its folder meanwhile. */
  private async gitOperation(): Promise<GitOperation | undefined> {
    const dir = await this.gitDirPath();
    if (!dir) return undefined;
    const names = new Set((await this.listDir(dir)).map((e) => e.name));
    const read = (name: string) => this.readFile(`${dir}/${name}`).then((t) => t.trim(), () => '');
    const rebase = names.has('rebase-merge') ? 'rebase-merge' : names.has('rebase-apply') ? 'rebase-apply' : null;
    if (rebase) {
      const [head, step, total] = await Promise.all([read(`${rebase}/head-name`), read(`${rebase}/${rebase === 'rebase-merge' ? 'msgnum' : 'next'}`), read(`${rebase}/${rebase === 'rebase-merge' ? 'end' : 'last'}`)]);
      return { kind: 'rebase', branch: head.replace(/^refs\/heads\//, '') || undefined, step: step && total ? `${step}/${total}` : undefined };
    }
    if (names.has('MERGE_HEAD')) return { kind: 'merge', incoming: mergeSource(await read('MERGE_MSG')) };
    if (names.has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', incoming: (await read('CHERRY_PICK_HEAD')).slice(0, 8) || undefined };
    if (names.has('REVERT_HEAD')) return { kind: 'revert', incoming: (await read('REVERT_HEAD')).slice(0, 8) || undefined };
    return undefined;
  }

  git(args: string[], env?: Record<string, string>): Promise<RunResult> {
    return env ? invoke<RunResult>('run_process', { cwd: this.root, program: 'git', args, env }) : this.proc('git', args);
  }

  gh(args: string[]): Promise<RunResult> {
    // Never a prompt (there's no terminal to answer it), no colors, no "new version" notes.
    const env = { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1' };
    return invoke<RunResult>('run_process', { cwd: this.root, program: 'gh', args, env });
  }

  async lastCommitMessage(): Promise<string | null> {
    const r = await this.proc('git', ['log', '-1', '--format=%B']).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() : null;
  }

  async gitCommit(paths: string[], message: string, push: boolean, options: CommitOptions = {}): Promise<string> {
    const rel = paths.map((p) => this.rel(p));
    const args = ['commit'];
    if (options.amend) args.push('--amend');
    if (options.signOff) args.push('--signoff');
    // A fixup commit's message is "fixup! <subject>"; anything typed becomes its body.
    if (options.fixup) args.push(`--fixup=${options.fixup}`);
    if (!options.fixup || message) args.push('-m', message);
    let commit: RunResult;
    if (options.partial && Object.keys(options.partial).length) {
      commit = await this.commitPartial(rel, options.partial, args);
    } else {
      if (rel.length) {
        const add = await this.proc('git', ['add', '--', ...rel]);
        if (add.code !== 0) throw new Error(add.stderr || add.stdout);
      }
      commit = await this.proc('git', [...args, ...(rel.length ? ['--', ...rel] : [])]);
    }
    if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout);
    if (push) {
      const pushed = await this.proc('git', ['push']);
      if (pushed.code !== 0) throw new Error('Committed, but push failed: ' + (pushed.stderr || pushed.stdout));
    }
    return commit.stdout.split('\n')[0];
  }

  async packages(): Promise<Package[]> {
    let manifest: Record<string, Record<string, string>>;
    try {
      manifest = JSON.parse(await this.readFile(`${this.root}/composer.json`));
    } catch {
      return [];
    }
    const installed: Record<string, string> = {};
    try {
      const lock = JSON.parse(await this.readFile(`${this.root}/composer.lock`));
      for (const p of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) installed[p.name] = p.version;
    } catch {
      // No lock file yet: fall back to the constraints from composer.json.
    }
    const list: Package[] = [];
    for (const kind of ['require', 'require-dev'] as const) {
      for (const [name, constraint] of Object.entries(manifest[kind] ?? {})) {
        if (name === 'php' || name.startsWith('ext-')) continue;
        list.push({ name, version: installed[name] ?? String(constraint), kind });
      }
    }
    return list;
  }

  async checkOutdated(): Promise<Record<string, string>> {
    const r = await this.shell(await composerShellLine(this.root, ['outdated', '--direct', '--format=json']));
    if (!r.stdout.trim()) throw new Error(r.stderr.trim() || 'composer outdated failed. Is Composer installed?');
    const data = JSON.parse(r.stdout);
    const out: Record<string, string> = {};
    for (const p of data.installed ?? []) out[p.name] = p.latest;
    return out;
  }

  async updatePackage(name: string | null): Promise<void> {
    if (name !== null && !PACKAGE_NAME.test(name)) throw new Error(`Invalid package name: ${name}`);
    const r = await this.shell(await composerShellLine(this.root, name ? ['update', name] : ['update']));
    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  }

  async lint(path: string): Promise<Problem[]> {
    let r: RunResult;
    try {
      r = await this.proc(projectLocalPhp(this.root) ?? 'php', ['-l', path]);
    } catch {
      return []; // PHP is not installed; reported once through notifications.
    }
    if (r.code === 0) return [];
    const text = `${r.stdout}\n${r.stderr}`;
    const m = text.match(/(Parse error|Fatal error):\s*(.+?) in .+? on line (\d+)/);
    return [
      {
        path,
        line: m ? Number(m[3]) : 1,
        message: m ? m[2] : text.trim().split('\n')[0],
        severity: 'error',
      },
    ];
  }

  shell(line: string, cwd?: string) {
    return invoke<RunResult>('run_shell', { cwd: cwd ?? this.root, line });
  }

  async phpVersion(): Promise<string | null> {
    try {
      const r = await this.proc('php', ['-r', 'echo PHP_VERSION;']);
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }
}

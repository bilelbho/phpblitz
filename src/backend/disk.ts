import { invoke } from '@tauri-apps/api/core';
import { parseStatusV2, toChanges } from '../git/status';
import { dirMarks } from '../dirMarks';
import { composerShellLine } from '../composer';
import { projectLocalPhp } from '../interpreters';
import type { Backend, CommitOptions, Entry, GitInfo, Package, Problem, RunResult } from './types';

const PACKAGE_NAME = /^[\w.-]+\/[\w.-]+$/;

/** A real project folder, accessed through the Rust commands in src-tauri/src/lib.rs. */
export class DiskBackend implements Backend {
  readonly kind = 'disk' as const;
  readonly root: string;
  readonly name: string;

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
    return { branch: parsed.branch, changes: toChanges(this.root, parsed) };
  }

  git(args: string[]): Promise<RunResult> {
    return this.proc('git', args);
  }

  async lastCommitMessage(): Promise<string | null> {
    const r = await this.proc('git', ['log', '-1', '--format=%B']).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() : null;
  }

  async gitCommit(paths: string[], message: string, push: boolean, options: CommitOptions = {}): Promise<string> {
    const rel = paths.map((p) => this.rel(p));
    if (rel.length) {
      const add = await this.proc('git', ['add', '--', ...rel]);
      if (add.code !== 0) throw new Error(add.stderr || add.stdout);
    }
    const args = ['commit'];
    if (options.amend) args.push('--amend');
    if (options.signOff) args.push('--signoff');
    // A fixup commit's message is "fixup! <subject>"; anything typed becomes its body.
    if (options.fixup) args.push(`--fixup=${options.fixup}`);
    if (!options.fixup || message) args.push('-m', message);
    const commit = await this.proc('git', [...args, ...(rel.length ? ['--', ...rel] : [])]);
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

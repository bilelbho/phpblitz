// Everything the UI needs from "the outside world" goes through this interface.
// DiskBackend talks to the Rust side; SampleBackend is an in-memory demo project.
// When the Rust analysis engine exists, it plugs in here too.

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  /** Last modification time (ms since 1970); 0 when unknown. */
  modified?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** M = modified, A = added, D = deleted, R = renamed, U = unversioned */
export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'U';

export interface GitChange {
  path: string;
  status: ChangeStatus;
}

export interface CommitOptions {
  amend?: boolean;
  signOff?: boolean;
  /** Hash of the commit this one fixes: `git commit --fixup` (the message is generated). */
  fixup?: string;
}

export interface GitInfo {
  branch: string;
  changes: GitChange[];
}

export interface Package {
  name: string;
  version: string;
  kind: 'require' | 'require-dev';
}

export interface Problem {
  path: string;
  line: number;
  /** 1-based; when missing the whole line is marked. */
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** Rule or check id, e.g. "undefined-variable". */
  code?: string;
  /** Who reported it, e.g. "Mago analyzer". */
  source?: string;
  help?: string;
  /** Mago's kind of check, used in `@mago-expect <category>:<code>` comments. */
  category?: 'syntax' | 'lint' | 'analysis';
  /** Automatic fixes offered by the checker. */
  fixes?: {
    title: string;
    safety: 'safe' | 'potentially-unsafe' | 'unsafe';
    edits: { line: number; column: number; endLine: number; endColumn: number; text: string }[];
  }[];
}

export interface Backend {
  readonly kind: 'disk' | 'sample';
  /** Absolute project root, forward slashes, no trailing slash. */
  readonly root: string;
  /** Opened in Restricted Mode (trust.ts): no program runs in it. */
  restricted?: boolean;
  readonly name: string;

  listDir(path: string): Promise<Entry[]>;
  /** All project files, excluding vendor/, node_modules/ and .git/. */
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** A file's bytes as they are (images). */
  readBinary(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, content: string): Promise<void>;
  /** Creates a file; rejects if it already exists. */
  createFile(path: string, content: string): Promise<void>;
  /** Creates a directory; rejects if it already exists. */
  createDir(path: string): Promise<void>;
  /** Renames or moves a file/folder; rejects if the target exists. */
  renamePath(from: string, to: string): Promise<void>;
  /** Copies a file/folder; rejects if the target exists. */
  copyPath(from: string, to: string): Promise<void>;
  /** Deletes to the Recycle Bin (disk) so it can be restored. */
  deletePaths(paths: string[]): Promise<void>;

  /** null when the project is not a Git repository or git is missing. */
  gitInfo(): Promise<GitInfo | null>;
  /** Returns a one-line summary; throws with git's message on failure. */
  gitCommit(paths: string[], message: string, push: boolean, options?: CommitOptions): Promise<string>;
  /** Message of the last commit, for "Amend last commit". */
  lastCommitMessage(): Promise<string | null>;
  /** Runs git with these arguments in the project (git/git.ts builds on this). */
  git(args: string[]): Promise<RunResult>;

  packages(): Promise<Package[]>;
  /** Package name → latest version, for direct dependencies that are outdated. */
  checkOutdated(): Promise<Record<string, string>>;
  updatePackage(name: string | null): Promise<void>;

  lint(path: string, content: string): Promise<Problem[]>;
  /** Runs a command line; `cwd` defaults to the project root. */
  shell(line: string, cwd?: string): Promise<RunResult>;
  phpVersion(): Promise<string | null>;
}

export function relativePath(backend: Backend, path: string): string {
  return path.startsWith(backend.root + '/') ? path.slice(backend.root.length + 1) : path;
}

export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

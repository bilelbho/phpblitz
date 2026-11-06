// GitHub pull requests, through the GitHub CLI (gh): it has its own sign-in (`gh auth login`), so
// PHPBlitz never sees or keeps a token. The repository is the one gh finds from the project's remotes.

import { invoke } from '@tauri-apps/api/core';
import type { Backend } from '../backend/types';
import type { Git } from './git';

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PullRequest {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  url: string;
  reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}

/** A check (GitHub Actions job) or a commit status, as gh reports them. */
export interface Check {
  __typename: 'CheckRun' | 'StatusContext';
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface PrComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface PrReview {
  author: { login: string };
  body: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string;
}

export interface PrDetails extends PullRequest {
  body: string;
  headRefOid: string;
  baseRefOid: string;
  isCrossRepository: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number; changeType: string }[];
  commits: { oid: string; messageHeadline: string; authors: { login: string; name: string }[] }[];
  comments: PrComment[];
  reviews: PrReview[];
  statusCheckRollup: Check[];
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** gh is missing, not signed in, or ready (with the account). */
export type GhStatus = { kind: 'missing' } | { kind: 'signed-out'; message: string } | { kind: 'ready'; account: string };

export class GhError extends Error {}

const LIST_FIELDS = 'number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,url,reviewDecision';
const DETAIL_FIELDS = `${LIST_FIELDS},body,headRefOid,baseRefOid,isCrossRepository,mergeable,additions,deletions,files,commits,comments,reviews,statusCheckRollup`;

export class GitHub {
  constructor(
    private readonly backend: Backend,
    private readonly git: Git,
  ) {}

  private async run(args: string[]): Promise<string> {
    let r;
    try {
      r = await this.backend.gh(args);
    } catch {
      throw new GhError('The GitHub CLI (gh) was not found. Install it from cli.github.com, then sign in with `gh auth login`.');
    }
    if (r.code !== 0) throw new GhError((r.stderr || r.stdout).trim() || `gh ${args[0]} failed`);
    return r.stdout;
  }

  async status(): Promise<GhStatus> {
    let r;
    try {
      r = await this.backend.gh(['auth', 'status', '--active']);
    } catch {
      return { kind: 'missing' };
    }
    if (r.code === 127) return { kind: 'missing' };
    const text = `${r.stdout}\n${r.stderr}`;
    const account = text.match(/account\s+(\S+)/)?.[1];
    // Only the account: gh prints a masked token line too, which isn't shown anywhere.
    return r.code === 0 && account ? { kind: 'ready', account } : { kind: 'signed-out', message: 'Not signed in to GitHub. Run `gh auth login` in a terminal, then refresh.' };
  }

  async list(state: 'open' | 'closed' | 'merged' | 'all', search: string): Promise<PullRequest[]> {
    const args = ['pr', 'list', '--state', state, '--limit', '100', '--json', LIST_FIELDS];
    if (search.trim()) args.push('--search', search.trim());
    return JSON.parse(await this.run(args));
  }

  async view(n: number): Promise<PrDetails> {
    return JSON.parse(await this.run(['pr', 'view', String(n), '--json', DETAIL_FIELDS]));
  }

  /**
   * The pull request's commits here (fetched once, kept under refs/phpblitz/pr/N), and where its
   * branch left the base: a file's changes are that point vs the pull request's head.
   */
  async revisions(pr: PrDetails): Promise<{ base: string; head: string }> {
    const has = async (oid: string) => (await this.git.run(['cat-file', '-e', `${oid}^{commit}`], { allowFail: true, quiet: true })).code === 0;
    const remote = await this.remoteName();
    if (!(await has(pr.headRefOid))) await this.git.run(['fetch', '--no-tags', remote, `+refs/pull/${pr.number}/head:refs/phpblitz/pr/${pr.number}`]);
    if (!(await has(pr.baseRefOid))) await this.git.run(['fetch', '--no-tags', remote, pr.baseRefName]);
    const base = (await this.git.run(['merge-base', pr.baseRefOid, pr.headRefOid], { quiet: true })).stdout.trim();
    return { base: base || pr.baseRefOid, head: pr.headRefOid };
  }

  private async remoteName(): Promise<string> {
    const remotes = (await this.git.run(['remote'], { quiet: true })).stdout.split('\n').filter(Boolean);
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
  }

  /** The repository's default branch on GitHub ("main"). */
  async defaultBranch(): Promise<string | null> {
    const out = await this.run(['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']).catch(() => '');
    return out.trim() || null;
  }

  /** Checks the pull request's branch out here (a branch of its own; a fork's too). */
  checkout(n: number) {
    return this.run(['pr', 'checkout', String(n)]);
  }

  comment(n: number, body: string) {
    return this.withBody(body, (file) => this.run(['pr', 'comment', String(n), '--body-file', file]));
  }

  review(n: number, kind: 'approve' | 'request-changes' | 'comment', body: string) {
    if (!body.trim() && kind !== 'approve') throw new GhError('Write what to change (or a comment) first.');
    return this.withBody(body, (file) => this.run(['pr', 'review', String(n), `--${kind}`, '--body-file', file]));
  }

  merge(n: number, method: MergeMethod, deleteBranch: boolean) {
    return this.run(['pr', 'merge', String(n), `--${method}`, ...(deleteBranch ? ['--delete-branch'] : [])]);
  }

  close(n: number) {
    return this.run(['pr', 'close', String(n)]);
  }

  /** Opens a pull request for `head` (pushed already) into `base`; returns its address. */
  async create(opts: { base: string; head: string; title: string; body: string; draft: boolean }): Promise<string> {
    const out = await this.withBody(opts.body, (file) =>
      this.run(['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body-file', file, ...(opts.draft ? ['--draft'] : [])]),
    );
    return out.trim().split('\n').pop() ?? '';
  }

  /** Texts go through a scratch file in .git (as arguments, newlines and quotes would get mangled on Windows). */
  private async withBody<T>(body: string, run: (file: string) => Promise<T>): Promise<T> {
    const dir = (await this.git.run(['rev-parse', '--absolute-git-dir'], { quiet: true })).stdout.trim().replace(/\\/g, '/');
    const file = `${dir}/phpblitz-pr-body.md`;
    await invoke<void>('write_file', { path: file, content: body });
    return run(file);
  }
}

/** How a pull request's checks went: counts, and the overall look. */
export function checksSummary(checks: Check[]): { passed: number; failed: number; pending: number; overall: 'passed' | 'failed' | 'pending' | 'none' } {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    const result = (c.conclusion || c.state || '').toUpperCase();
    if (c.__typename === 'CheckRun' && c.status !== 'COMPLETED') pending++;
    else if (result === 'SUCCESS' || result === 'NEUTRAL' || result === 'SKIPPED') passed++;
    else if (result === 'PENDING' || result === 'EXPECTED' || !result) pending++;
    else failed++;
  }
  const overall = failed ? 'failed' : pending ? 'pending' : passed ? 'passed' : 'none';
  return { passed, failed, pending, overall };
}

/** A check's state as one word: passed, failed, pending (or skipped). */
export function checkState(c: Check): 'passed' | 'failed' | 'pending' | 'skipped' {
  const result = (c.conclusion || c.state || '').toUpperCase();
  if (c.__typename === 'CheckRun' && c.status !== 'COMPLETED') return 'pending';
  if (result === 'SKIPPED' || result === 'NEUTRAL') return 'skipped';
  if (result === 'SUCCESS') return 'passed';
  if (result === 'PENDING' || result === 'EXPECTED' || !result) return 'pending';
  return 'failed';
}

/** The label a pull request's state shows with: Draft, Open, Merged or Closed. */
export function stateLabel(pr: Pick<PullRequest, 'state' | 'isDraft'>): 'Draft' | 'Open' | 'Merged' | 'Closed' {
  if (pr.state === 'MERGED') return 'Merged';
  if (pr.state === 'CLOSED') return 'Closed';
  return pr.isDraft ? 'Draft' : 'Open';
}

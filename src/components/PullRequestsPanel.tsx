// Git tool window ▸ Pull Requests: the GitHub repository's pull requests (through gh, git/github.ts).
// A list with a state filter and search; the selected one's details: checks, description and
// conversation, changed files (double-click: the diff), commits; and comment, review, merge.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Workspace } from '../useWorkspace';
import { baseName } from '../backend/types';
import { confirmDialog } from '../platform';
import { checkState, checksSummary, GitHub, stateLabel, type GhStatus, type MergeMethod, type PrDetails, type PullRequest } from '../git/github';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

type StateFilter = 'open' | 'closed' | 'merged' | 'all';
type DetailTab = 'overview' | 'files' | 'commits';

const openUrl = (url: string) => void invoke('open_external', { url }).catch(() => window.open(url, '_blank'));
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e);

/** "3 hours ago", "2 days ago"… */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const [n, unit] =
    s < 60 ? [s, 'second'] : s < 3600 ? [s / 60, 'minute'] : s < 86400 ? [s / 3600, 'hour'] : s < 2592000 ? [s / 86400, 'day'] : s < 31536000 ? [s / 2592000, 'month'] : [s / 31536000, 'year'];
  const k = Math.floor(n);
  return k < 1 && unit === 'second' ? 'just now' : `${k} ${unit}${k === 1 ? '' : 's'} ago`;
}

/** GitHub-flavored Markdown, sanitized; links open in the browser. */
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || '', { gfm: true, async: false }) as string), [text]);
  const click = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) openUrl(href);
  };
  if (!text.trim()) return <div className="muted pr-empty-text">No description.</div>;
  return <div className="pr-markdown" onClick={click} dangerouslySetInnerHTML={{ __html: html }} />;
}

function StateBadge({ pr }: { pr: Pick<PullRequest, 'state' | 'isDraft'> }) {
  const label = stateLabel(pr);
  return <span className={`pr-state pr-state-${label.toLowerCase()}`}>{label}</span>;
}

export function PullRequestsPanel({ ws }: { ws: Workspace }) {
  const github = useMemo(() => new GitHub(ws.backend, ws.gitRepo), [ws.backend, ws.gitRepo]);
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [filter, setFilter] = useState<StateFilter>('open');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [list, setList] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const s = await github.status();
    setStatus(s);
    if (s.kind !== 'ready') return;
    try {
      const prs = await github.list(filter, search);
      setList(prs);
      setSelected((n) => (n !== null && prs.some((p) => p.number === n) ? n : (prs[0]?.number ?? null)));
    } catch (e) {
      setList([]);
      setError(errorText(e));
    }
  }, [github, filter, search]);
  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  if (status?.kind === 'missing' || status?.kind === 'signed-out') {
    return (
      <div className="empty pr-setup">
        {status.kind === 'missing' ? 'Pull requests need the GitHub CLI (gh).' : status.message}
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {status.kind === 'missing' ? (
            <>
              Install it from{' '}
              <button type="button" className="link-btn" onClick={() => openUrl('https://cli.github.com/')}>
                cli.github.com
              </button>
              , sign in with <code>gh auth login</code> in a terminal, then refresh. PHPBlitz uses gh's sign-in: it never sees your token.
            </>
          ) : (
            'PHPBlitz uses the GitHub CLI’s sign-in: it never sees your token.'
          )}
        </div>
        <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={() => void load()}>
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="pr-panel">
      <div className="pr-split">
        <div className="pr-list-pane">
          <div className="tw-toolbar pr-toolbar">
            <select aria-label="State" value={filter} onChange={(e) => setFilter(e.target.value as StateFilter)}>
              <option value="open">Open</option>
              <option value="merged">Merged</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
            <div className="field pr-search">
              <Icon name="search" size={13} />
              <input
                placeholder="Search (author:me, label:bug…)"
                aria-label="Search pull requests"
                value={searchInput}
                spellCheck={false}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && setSearch(searchInput)}
              />
            </div>
            <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
              <Icon name="refresh" size={14} />
            </button>
            <button type="button" className="icon-btn" aria-label="Create pull request" title="Create Pull Request…" onClick={() => ws.setGitDialog({ kind: 'createPr' })}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          <div className="panel-body pr-list" role="listbox" aria-label="Pull requests">
            {list === null && !error && <div className="muted gl-pad">Loading…</div>}
            {error && <div className="te-error pr-error">{error}</div>}
            {list?.length === 0 && !error && (
              <div className="muted gl-pad">
                No {filter === 'all' ? '' : filter + ' '}pull requests{search ? ' match' : ''}.
              </div>
            )}
            {list?.map((pr) => (
              <div
                key={pr.number}
                role="option"
                aria-selected={selected === pr.number}
                className={'pr-row' + (selected === pr.number ? ' selected' : '')}
                onClick={() => setSelected(pr.number)}
                title={`#${pr.number} ${pr.title}\n${pr.headRefName} → ${pr.baseRefName}`}
              >
                <div className="pr-row-title">
                  <StateBadge pr={pr} />
                  <span className="pr-row-name">{pr.title}</span>
                </div>
                <div className="muted pr-row-meta">
                  #{pr.number} · {pr.author.login} · {ago(pr.updatedAt)}
                  {pr.reviewDecision === 'APPROVED' && <span className="pr-review approved"> · Approved</span>}
                  {pr.reviewDecision === 'CHANGES_REQUESTED' && <span className="pr-review changes"> · Changes requested</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="pr-details-pane">
          {selected !== null ? <PrDetailsView key={selected} ws={ws} github={github} number={selected} onChanged={() => void load()} /> : <div className="muted gl-pad">Select a pull request.</div>}
        </div>
      </div>
    </div>
  );
}

function PrDetailsView({ ws, github, number, onChanged }: { ws: Workspace; github: GitHub; number: number; onChanged: () => void }) {
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [showChecks, setShowChecks] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [deleteBranch, setDeleteBranch] = useState(true);

  const load = useCallback(() => {
    github.view(number).then(setPr, (e) => setError(errorText(e)));
  }, [github, number]);
  useEffect(load, [load]);

  /** Runs a GitHub action; afterwards the pull request (and the list) are read again. */
  const act = async (label: string, run: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await run();
      if (done) ws.setStatus(done);
      load();
      onChanged();
      return true;
    } catch (e) {
      ws.notify({ title: `Couldn't ${label.toLowerCase()}`, body: errorText(e), tone: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  /** A changed file: where the branch left the base vs the pull request's head (fetched if needed). */
  const showDiff = async (path: string) => {
    if (!pr) return;
    setBusy('Fetching');
    try {
      const { base, head } = await github.revisions(pr);
      ws.openDiff(`${ws.gitRepo.root}/${path}`, head, base);
    } catch (e) {
      ws.notify({ title: "Couldn't get the pull request's commits", body: errorText(e), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="te-error pr-error">{error}</div>;
  if (!pr) return <div className="muted gl-pad">Loading #{number}…</div>;

  const checks = checksSummary(pr.statusCheckRollup ?? []);
  const timeline = [
    ...pr.comments.map((c) => ({ kind: 'comment' as const, author: c.author.login, body: c.body, date: c.createdAt })),
    ...pr.reviews.filter((r) => r.state !== 'PENDING' && (r.body || r.state !== 'COMMENTED')).map((r) => ({ kind: r.state, author: r.author.login, body: r.body, date: r.submittedAt })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const open = pr.state === 'OPEN';

  return (
    <div className="pr-details">
      <div className="pr-head">
        <div className="pr-title">
          {pr.title} <span className="muted">#{pr.number}</span>
        </div>
        <div className="pr-sub">
          <StateBadge pr={pr} />
          <span className="muted">
            {pr.author.login} wants to merge <span className="mono pr-ref">{pr.headRefName}</span> into <span className="mono pr-ref">{pr.baseRefName}</span>
          </span>
        </div>
        <div className="pr-actions">
          <button type="button" className="btn small" onClick={() => openUrl(pr.url)}>
            <Icon name="goTo" size={12} /> Open on GitHub
          </button>
          {open && (
            <button type="button" className="btn small" disabled={!!busy} onClick={() => void ws.runGit(`Checkout #${pr.number}`, () => github.checkout(pr.number))}>
              Checkout
            </button>
          )}
          <span className="grow" />
          <span className="muted pr-counts">
            <span className="pr-add">+{pr.additions}</span> <span className="pr-del">−{pr.deletions}</span> · {pr.files.length} {pr.files.length === 1 ? 'file' : 'files'}
          </span>
        </div>
        {checks.overall !== 'none' && (
          <button type="button" className={`pr-checks pr-checks-${checks.overall}`} aria-expanded={showChecks} onClick={() => setShowChecks((s) => !s)}>
            <span className={'chev' + (showChecks ? ' open' : '')}>
              <Icon name="chevronRight" size={11} />
            </span>
            {checks.overall === 'passed' ? 'All checks passed' : checks.overall === 'failed' ? `${checks.failed} ${checks.failed === 1 ? 'check' : 'checks'} failed` : 'Checks running'}
            <span className="muted">
              {' '}
              ({checks.passed} passed{checks.failed ? `, ${checks.failed} failed` : ''}
              {checks.pending ? `, ${checks.pending} pending` : ''})
            </span>
          </button>
        )}
        {showChecks && (
          <div className="pr-check-list">
            {pr.statusCheckRollup.map((c, i) => {
              const state = checkState(c);
              const url = c.detailsUrl ?? c.targetUrl;
              return (
                <div key={i} className="pr-check">
                  <span className={`pr-dot ${state}`} aria-label={state} />
                  <span>{c.workflowName ? `${c.workflowName} / ${c.name}` : (c.name ?? c.context)}</span>
                  <span className="muted">{state}</span>
                  {url && (
                    <button type="button" className="link-btn" onClick={() => openUrl(url)}>
                      Details
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="pr-tabs" role="tablist">
        {(['overview', 'files', 'commits'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={'tw-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : t === 'files' ? `Files (${pr.files.length})` : `Commits (${pr.commits.length})`}
          </button>
        ))}
        {busy && <span className="muted pr-busy">{busy}…</span>}
      </div>

      <div className="pr-body">
        {tab === 'overview' && (
          <>
            <div className="pr-post">
              <div className="pr-post-head">
                <b>{pr.author.login}</b>
              </div>
              <Markdown text={pr.body} />
            </div>
            {timeline.map((t, i) => (
              <div key={i} className={`pr-post pr-post-${t.kind.toLowerCase()}`}>
                <div className="pr-post-head">
                  <b>{t.author}</b>{' '}
                  <span className="muted">
                    {t.kind === 'APPROVED' ? 'approved' : t.kind === 'CHANGES_REQUESTED' ? 'requested changes' : t.kind === 'DISMISSED' ? 'review dismissed' : 'commented'} · {ago(t.date)}
                  </span>
                </div>
                {t.body && <Markdown text={t.body} />}
              </div>
            ))}
            {open && (
              <div className="pr-reply">
                <textarea rows={3} value={comment} placeholder="Leave a comment (Markdown)" aria-label="Comment" onChange={(e) => setComment(e.target.value)} />
                <div className="pr-reply-buttons">
                  <button
                    type="button"
                    className="btn small"
                    disabled={!!busy || !comment.trim()}
                    onClick={() => void act('Comment', () => github.comment(pr.number, comment), 'Comment posted').then((ok) => ok && setComment(''))}
                  >
                    Comment
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!!busy}
                    title="Approve (the comment, if any, goes with it)"
                    onClick={() => void act('Approve', () => github.review(pr.number, 'approve', comment), 'Approved').then((ok) => ok && setComment(''))}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!!busy || !comment.trim()}
                    title="Request changes (write what in the comment)"
                    onClick={() => void act('Request changes', () => github.review(pr.number, 'request-changes', comment), 'Changes requested').then((ok) => ok && setComment(''))}
                  >
                    Request Changes
                  </button>
                  <span className="grow" />
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={!!busy}
                    onClick={async () => {
                      if (await confirmDialog(`Close #${pr.number} "${pr.title}" without merging?`)) void act('Close', () => github.close(pr.number), `Closed #${pr.number}`);
                    }}
                  >
                    Close
                  </button>
                </div>
                <div className="pr-merge">
                  <select aria-label="Merge method" value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)}>
                    <option value="squash">Squash and merge</option>
                    <option value="merge">Create a merge commit</option>
                    <option value="rebase">Rebase and merge</option>
                  </select>
                  <label className="settings-check">
                    <input type="checkbox" className="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                    Delete the branch
                  </label>
                  <span className="grow" />
                  {pr.mergeable === 'CONFLICTING' && <span className="pr-conflicts">Has conflicts with {pr.baseRefName}</span>}
                  <button
                    type="button"
                    className="btn small primary"
                    disabled={!!busy || pr.isDraft || pr.mergeable === 'CONFLICTING'}
                    title={pr.isDraft ? 'A draft: mark it ready on GitHub first' : undefined}
                    onClick={async () => {
                      if (await confirmDialog(`Merge #${pr.number} "${pr.title}" into ${pr.baseRefName}?`))
                        void act('Merge', () => github.merge(pr.number, method, deleteBranch), `Merged #${pr.number}`);
                    }}
                  >
                    Merge
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {tab === 'files' && (
          <div className="tree" role="list" aria-label="Changed files">
            {pr.files.map((f) => (
              <div key={f.path} role="listitem" className="row pr-file" title={`${f.path}\nDouble-click to see the changes`} onDoubleClick={() => void showDiff(f.path)}>
                <FileIcon path={f.path} />
                <span className={`name status-${f.changeType === 'ADDED' ? 'A' : f.changeType === 'DELETED' ? 'D' : f.changeType === 'RENAMED' ? 'R' : 'M'}`}>{baseName(f.path)}</span>
                <span className="detail">{f.path.split('/').slice(0, -1).join('/')}</span>
                <span className="grow" />
                <span className="pr-add">+{f.additions}</span>
                <span className="pr-del">−{f.deletions}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'commits' && (
          <div className="tree" role="list" aria-label="Commits">
            {pr.commits.map((c) => (
              <div key={c.oid} role="listitem" className="row pr-commit" title={c.oid}>
                <span className="mono muted">{c.oid.slice(0, 8)}</span>
                <span className="name">{c.messageHeadline}</span>
                <span className="detail">{c.authors.map((a) => a.login || a.name).join(', ')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Git ▸ GitHub ▸ Create Pull Request…: the current branch (pushed first when it has to be) into a
// base branch, with a title, a description and Draft (through gh, see git/github.ts).

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Branch } from '../git/git';
import { GitHub } from '../git/github';

export function CreatePullRequestDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const github = useMemo(() => new GitHub(ws.backend, ws.gitRepo), [ws.backend, ws.gitRepo]);
  const head = ws.git?.branch ?? '';
  const [branches, setBranches] = useState<Branch[]>([]);
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const list = await ws.gitRepo.branches().catch(() => [] as Branch[]);
      setBranches(list);
      const remote = list.filter((b) => b.remote && !b.name.endsWith('/HEAD')).map((b) => b.name.split('/').slice(1).join('/'));
      const fallback = remote.find((n) => n === 'main' || n === 'master') ?? remote[0] ?? '';
      const chosen = (await github.defaultBranch()) ?? fallback;
      setBase(chosen);
      // The title and description from the branch's own commits (one commit: its subject and body).
      const commits = await ws.gitRepo.log({ branch: `origin/${chosen}..HEAD`, max: 50 }).catch(() => []);
      if (commits.length === 1) {
        setTitle(commits[0].subject);
        setBody((await ws.gitRepo.commitMessage(commits[0].hash).catch(() => '')).split('\n').slice(1).join('\n').trim());
      } else {
        setTitle(head.replace(/^[\w-]+\//, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
        setBody(commits.map((c) => `- ${c.subject}`).join('\n'));
      }
      titleRef.current?.focus();
    })();
  }, [github, ws.gitRepo, head]);

  const current = branches.find((b) => b.current && !b.remote);
  // Not on GitHub yet, or commits it doesn't have: pushed first (gh needs the branch there).
  const needsPush = !current?.upstream || !!current.ahead;
  const bases = [...new Set(branches.filter((b) => b.remote && !b.name.endsWith('/HEAD')).map((b) => b.name.split('/').slice(1).join('/')))].filter((n) => n !== head);

  const create = async () => {
    if (!title.trim() || !base || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (needsPush && push) {
        const remote = (await ws.gitRepo.outgoing()).remote ?? 'origin';
        await ws.gitRepo.push(current?.upstream ? {} : { setUpstream: { remote, branch: head } });
      }
      const url = await github.create({ base, head, title: title.trim(), body, draft });
      onClose();
      void ws.refreshGit();
      ws.notify({ title: `Pull request created${draft ? ' (draft)' : ''}`, body: url, tone: 'success', action: { label: 'Open on GitHub', run: () => void invoke('open_external', { url }).catch(() => {}) } });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className="pb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-pr-title"
        style={{ width: 600 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Enter' && (e.ctrlKey || (e.target as HTMLElement).tagName === 'INPUT')) void create();
        }}
      >
        <div className="pb-dialog-title" id="create-pr-title">
          Create Pull Request
        </div>
        <div className="pb-dialog-body create-pr">
          <div className="create-pr-branches">
            <span className="mono">{head}</span>
            <span className="muted">into</span>
            <select aria-label="Base branch" value={base} onChange={(e) => setBase(e.target.value)}>
              {!bases.includes(base) && base && <option value={base}>{base}</option>}
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <label htmlFor="create-pr-name">Title:</label>
          <div className="field">
            <input id="create-pr-name" ref={titleRef} type="text" value={title} spellCheck onChange={(e) => setTitle(e.target.value)} />
          </div>
          <label htmlFor="create-pr-body">Description (Markdown):</label>
          <textarea id="create-pr-body" className="create-pr-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          <label className="settings-check">
            <input type="checkbox" className="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Draft (not ready for review yet)
          </label>
          {needsPush && (
            <label className="settings-check">
              <input type="checkbox" className="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
              {current?.upstream ? `Push ${current.ahead} new ${current.ahead === 1 ? 'commit' : 'commits'} first` : `Push ${head} to GitHub first (it isn't there yet)`}
            </label>
          )}
          {error && <div className="create-pr-error">{error}</div>}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy || !title.trim() || !base || !head} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create Pull Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

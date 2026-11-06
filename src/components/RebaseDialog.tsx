// Git log ▸ Interactively Rebase from Here: the commits from the chosen one to HEAD (oldest first,
// the order git applies them), each picked, reworded, stopped at, squashed, fixed up or dropped,
// and reordered. Starting runs git with this list; conflicts open the conflicts dialog.

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Commit } from '../git/git';
import { moveStep, rebaseProblem, REBASE_ACTIONS, type RebaseAction, type RebaseStep } from '../git/rebase';
import { Icon } from './Icon';

/** Keys for the actions while the list has the focus (as their underlined letters say). */
const KEYS: Record<string, RebaseAction> = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };

export function RebaseDialog({ ws, from, onClose }: { ws: Workspace; from: string; onClose: () => void }) {
  const [commits, setCommits] = useState<Map<string, { commit: Commit; message: string }> | null>(null);
  const [steps, setSteps] = useState<RebaseStep[]>([]);
  const [selected, setSelected] = useState(0);
  const [pushed, setPushed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const found = await ws.gitRepo.rebaseCommits(from);
        if (!live) return;
        setCommits(new Map(found.map((c) => [c.commit.hash, c])));
        setSteps(found.map((c) => ({ hash: c.commit.hash, action: 'pick' })));
        // Already on a remote: rewriting them means a force push.
        const out = await ws.gitRepo.outgoing().catch(() => null);
        if (live && out) {
          const local = new Set(out.commits.map((c) => c.hash));
          setPushed(new Set(found.map((c) => c.commit.hash).filter((h) => !local.has(h))));
        }
      } catch (e) {
        if (live) setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ws, from]);

  useEffect(() => list.current?.focus(), [commits]);

  const setAction = (i: number, action: RebaseAction) =>
    setSteps((s) => s.map((x, k) => (k === i ? { ...x, action, message: action === 'reword' ? x.message ?? commits?.get(x.hash)?.message : x.message } : x)));
  const move = (dir: -1 | 1) => {
    if (selected + dir < 0 || selected + dir >= steps.length) return;
    setSteps((s) => moveStep(s, selected, dir));
    setSelected(selected + dir);
  };

  const merges = steps.filter((s) => (commits?.get(s.hash)?.commit.parents.length ?? 1) > 1).length;
  const changed = steps.some((s, i) => s.action !== 'pick' || s.hash !== [...(commits?.keys() ?? [])][i]);
  const problem = merges ? 'There are merge commits in the range: an interactive rebase would flatten them.' : rebaseProblem(steps);
  const rewritten = steps.filter((s) => pushed.has(s.hash)).length;
  const current = steps[selected];

  const start = () => {
    if (problem || !changed) return;
    onClose();
    void ws.runGit('Interactive rebase', () => ws.gitRepo.interactiveRebase(from, steps));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-dialog rebase-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebase-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="pb-dialog-title" id="rebase-title">
          Rebasing {steps.length} {steps.length === 1 ? 'commit' : 'commits'} {ws.git?.branch && ws.git.branch !== 'HEAD' ? `on ${ws.git.branch}` : ''}
        </div>
        <div className="pb-dialog-body">
          {error ? (
            <div className="error-text">{error}</div>
          ) : !commits ? (
            <div className="muted">Reading the commits…</div>
          ) : (
            <>
              <div className="tw-toolbar rebase-toolbar">
                {REBASE_ACTIONS.map(([a, label]) => (
                  <button key={a} type="button" className={'btn small ghost' + (current?.action === a ? ' on' : '')} disabled={!current} onClick={() => setAction(selected, a)} title={`${label} (${Object.keys(KEYS).find((k) => KEYS[k] === a)!.toUpperCase()})`}>
                    {label}
                  </button>
                ))}
                <span className="te-sep" />
                <button type="button" className="icon-btn small" aria-label="Move up" title="Move Up (Alt+↑)" disabled={selected === 0} onClick={() => move(-1)}>
                  <Icon name="chevronUp" size={13} />
                </button>
                <button type="button" className="icon-btn small" aria-label="Move down" title="Move Down (Alt+↓)" disabled={selected >= steps.length - 1} onClick={() => move(1)}>
                  <Icon name="chevronDown" size={13} />
                </button>
                <span className="grow" />
                <span className="muted rebase-order">Oldest first: applied top to bottom</span>
              </div>
              <div
                ref={list}
                className="rebase-list"
                role="listbox"
                aria-label="Commits to rebase"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    move(e.key === 'ArrowUp' ? -1 : 1);
                  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSelected((i) => Math.max(0, Math.min(steps.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1))));
                  } else if (!e.ctrlKey && !e.altKey && KEYS[e.key.toLowerCase()]) {
                    e.preventDefault();
                    setAction(selected, KEYS[e.key.toLowerCase()]);
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    start();
                  }
                }}
              >
                {steps.map((s, i) => {
                  const c = commits.get(s.hash)!;
                  const joins = s.action === 'squash' || s.action === 'fixup';
                  return (
                    <div
                      key={s.hash}
                      role="option"
                      aria-selected={i === selected}
                      className={'rebase-row' + (i === selected ? ' selected' : '') + ` action-${s.action}`}
                      onMouseDown={() => setSelected(i)}
                    >
                      <select className="field select rebase-action" aria-label={`Action for ${c.commit.short}`} value={s.action} onChange={(e) => setAction(i, e.target.value as RebaseAction)}>
                        {REBASE_ACTIONS.map(([a, label]) => (
                          <option key={a} value={a}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <span className="mono muted">{c.commit.short}</span>
                      <span className="rebase-subject" title={c.message}>
                        {joins && <span className="muted">↳ </span>}
                        {s.action === 'reword' ? (s.message ?? '').split('\n')[0] : c.commit.subject}
                        {pushed.has(s.hash) && <span className="rebase-pushed" title="Already pushed">pushed</span>}
                      </span>
                      <span className="muted rebase-author">{c.commit.author}</span>
                    </div>
                  );
                })}
              </div>
              {current?.action === 'reword' && (
                <div className="rebase-message">
                  <label htmlFor="rebase-message">New message for {commits.get(current.hash)?.commit.short}:</label>
                  <textarea
                    id="rebase-message"
                    className="field"
                    rows={4}
                    spellCheck={false}
                    value={current.message ?? ''}
                    onChange={(e) => setSteps((s) => s.map((x, k) => (k === selected ? { ...x, message: e.target.value } : x)))}
                  />
                </div>
              )}
              {problem && <div className="error-text">{problem}</div>}
              {!problem && rewritten > 0 && changed && (
                <div className="rebase-warning">
                  <Icon name="warning" size={13} /> {rewritten} of these {rewritten === 1 ? 'commit is' : 'commits are'} already pushed: after the rebase, pushing needs a force push.
                </div>
              )}
            </>
          )}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!commits || !!problem || !changed} onClick={start} title={!changed ? 'Nothing changed yet' : 'Start Rebasing (Ctrl+Enter)'}>
            Start Rebasing
          </button>
        </div>
      </div>
    </div>
  );
}

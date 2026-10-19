// Git dialogs: Push (with the outgoing commits), New / Rename Branch, Checkout Revision,
// Stash / Unstash, Reset Current Branch, New Tag, Rollback Changes.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GitDialogRequest, Workspace } from '../useWorkspace';
import type { Commit, Stash } from '../git/git';
import { Icon } from './Icon';
import { RollbackDialog } from './RollbackDialog';

export function GitDialogs({ ws }: { ws: Workspace }) {
  const d = ws.gitDialog;
  if (!d) return null;
  const close = () => ws.setGitDialog(null);
  switch (d.kind) {
    case 'push':
      return <PushDialog ws={ws} onClose={close} />;
    case 'unstash':
      return <UnstashDialog ws={ws} onClose={close} />;
    case 'rollback':
      return <RollbackDialog ws={ws} paths={d.paths} onClose={close} />;
    case 'reset':
      return <ResetDialog ws={ws} hash={d.hash} subject={d.subject} onClose={close} />;
    default:
      return <PromptFor ws={ws} request={d} onClose={close} />;
  }
}

function Dialog({ title, width = 440, onClose, onSubmit, children, buttons }: { title: string; width?: number; onClose: () => void; onSubmit?: () => void; children: ReactNode; buttons: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
          if (e.key === 'Enter' && onSubmit && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') onSubmit();
        }}
      >
        <div className="pb-dialog-title">{title}</div>
        <div className="pb-dialog-body">{children}</div>
        <div className="pb-dialog-buttons">{buttons}</div>
      </div>
    </div>
  );
}

/** One-field dialogs: branch name, revision, stash message, tag. */
function PromptFor({ ws, request, onClose }: { ws: Workspace; request: GitDialogRequest; onClose: () => void }) {
  const repo = ws.gitRepo;
  const spec = (() => {
    switch (request.kind) {
      case 'newBranch':
        return { title: request.from ? `New Branch from '${request.from}'` : 'Create New Branch', label: 'New branch name:', initial: '', check: 'Checkout branch', checkInitial: true, ok: 'Create', branchName: true };
      case 'renameBranch':
        return { title: `Rename Branch '${request.branch}'`, label: 'New name:', initial: request.branch, ok: 'Rename', branchName: true };
      case 'checkoutRevision':
        return { title: 'Checkout Tag or Revision', label: 'Tag, branch or commit hash:', initial: '', ok: 'Checkout' };
      case 'stash':
        return { title: 'Stash Changes', label: 'Message:', initial: '', check: 'Include unversioned files', checkInitial: false, ok: 'Create Stash', optional: true };
      case 'tag':
        return { title: `New Tag on ${request.hash.slice(0, 8)}`, label: 'Tag name:', initial: '', ok: 'Create Tag', branchName: true };
      default:
        return null;
    }
  })();
  const [value, setValue] = useState(spec?.initial ?? '');
  const [checked, setChecked] = useState(spec?.checkInitial ?? false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  if (!spec) return null;

  const name = value.trim();
  const invalid = spec.branchName && name && (/[\s~^:?*[\\]|\.\.|^[-/]|[/.]$|@\{|\.lock$/.test(name) ? 'Not a valid name' : '');
  const canSubmit = (spec.optional || !!name) && !invalid;

  const submit = async () => {
    if (!canSubmit) return;
    onClose();
    switch (request.kind) {
      case 'newBranch':
        await ws.runGit(`New branch ${name}`, () => repo.newBranch(name, request.from, checked));
        break;
      case 'renameBranch':
        await ws.runGit(`Rename branch to ${name}`, () => repo.renameBranch(request.branch, name));
        break;
      case 'checkoutRevision':
        await ws.runGit(`Checkout ${name}`, () => repo.checkout(name));
        break;
      case 'stash':
        await ws.runGit('Stash changes', () => repo.stash(name, checked));
        break;
      case 'tag':
        await ws.runGit(`Tag ${name}`, () => repo.tag(name, request.hash));
        break;
    }
  };

  return (
    <Dialog
      title={spec.title}
      onClose={onClose}
      onSubmit={submit}
      buttons={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
            {spec.ok}
          </button>
        </>
      }
    >
      <label htmlFor="git-prompt">{spec.label}</label>
      <div className={'field' + (invalid ? ' invalid' : '')}>
        <input id="git-prompt" ref={input} value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
      </div>
      {invalid && <div className="error-text">{invalid}</div>}
      {spec.check && (
        <label className="settings-check" style={{ marginTop: 4 }}>
          <input type="checkbox" className="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {spec.check}
        </label>
      )}
      {request.kind === 'checkoutRevision' && <span className="muted" style={{ fontSize: 12 }}>A commit hash leaves you on a detached HEAD.</span>}
    </Dialog>
  );
}

function PushDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [state, setState] = useState<{ commits: Commit[]; upstream: string | null; remote: string | null; branch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);

  useEffect(() => {
    Promise.all([ws.gitRepo.outgoing(), ws.gitRepo.currentBranch()])
      .then(([o, branch]) => setState({ ...o, branch }))
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [ws.gitRepo]);

  const push = async () => {
    if (!state) return;
    onClose();
    const setUpstream = !state.upstream && state.remote ? { remote: state.remote, branch: state.branch } : undefined;
    await ws.runGit(force ? 'Force push' : 'Push', () => ws.gitRepo.push({ force, setUpstream }));
  };

  const target = state ? (state.upstream ? state.upstream.replace('/', ' : ') : state.remote ? `${state.remote} : ${state.branch} (new)` : 'no remote') : '…';
  return (
    <Dialog
      title={`Push Commits to ${ws.backend.name}`}
      width={620}
      onClose={onClose}
      buttons={
        <>
          <label className="settings-check" style={{ marginRight: 'auto' }}>
            <input type="checkbox" className="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force push (with lease)
          </label>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!state || !state.remote || (!state.commits.length && !!state.upstream && !force)} onClick={push}>
            {force ? 'Force Push' : 'Push'}
          </button>
        </>
      }
    >
      <div className="push-target">
        <Icon name="branch" size={14} />
        <b>{state?.branch ?? '…'}</b>
        <span className="muted">→</span>
        <span>{target}</span>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="push-list">
        {state && !state.commits.length && <div className="muted" style={{ padding: 10 }}>{state.upstream ? 'Everything is pushed.' : 'No commits found that the remote doesn’t have.'}</div>}
        {state?.commits.map((c) => (
          <div key={c.hash} className="push-commit" title={`${c.hash}\n${c.author} <${c.email}>`}>
            <span className="push-subject">{c.subject}</span>
            <span className="muted">{c.author}</span>
            <span className="muted mono">{c.short}</span>
          </div>
        ))}
        {!state && !error && <div className="muted" style={{ padding: 10 }}>Looking for commits to push…</div>}
      </div>
    </Dialog>
  );
}

function UnstashDialog({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [stashes, setStashes] = useState<Stash[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pop, setPop] = useState(false);
  const load = () =>
    ws.gitRepo
      .stashList()
      .then((list) => {
        setStashes(list);
        setSelected((s) => (s && list.some((x) => x.ref === s) ? s : list[0]?.ref ?? null));
      })
      .catch(() => setStashes([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog
      title="Unstash Changes"
      width={560}
      onClose={onClose}
      buttons={
        <>
          <label className="settings-check" style={{ marginRight: 'auto' }}>
            <input type="checkbox" className="checkbox" checked={pop} onChange={(e) => setPop(e.target.checked)} />
            Pop stash (remove it after applying)
          </label>
          <button
            type="button"
            className="btn"
            disabled={!selected}
            onClick={async () => {
              if (selected) await ws.runGit('Drop stash', () => ws.gitRepo.dropStash(selected));
              load();
            }}
          >
            Drop
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!selected}
            onClick={async () => {
              onClose();
              if (selected) await ws.runGit(pop ? 'Pop stash' : 'Apply stash', () => ws.gitRepo.unstash(selected, pop));
            }}
          >
            Apply Stash
          </button>
        </>
      }
    >
      <div className="push-list">
        {stashes === null && <div className="muted" style={{ padding: 10 }}>Loading…</div>}
        {stashes?.length === 0 && <div className="muted" style={{ padding: 10 }}>No stashes.</div>}
        {stashes?.map((s) => (
          <button key={s.ref} type="button" className={'push-commit' + (selected === s.ref ? ' selected' : '')} onClick={() => setSelected(s.ref)}>
            <span className="mono muted">{s.ref}</span>
            <span className="push-subject">{s.message}</span>
            <span className="muted">{new Date(s.date).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function ResetDialog({ ws, hash, subject, onClose }: { ws: Workspace; hash: string; subject: string; onClose: () => void }) {
  const [mode, setMode] = useState<'soft' | 'mixed' | 'hard'>('mixed');
  const help = { soft: 'Keep changes, staged.', mixed: 'Keep changes, unstaged (default).', hard: 'Discard all local changes and commits after it. Cannot be undone from PHPBlitz.' };
  return (
    <Dialog
      title="Reset Current Branch to Here"
      width={500}
      onClose={onClose}
      buttons={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={'btn primary' + (mode === 'hard' ? ' danger' : '')}
            onClick={async () => {
              onClose();
              await ws.runGit(`Reset (${mode})`, () => ws.gitRepo.reset(hash, mode));
            }}
          >
            Reset
          </button>
        </>
      }
    >
      <span>
        To <span className="mono">{hash.slice(0, 8)}</span> {subject}
      </span>
      {(['soft', 'mixed', 'hard'] as const).map((m) => (
        <label key={m} className="settings-radio" style={{ alignItems: 'flex-start', marginTop: 4 }}>
          <input type="radio" name="reset-mode" checked={mode === m} onChange={() => setMode(m)} />
          <span>
            <b style={{ textTransform: 'capitalize' }}>{m}</b>
            <br />
            <span className={m === 'hard' ? 'error-text' : 'muted'} style={{ fontSize: 12 }}>
              {help[m]}
            </span>
          </span>
        </label>
      ))}
    </Dialog>
  );
}

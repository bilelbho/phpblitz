import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { Badge, Icon, fileBadge } from './Icon';

const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'unversioned' } as const;

export function CommitPanel({ ws }: { ws: Workspace }) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [groupOpen, setGroupOpen] = useState(true);
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastCommit, setLastCommit] = useState('');
  const groupBox = useRef<HTMLInputElement>(null);

  const changes = ws.git?.changes ?? [];
  const included = changes.filter((c) => !excluded.has(c.path));
  const allIn = included.length === changes.length;

  useEffect(() => {
    if (groupBox.current) groupBox.current.indeterminate = included.length > 0 && !allIn;
  }, [included.length, allIn]);

  if (!ws.gitLoaded) return <div className="empty">Reading Git status…</div>;
  if (!ws.git) return <div className="empty">This project is not a Git repository, or Git is not installed.</div>;

  const toggle = (path: string) => {
    setError('');
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !message.trim()) setMessage((await ws.backend.lastCommitMessage()) ?? '');
  };

  const submit = async (push: boolean) => {
    if (!included.length && !amend) return setError('Select at least one file to commit.');
    if (!message.trim()) return setError('Enter a commit message.');
    setBusy(true);
    setError('');
    try {
      setLastCommit(await ws.commit(included.map((c) => c.path), message.trim(), push, amend));
      setMessage('');
      setAmend(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="tw-toolbar">
        <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={ws.refreshGit}>
          <Icon name="refresh" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Rollback" title="Rollback (coming soon)" disabled>
          <Icon name="rollback" size={15} />
        </button>
        <span className="strip-sep" style={{ width: 1, height: 16, margin: '0 4px' }} />
        <button type="button" className="icon-btn" aria-label="Expand all" title="Expand All" onClick={() => setGroupOpen(true)}>
          <Icon name="expandAll" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Collapse all" title="Collapse All" onClick={() => setGroupOpen(false)}>
          <Icon name="collapseAll" size={15} />
        </button>
      </div>

      <div className="panel-body tree">
        <div className="row group" style={{ paddingLeft: 4, gap: 6 }}>
          <button type="button" className="chev" aria-label={groupOpen ? 'Collapse changes' : 'Expand changes'} onClick={() => setGroupOpen((o) => !o)}>
            <span className={'chev' + (groupOpen ? ' open' : '')}>
              <Icon name="chevronRight" size={12} strokeWidth={2.5} />
            </span>
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input
              ref={groupBox}
              type="checkbox"
              className="checkbox"
              checked={changes.length > 0 && allIn}
              onChange={() => setExcluded(allIn ? new Set(changes.map((c) => c.path)) : new Set())}
              disabled={!changes.length}
            />
            <span style={{ fontWeight: 500 }}>Changes</span>
          </label>
          <span className="detail">
            {changes.length} {changes.length === 1 ? 'file' : 'files'}
          </span>
        </div>
        {groupOpen &&
          changes.map((c) => {
            const badge = fileBadge(c.path);
            const dir = relativePath(ws.backend, c.path).split('/').slice(0, -1).join('/');
            return (
              <div key={c.path} className="row" style={{ paddingLeft: 26 }}>
                <label style={{ display: 'inline-flex' }}>
                  <input type="checkbox" className="checkbox" checked={!excluded.has(c.path)} onChange={() => toggle(c.path)} />
                  <span className="sr-only">Include {baseName(c.path)} in commit</span>
                </label>
                <button
                  type="button"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                  onClick={() => c.status !== 'D' && ws.openFile(c.path)}
                  title={`${relativePath(ws.backend, c.path)} (${STATUS_LABEL[c.status]})`}
                >
                  <Badge text={badge.text} color={badge.color} />
                  <span className={`name status-${c.status}`}>{baseName(c.path)}</span>
                  <span className="detail">{dir}</span>
                </button>
              </div>
            );
          })}
        {changes.length === 0 && <div className="empty">No changes.</div>}
        {lastCommit && (
          <div className="card" style={{ margin: '8px 0' }}>
            <div className="card-body" style={{ margin: 0, color: '#73bd79' }}>
              {lastCommit}
            </div>
          </div>
        )}
      </div>

      <div className="panel-foot">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="checkbox" className="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} />
            Amend
          </label>
          <span className="link-btn" style={{ cursor: 'default' }}>last commit</span>
          <span className="grow" />
          <button type="button" className="icon-btn small" aria-label="Commit history" title="Commit message history (coming soon)" disabled>
            <Icon name="history" size={14} />
          </button>
        </div>
        <label htmlFor="commit-message" className="sr-only">
          Commit message
        </label>
        <textarea
          id="commit-message"
          className="textarea"
          rows={5}
          placeholder="Commit Message"
          value={message}
          spellCheck={false}
          onChange={(e) => {
            setMessage(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(false);
          }}
        />
        {error && <div className="error-text">{error}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <button type="button" className="btn" onClick={() => submit(false)} disabled={busy} title="Commit (Ctrl+Enter)">
            {busy ? 'Committing…' : amend ? 'Amend Commit' : 'Commit'}
          </button>
          <button type="button" className="btn" onClick={() => submit(true)} disabled={busy}>
            {amend ? 'Amend Commit and Push…' : 'Commit and Push…'}
          </button>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Commit options" title="Commit options (coming soon)" disabled>
            <Icon name="gear" size={15} />
          </button>
        </div>
      </div>
    </>
  );
}

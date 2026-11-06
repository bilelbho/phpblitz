// Commit tool window ▸ Stash: the stashes (git stash list), what each one holds, and Apply, Pop or
// Drop. A file's diff opens with a double-click; untracked files a stash took along are listed too.

import { useEffect, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Stash, StashFile } from '../git/git';
import { baseName, relativePath } from '../backend/types';
import { confirmDialog } from '../platform';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

/** "On main: message" / "WIP on main: abc123 subject" → the branch and the message. */
export function stashLabel(message: string): { branch: string; text: string } {
  const m = message.match(/^(?:WIP on|On) ([^:]+): (.*)$/);
  return m ? { branch: m[1], text: m[2] } : { branch: '', text: message };
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

export function StashPanel({ ws }: { ws: Workspace }) {
  const [stashes, setStashes] = useState<Stash[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<StashFile[] | null>(null);
  const current = stashes?.find((s) => s.hash === selected) ?? null;

  const load = () =>
    ws.gitRepo
      .stashList()
      .then((list) => {
        setStashes(list);
        setSelected((s) => (s && list.some((x) => x.hash === s) ? s : list[0]?.hash ?? null));
      })
      .catch(() => setStashes([]));
  // Stashing, applying or dropping refreshes the Git status: the list follows.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.git, ws.gitRepo]);

  useEffect(() => {
    if (!selected) return setFiles(null);
    let live = true;
    setFiles(null);
    ws.gitRepo.stashFiles(selected).then(
      (f) => live && setFiles(f),
      () => live && setFiles([]),
    );
    return () => {
      live = false;
    };
  }, [selected, ws.gitRepo]);

  const apply = (pop: boolean) => current && void ws.runGit(pop ? `Pop ${current.ref}` : `Apply ${current.ref}`, () => ws.gitRepo.unstash(current.ref, pop));
  const drop = async () => {
    if (!current) return;
    const { text } = stashLabel(current.message);
    if (await confirmDialog(`Drop ${current.ref} ("${text}")? Its changes are deleted.`)) await ws.runGit(`Drop ${current.ref}`, () => ws.gitRepo.dropStash(current.ref));
  };
  const showDiff = (f: StashFile) => current && ws.openDiff(f.path, f.status === 'U' ? `${current.hash}^3` : current.hash);

  return (
    <div className="stash-panel">
      <div className="tw-toolbar">
        <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
          <Icon name="refresh" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Stash changes" title="Stash Changes…" disabled={!ws.git?.changes.length} onClick={() => ws.setGitDialog({ kind: 'stash' })}>
          <Icon name="plus" size={15} />
        </button>
        <span className="te-sep" />
        <button type="button" className="icon-btn" aria-label="Apply stash" title="Apply (keep the stash)" disabled={!current} onClick={() => apply(false)}>
          <Icon name="check" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Pop stash" title="Pop (apply, then drop it)" disabled={!current} onClick={() => apply(true)}>
          <Icon name="rollback" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Drop stash" title="Drop…" disabled={!current} onClick={() => void drop()}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      {stashes === null ? (
        <div className="empty">Loading…</div>
      ) : !stashes.length ? (
        <div className="empty">
          No stashes
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Stash puts your uncommitted changes aside, to apply later.
          </div>
        </div>
      ) : (
        <div
          className="panel-body tree stash-list"
          tabIndex={0}
          role="listbox"
          aria-label="Stashes"
          onKeyDown={(e) => {
            const i = stashes.findIndex((s) => s.hash === selected);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const next = stashes[i + (e.key === 'ArrowDown' ? 1 : -1)];
              if (next) setSelected(next.hash);
            } else if (e.key === 'Delete') {
              e.preventDefault();
              void drop();
            }
          }}
        >
          {stashes.map((s) => {
            const { branch, text } = stashLabel(s.message);
            const open = s.hash === selected;
            return (
              <div key={s.hash}>
                <div
                  role="option"
                  aria-selected={open}
                  className={'row stash-row' + (open ? ' selected' : '')}
                  onMouseDown={() => setSelected(s.hash)}
                  onDoubleClick={() => apply(false)}
                  title={`${s.ref} · ${new Date(s.date).toLocaleString()}${branch ? ` · on ${branch}` : ''}\nDouble-click to apply`}
                >
                  <span className={'chev' + (open ? ' open' : '')}>
                    <Icon name="chevronRight" size={12} />
                  </span>
                  <Icon name="shelve" size={14} />
                  <span className="name">{text || s.ref}</span>
                  <span className="detail">
                    {branch && `${branch} · `}
                    {when(s.date)}
                  </span>
                </div>
                {open &&
                  (files === null ? (
                    <div className="muted" style={{ padding: '2px 44px' }}>
                      Loading…
                    </div>
                  ) : (
                    files.map((f) => (
                      <div key={f.path + f.status} className="row" style={{ paddingLeft: 44 }} onDoubleClick={() => showDiff(f)} title={`${relativePath(ws.backend, f.path)}\nDouble-click for the diff`}>
                        <FileIcon path={f.path} />
                        <span className={`name status-${f.status === 'T' ? 'M' : f.status}`}>{baseName(f.path)}</span>
                        <span className="detail">{relativePath(ws.backend, f.path).split('/').slice(0, -1).join('/')}</span>
                      </div>
                    ))
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

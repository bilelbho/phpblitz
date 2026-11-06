// Commit tool window ▸ Shelf: changes put aside with Shelve Changes, each a named patch. Unshelve
// brings back all of a shelf or the selected files (merged with what changed since); Delete drops it.

import { useEffect, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Shelf } from '../git/git';
import { baseName } from '../backend/types';
import { confirmDialog } from '../platform';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

export function ShelfPanel({ ws }: { ws: Workspace }) {
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [selected, setSelected] = useState<{ id: string; file?: string } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = () =>
    ws.gitRepo.shelves().then((list) => {
      setShelves(list);
      setSelected((s) => (s && list.some((x) => x.id === s.id) ? s : list[0] ? { id: list[0].id } : null));
    });
  // Shelving and unshelving refresh the Git status: the list follows.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.git, ws.gitRepo]);

  const current = shelves?.find((s) => s.id === selected?.id) ?? null;
  const unshelve = (shelf: Shelf, file?: string) =>
    void ws
      .runGit(file ? `Unshelve ${baseName(file)}` : `Unshelve "${shelf.name}"`, async () => {
        const { conflicted } = await ws.gitRepo.unshelve(shelf.id, file ? [file] : undefined);
        // Both sides changed the same lines: the file has conflict markers to sort out.
        if (conflicted.length) {
          ws.notify({
            title: `Unshelved with conflicts in ${conflicted.length === 1 ? baseName(conflicted[0]) : `${conflicted.length} files`}`,
            body: 'Lines you changed since were changed on the shelf too: look for <<<<<<< in the file.',
            tone: 'warning',
            action: { label: 'Open', run: () => void ws.openFile(`${ws.gitRepo.root}/${conflicted[0]}`) },
          });
        }
      })
      .then(() => load());
  /** A shelved file's changes: the commit it was shelved on vs the file as shelved. */
  const showDiff = (shelf: Shelf, file: string) => ws.openDiff(`${ws.gitRepo.root}/${file}`, undefined, undefined, shelf.id);
  const drop = async (shelf: Shelf) => {
    if (await confirmDialog(`Delete the shelf "${shelf.name}"? Its changes are lost.`)) {
      await ws.gitRepo.dropShelf(shelf.id);
      await load();
    }
  };
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="stash-panel">
      <div className="tw-toolbar">
        <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
          <Icon name="refresh" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Shelve changes"
          title="Shelve Changes…"
          disabled={!ws.git?.changes.some((c) => c.status !== 'C')}
          onClick={() => ws.setGitDialog({ kind: 'shelve', paths: (ws.git?.changes ?? []).filter((c) => c.status !== 'U' && c.status !== 'C').map((c) => c.path) })}
        >
          <Icon name="plus" size={15} />
        </button>
        <span className="te-sep" />
        <button
          type="button"
          className="icon-btn"
          aria-label="Show diff"
          title="Show Diff (double-click a file)"
          disabled={!current || !selected?.file}
          onClick={() => current && selected?.file && showDiff(current, selected.file)}
        >
          <Icon name="columns" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Unshelve"
          title={selected?.file ? `Unshelve ${baseName(selected.file)}` : 'Unshelve (all its files)'}
          disabled={!current}
          onClick={() => current && unshelve(current, selected?.file)}
        >
          <Icon name="rollback" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Delete shelf" title="Delete…" disabled={!current} onClick={() => current && void drop(current)}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      {shelves === null ? (
        <div className="empty">Loading…</div>
      ) : !shelves.length ? (
        <div className="empty">
          Nothing shelved
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Shelve Changes puts changes aside as a named patch, to bring back later (all or some files).
          </div>
        </div>
      ) : (
        <div className="panel-body tree stash-list" role="tree" aria-label="Shelves">
          {shelves.map((s) => {
            const expanded = open.has(s.id);
            const left = s.files.filter((f) => !s.applied.includes(f.path));
            return (
              <div key={s.id}>
                <div
                  role="treeitem"
                  aria-expanded={expanded}
                  aria-selected={selected?.id === s.id && !selected.file}
                  className={'row stash-row' + (selected?.id === s.id && !selected.file ? ' selected' : '')}
                  onMouseDown={() => setSelected({ id: s.id })}
                  onClick={() => toggle(s.id)}
                  onDoubleClick={() => unshelve(s)}
                  title={`${s.name}\n${new Date(s.date).toLocaleString()} · ${left.length} ${left.length === 1 ? 'file' : 'files'}\nDouble-click to unshelve`}
                >
                  <span className={'chev' + (expanded ? ' open' : '')}>
                    <Icon name="chevronRight" size={12} />
                  </span>
                  <Icon name="shelve" size={14} />
                  <span className="name">{s.name}</span>
                  <span className="detail">
                    {left.length} {left.length === 1 ? 'file' : 'files'} · {new Date(s.date).toLocaleDateString()}
                  </span>
                </div>
                {expanded &&
                  left.map((f) => (
                    <div
                      key={f.path}
                      role="treeitem"
                      aria-selected={selected?.id === s.id && selected.file === f.path}
                      className={'row' + (selected?.id === s.id && selected.file === f.path ? ' selected' : '')}
                      style={{ paddingLeft: 44 }}
                      onMouseDown={() => setSelected({ id: s.id, file: f.path })}
                      onDoubleClick={() => showDiff(s, f.path)}
                      title={`${f.path}\nDouble-click to see the changes`}
                    >
                      <FileIcon path={f.path} />
                      <span className={`name status-${f.status === 'R' ? 'R' : f.status}`}>{baseName(f.path)}</span>
                      <span className="detail">{f.path.split('/').slice(0, -1).join('/')}</span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

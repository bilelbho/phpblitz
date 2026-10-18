// Commit tool window: Changes and Unversioned Files groups (optionally by
// directory), Ignored Files on request, diff / rollback / shelve, message history and commit options.

import { FileIcon } from './FileIcon';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath, type GitChange } from '../backend/types';
import { Icon } from './Icon';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { confirmDialog, isTauri } from '../platform';
import { generateCommitMessage } from '../ai/commitMessage';
import { AiCancelled, type AiStream } from '../ai/client';
import type { Commit } from '../git/git';
import { projectStorage } from '../projectStorage';

const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'unversioned' } as const;

interface ViewPrefs {
  groupByDir: boolean;
  showIgnored: boolean;
  signOff: boolean;
  analyze: boolean;
  /** Fixup commits: squash them into their target right away. */
  squashFixup: boolean;
}
const PREFS_KEY = 'phpblitz.commitView';
const DEFAULT_PREFS: ViewPrefs = { groupByDir: false, showIgnored: false, signOff: false, analyze: true, squashFixup: false };

function loadPrefs(): ViewPrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}

const historyKey = (root: string) => `phpblitz.commitMessages:${root}`;
function messageHistory(root: string): string[] {
  try {
    return JSON.parse(projectStorage.getItem(historyKey(root)) ?? '[]');
  } catch {
    return [];
  }
}
function rememberMessage(root: string, message: string) {
  try {
    projectStorage.setItem(historyKey(root), JSON.stringify([message, ...messageHistory(root).filter((m) => m !== message)].slice(0, 20)));
  } catch {
    // Only a convenience.
  }
}

export function CommitPanel({ ws }: { ws: Workspace }) {
  /** Files whose checkbox differs from the default (tracked changes in, unversioned files out). */
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [prefs, setPrefsState] = useState<ViewPrefs>(loadPrefs);
  const [ignored, setIgnored] = useState<string[] | null>(null);
  const [message, setMessage] = useState('');
  const generation = useRef<AiStream | null>(null);
  const [generating, setGenerating] = useState(false);
  const [amend, setAmend] = useState(false);
  /** Fixup: on, and the commit it fixes (with whether that commit is already pushed). */
  const [fixupOn, setFixupOn] = useState(false);
  const [fixup, setFixup] = useState<{ commit: Commit; pushed: boolean } | null>(null);
  const [amended, setAmended] = useState<Commit | null>(null);
  /** The message Amend filled in: cleared again when switching to another mode (typed text stays). */
  const amendFilled = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const tree = useRef<HTMLDivElement>(null);

  const setPrefs = (patch: Partial<ViewPrefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // Only a preference.
      }
      return next;
    });

  const all = ws.git?.changes ?? [];
  const changes = all.filter((c) => c.status !== 'U');
  const unversioned = all.filter((c) => c.status === 'U');
  const isIn = (c: GitChange) => (c.status !== 'U') !== toggled.has(c.path);
  const included = all.filter(isIn);

  useEffect(() => {
    if (!prefs.showIgnored || !ws.git) {
      setIgnored(null);
      return;
    }
    let live = true;
    ws.gitRepo.ignored().then((list) => live && setIgnored(list)).catch(() => live && setIgnored([]));
    return () => {
      live = false;
    };
  }, [prefs.showIgnored, ws.git, ws.gitRepo]);

  useEffect(() => {
    tree.current?.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const setIncluded = (list: GitChange[], on: boolean) =>
    setToggled((s) => {
      const next = new Set(s);
      for (const c of list) {
        const byDefault = c.status !== 'U';
        if (on === byDefault) next.delete(c.path);
        else next.add(c.path);
      }
      return next;
    });

  const toggleOpen = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!ws.gitLoaded) return <div className="empty">Reading Git status…</div>;
  if (!ws.git) return <div className="empty">This project is not a Git repository, or Git is not installed.</div>;

  const showDiff = (c: GitChange) => (c.status === 'U' ? ws.openFile(c.path) : ws.openDiff(c.path));
  const selectedChange = all.find((c) => c.path === selected);
  const rollbackTargets = () => (selectedChange ? [selectedChange] : included).filter((c) => c.status !== 'U');

  const fileMenu = (e: React.MouseEvent, c: GitChange) => {
    e.preventDefault();
    setSelected(c.path);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Commit File…', icon: 'commit', run: () => setToggled(new Set(all.filter((x) => (x.path === c.path) !== (x.status !== 'U')).map((x) => x.path))) },
        { kind: 'sep' },
        { label: 'Show Diff', shortcut: 'Ctrl+D', icon: 'columns', disabled: c.status === 'U', run: () => showDiff(c) },
        { label: 'Jump to Source', shortcut: 'F4', icon: 'goTo', disabled: c.status === 'D', run: () => ws.openFile(c.path) },
        { kind: 'sep' },
        ...(c.status === 'U'
          ? [
              { label: 'Add to VCS', shortcut: 'Ctrl+Alt+A', icon: 'plus' as const, run: () => ws.runGit('Add to VCS', () => ws.gitRepo.add([c.path])) },
              { label: 'Add to .gitignore', run: () => addToGitignore([c.path]) },
              { label: 'Delete…', run: () => ws.deleteItems([c.path]) },
            ]
          : [
              { label: 'Rollback…', shortcut: 'Ctrl+Alt+Z', icon: 'rollback' as const, run: () => ws.rollbackFiles([c]) },
              { label: 'Show History', icon: 'history' as const, disabled: c.status === 'A', run: () => ws.showHistory(c.path) },
            ]),
        { kind: 'sep' },
        { label: 'Refresh', icon: 'refresh', run: ws.refreshGit },
      ],
    });
  };

  const addToGitignore = async (paths: string[]) => {
    const file = `${ws.backend.root}/.gitignore`;
    const current = await ws.backend.readFile(file).catch(() => '');
    const lines = paths.map((p) => '/' + relativePath(ws.backend, p));
    const text = (current && !current.endsWith('\n') ? current + '\n' : current) + lines.join('\n') + '\n';
    try {
      await ws.backend.writeFile(file, text);
      ws.reloadItem(file, false);
      ws.refreshGit();
    } catch (e) {
      ws.notify({ title: 'Could not update .gitignore', body: String(e), tone: 'error' });
    }
  };

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (!on) return;
    setFixupOn(false);
    const [last] = await ws.gitRepo.log({ branch: 'HEAD', max: 1 }).catch(() => [] as Commit[]);
    setAmended(last ?? null);
    // The message of the commit being amended (the one shown under the switch).
    if (!message.trim() && last) {
      const text = await ws.gitRepo.commitMessage(last.hash).catch(() => last.subject);
      amendFilled.current = text;
      setMessage(text);
    }
  };

  type Mode = 'new' | 'amend' | 'fixup';
  const mode: Mode = amend ? 'amend' : fixupOn ? 'fixup' : 'new';
  const setMode = (next: Mode, anchor: DOMRect) => {
    setError('');
    if (mode === 'amend' && next !== 'amend' && amendFilled.current !== null && message === amendFilled.current) setMessage('');
    if (next !== 'amend') amendFilled.current = null;
    if (next === 'amend') toggleAmend(true);
    else if (next === 'fixup') toggleFixup(true, anchor);
    else {
      setAmend(false);
      setFixupOn(false);
    }
  };

  /** Fixup target picker: recent commits of the current branch, pushed ones marked. */
  const pickFixupTarget = async (anchor: DOMRect) => {
    try {
      const [commits, outgoing] = await Promise.all([ws.gitRepo.log({ branch: 'HEAD', max: 30 }), ws.gitRepo.outgoing().catch(() => null)]);
      const local = new Set(outgoing?.commits.map((c) => c.hash) ?? []);
      // Without an upstream every commit counts as local; otherwise only the outgoing ones are.
      const isPushed = (c: Commit) => !!outgoing?.upstream && !local.has(c.hash);
      setMenu({
        x: anchor.left,
        y: anchor.top - 8,
        items: commits.length
          ? [
              { label: 'Fixup of…', disabled: true },
              ...commits
                .filter((c) => !c.subject.startsWith('fixup! '))
                .map((c) => ({
                  label: c.subject.length > 60 ? c.subject.slice(0, 60) + '…' : c.subject,
                  shortcut: `${c.short}${isPushed(c) ? ' · pushed' : ''}`,
                  checked: fixup?.commit.hash === c.hash,
                  run: () => {
                    setFixup({ commit: c, pushed: isPushed(c) });
                    setFixupOn(true);
                    setAmend(false);
                  },
                })),
            ]
          : [{ label: 'No commits yet', disabled: true }],
      });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const toggleFixup = (on: boolean, anchor: DOMRect) => {
    setFixupOn(on);
    setError('');
    if (on) {
      setAmend(false);
      if (!fixup) pickFixupTarget(anchor);
    }
  };

  const submit = async (push: boolean) => {
    if (!included.length && !amend) return setError('Select at least one file to commit.');
    if (fixupOn && !fixup) return setError('Choose the commit this fixup is for.');
    if (!fixupOn && !message.trim()) return setError('Enter a commit message.');
    const squash = fixupOn && fixup && prefs.squashFixup;
    if (squash && fixup.pushed && !(await confirmDialog(`"${fixup.commit.subject}" is already pushed. Squashing rewrites it, so you will need to force push. Continue?`))) return;
    // Commit option "Analyze code": errors in the files being committed get a second look.
    if (prefs.analyze) {
      const errors = included.flatMap((c) => (ws.problems[c.path] ?? []).filter((p) => p.severity === 'error'));
      if (errors.length && !(await confirmDialog(`${errors.length} error${errors.length === 1 ? '' : 's'} found in the files you are committing. Commit anyway?`))) return;
    }
    setBusy(true);
    setError('');
    try {
      await ws.commit(included.map((c) => c.path), message.trim(), false, { amend, signOff: prefs.signOff, fixup: fixupOn ? fixup?.commit.hash : undefined });
      if (message.trim() && !fixupOn) rememberMessage(ws.backend.root, message.trim());
      setMessage('');
      setAmend(false);
      setToggled(new Set());
      if (squash) await ws.runGit(`Squash into "${fixup.commit.subject}"`, () => ws.gitRepo.autosquash(fixup.commit.hash));
      setFixupOn(false);
      setFixup(null);
      // Commit and Push…: the Push dialog shows what goes out.
      if (push) ws.setGitDialog({ kind: 'push' });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const viewMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'Group By', disabled: true },
        { label: 'Directory', checked: prefs.groupByDir, run: () => setPrefs({ groupByDir: !prefs.groupByDir }) },
        { kind: 'sep' },
        { label: 'Show', disabled: true },
        { label: 'Ignored Files', checked: prefs.showIgnored, run: () => setPrefs({ showIgnored: !prefs.showIgnored }) },
      ],
    });
  };

  const optionsMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right - 260,
      y: r.top - 8,
      items: [
        { label: 'Before Commit', disabled: true },
        { label: 'Analyze code (Mago errors)', checked: prefs.analyze, run: () => setPrefs({ analyze: !prefs.analyze }) },
        { kind: 'sep' },
        { label: 'Git', disabled: true },
        { label: 'Sign-off commit', checked: prefs.signOff, run: () => setPrefs({ signOff: !prefs.signOff }) },
      ],
    });
  };

  /** The AI's commit message for the included changes, streamed into the message box. */
  const generateMessage = async () => {
    if (generation.current) {
      generation.current.cancel();
      return;
    }
    setError('');
    setGenerating(true);
    try {
      generation.current = await generateCommitMessage(ws, included, (text) => setMessage(text));
      await generation.current.done;
    } catch (e) {
      if (!(e instanceof AiCancelled)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      generation.current = null;
      setGenerating(false);
    }
  };

  /** The clock: recent commits. New / Amend: reuse a message. Fixup: choose the target. */
  const historyMenu = async (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (mode === 'fixup') return pickFixupTarget(r);
    const commits = await ws.gitRepo.log({ branch: 'HEAD', max: 20 }).catch(() => [] as Commit[]);
    const subjects = new Set(commits.map((c) => c.subject));
    // Messages typed here that aren't in the log (e.g. amended away) come after the commits.
    const saved = messageHistory(ws.backend.root).filter((m) => !subjects.has(m.split('\n')[0]));
    const items: ContextItem[] = [
      { label: 'Reuse message of…', disabled: true },
      ...commits
        .filter((c) => !c.subject.startsWith('fixup! '))
        .map((c) => ({
          label: c.subject.length > 60 ? c.subject.slice(0, 60) + '…' : c.subject,
          shortcut: c.short,
          run: async () => setMessage(await ws.gitRepo.commitMessage(c.hash).catch(() => c.subject)),
        })),
      ...(saved.length ? [{ kind: 'sep' as const }, { label: 'Earlier messages', disabled: true }, ...saved.map((m) => ({ label: m.split('\n')[0].slice(0, 60), run: () => setMessage(m) }))] : []),
    ];
    setMenu({ x: Math.max(8, r.right - 360), y: r.bottom + 4, items: commits.length || saved.length ? items : [{ label: 'No commits yet', disabled: true }] });
  };

  const locate = () => {
    const path = ws.activePath;
    if (!path || !all.some((c) => c.path === path)) return;
    setSelected(path);
    setCollapsed(new Set());
  };

  // ── Rows ──
  const check = (list: GitChange[], label: string) => {
    const on = list.filter(isIn).length;
    return (
      <input
        type="checkbox"
        className="checkbox"
        aria-label={`Include ${label}`}
        checked={list.length > 0 && on === list.length}
        ref={(el) => {
          if (el) el.indeterminate = on > 0 && on < list.length;
        }}
        onChange={() => setIncluded(list, on !== list.length)}
        onClick={(e) => e.stopPropagation()}
        disabled={!list.length}
      />
    );
  };

  const groupRow = (key: string, label: string, list: GitChange[] | null, count: number, depth = 0, withCheck = true): ReactNode => (
    <div key={key} className={'row commit-group' + (depth ? ' dir' : ' group')} style={{ paddingLeft: 4 + depth * 18 }} onClick={() => toggleOpen(key)}>
      <span className={'chev' + (collapsed.has(key) ? '' : ' open')}>
        <Icon name="chevronRight" size={12} />
      </span>
      {withCheck && list && check(list, label)}
      {depth > 0 && <Icon name="folder" size={14} />}
      <span style={{ fontWeight: depth ? 400 : 500 }}>{label}</span>
      <span className="detail">
        {count} {count === 1 ? 'file' : 'files'}
      </span>
    </div>
  );

  const fileRow = (c: GitChange, depth: number, showDir: boolean): ReactNode => {
    const dir = relativePath(ws.backend, c.path).split('/').slice(0, -1).join('/');
    return (
      <div
        key={c.path}
        className={'row' + (selected === c.path ? ' selected' : '')}
        style={{ paddingLeft: 26 + depth * 18 }}
        onMouseDown={() => setSelected(c.path)}
        onDoubleClick={() => showDiff(c)}
        onContextMenu={(e) => fileMenu(e, c)}
        title={`${relativePath(ws.backend, c.path)} (${STATUS_LABEL[c.status]})`}
      >
        <input type="checkbox" className="checkbox" checked={isIn(c)} aria-label={`Include ${baseName(c.path)}`} onChange={() => setIncluded([c], !isIn(c))} />
        <FileIcon path={c.path} />
        <span className={`name status-${c.status}`}>{baseName(c.path)}</span>
        {showDir && <span className="detail">{dir || ws.backend.name}</span>}
      </div>
    );
  };

  const fileRows = (key: string, list: GitChange[]): ReactNode[] => {
    if (collapsed.has(key)) return [];
    if (!prefs.groupByDir) return list.map((c) => fileRow(c, 0, true));
    const byDir = new Map<string, GitChange[]>();
    for (const c of list) {
      const dir = relativePath(ws.backend, c.path).split('/').slice(0, -1).join('/') || ws.backend.name;
      byDir.set(dir, [...(byDir.get(dir) ?? []), c]);
    }
    return [...byDir.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([dir, files]) => {
        const dk = `${key}/${dir}`;
        return [groupRow(dk, dir, files, files.length, 1), ...(collapsed.has(dk) ? [] : files.map((c) => fileRow(c, 1, false)))];
      });
  };

  return (
    <>
      <div className="tw-toolbar">
        <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" onClick={ws.refreshGit}>
          <Icon name="refresh" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Rollback" title="Rollback… (Ctrl+Alt+Z)" disabled={!rollbackTargets().length} onClick={() => ws.rollbackFiles(rollbackTargets())}>
          <Icon name="rollback" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Show diff" title="Show Diff (Ctrl+D)" disabled={!selectedChange || selectedChange.status === 'U'} onClick={() => selectedChange && showDiff(selectedChange)}>
          <Icon name="columns" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Shelve changes" title="Shelve Changes (git stash)…" disabled={!changes.length} onClick={() => ws.setGitDialog({ kind: 'stash' })}>
          <Icon name="shelve" size={15} />
        </button>
        <button type="button" className={'icon-btn' + (prefs.groupByDir || prefs.showIgnored ? ' active' : '')} aria-label="View options" title="View Options" aria-haspopup="menu" onClick={viewMenu}>
          <Icon name="eye" size={15} />
        </button>
        <span className="strip-sep" style={{ width: 1, height: 16, margin: '0 4px' }} />
        <button type="button" className="icon-btn" aria-label="Select opened file" title="Select Opened File" disabled={!ws.activePath || !all.some((c) => c.path === ws.activePath)} onClick={locate}>
          <Icon name="target" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Expand all" title="Expand All" onClick={() => setCollapsed(new Set())}>
          <Icon name="expandAll" size={15} />
        </button>
        <button type="button" className="icon-btn" aria-label="Collapse all" title="Collapse All" onClick={() => setCollapsed(new Set(['changes', 'unversioned', 'ignored']))}>
          <Icon name="collapseAll" size={15} />
        </button>
      </div>

      <div
        ref={tree}
        className="panel-body tree"
        tabIndex={0}
        onKeyDown={(e) => {
          const c = selectedChange;
          if (!c) return;
          const ctrl = e.ctrlKey || e.metaKey;
          if (ctrl && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            showDiff(c);
          } else if (e.key === 'F4' || e.key === 'Enter') {
            e.preventDefault();
            if (c.status !== 'D') ws.openFile(c.path);
          } else if (e.key === ' ') {
            e.preventDefault();
            setIncluded([c], !isIn(c));
          } else if (ctrl && e.altKey && e.key.toLowerCase() === 'z' && c.status !== 'U') {
            e.preventDefault();
            ws.rollbackFiles([c]);
          } else if (ctrl && e.altKey && e.key.toLowerCase() === 'a' && c.status === 'U') {
            e.preventDefault();
            ws.runGit('Add to VCS', () => ws.gitRepo.add([c.path]));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const order = [...changes, ...unversioned];
            const i = order.findIndex((x) => x.path === c.path) + (e.key === 'ArrowDown' ? 1 : -1);
            if (order[i]) setSelected(order[i].path);
          }
        }}
      >
        {groupRow('changes', 'Changes', changes, changes.length)}
        {fileRows('changes', changes)}
        {changes.length === 0 && !collapsed.has('changes') && <div className="empty" style={{ padding: '4px 26px' }}>No changes.</div>}
        {unversioned.length > 0 && (
          <>
            {groupRow('unversioned', 'Unversioned Files', unversioned, unversioned.length)}
            {fileRows('unversioned', unversioned)}
          </>
        )}
        {prefs.showIgnored && (
          <>
            {groupRow('ignored', 'Ignored Files', null, ignored?.length ?? 0, 0, false)}
            {!collapsed.has('ignored') &&
              (ignored === null ? (
                <div className="muted" style={{ padding: '4px 26px' }}>Loading…</div>
              ) : (
                ignored.map((p) => (
                  <div key={p} className="row" style={{ paddingLeft: 26 }} title={p}>
                    <Icon name={p.endsWith('/') ? 'folder' : 'newFile'} size={14} />
                    <span className="name muted">{p.replace(/\/$/, '').split('/').pop()}</span>
                    <span className="detail">{p.replace(/\/$/, '').split('/').slice(0, -1).join('/') || ws.backend.name}</span>
                  </div>
                ))
              ))}
          </>
        )}
      </div>

      <div className="panel-foot">
        <div className="commit-mode-row">
          <div className="segmented" role="radiogroup" aria-label="Commit mode">
            {(
              [
                ['new', 'New', 'A new commit'],
                ['amend', 'Amend', 'Change the last commit (git commit --amend)'],
                ['fixup', 'Fixup', 'A fixup! commit for an earlier commit (git commit --fixup)'],
              ] as const
            ).map(([id, label, title]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={mode === id}
                className={'segment' + (mode === id ? ' on' : '')}
                title={title}
                onClick={(e) => setMode(id, (e.currentTarget as HTMLElement).getBoundingClientRect())}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn small"
            aria-label="Recent commits"
            title={mode === 'fixup' ? 'Choose the commit to fix' : 'Recent commits: reuse a message'}
            onClick={historyMenu}
          >
            <Icon name="history" size={14} />
          </button>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>
            {included.length} of {all.length} selected
          </span>
        </div>
        {mode === 'amend' && (
          <div className="commit-mode-line" title={amended ? `${amended.hash}\n${amended.author}` : undefined}>
            <span className="muted">Amending:</span>
            <span className="commit-mode-target">{amended?.subject ?? 'the last commit'}</span>
            {amended && <span className="mono muted">{amended.short}</span>}
          </div>
        )}
        {mode === 'fixup' && (
          <div className="commit-mode-line">
            <span className="muted">Fixup of:</span>
            <button
              type="button"
              className="link-btn commit-mode-target"
              title={fixup ? `${fixup.commit.short} ${fixup.commit.subject}` : 'Choose the commit to fix'}
              onClick={(e) => pickFixupTarget((e.currentTarget as HTMLElement).getBoundingClientRect())}
            >
              {fixup ? fixup.commit.subject : 'choose a commit'} ▾
            </button>
            {fixup && <span className="mono muted">{fixup.commit.short}</span>}
          </div>
        )}
        <label htmlFor="commit-message" className="sr-only">
          Commit message
        </label>
        <div className="commit-message-box">
        <textarea
          id="commit-message"
          className="textarea"
          rows={5}
          placeholder={fixupOn ? `fixup! ${fixup?.commit.subject ?? '…'}\n(optional: more lines for the commit body)` : 'Commit Message'}
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
          {isTauri && !fixupOn && (
            <button
              type="button"
              className={'icon-btn small commit-ai' + (generating ? ' busy' : '')}
              title={generating ? 'Stop generating' : included.length ? 'Generate the commit message with AI' : 'Select changes to commit first'}
              aria-label={generating ? 'Stop generating' : 'Generate the commit message with AI'}
              disabled={!generating && !included.length}
              onClick={() => void generateMessage()}
            >
              <Icon name={generating ? 'stopSquare' : 'sparkle'} size={13} />
            </button>
          )}
        </div>
        {fixupOn && (
          <label className="settings-check" title="git rebase -i --autosquash, without the editor; other local changes are stashed and restored">
            <input type="checkbox" className="checkbox" checked={prefs.squashFixup} onChange={(e) => setPrefs({ squashFixup: e.target.checked })} />
            Squash into {fixup ? `${fixup.commit.short}` : 'the target'} now
            {fixup?.pushed && prefs.squashFixup && <span className="error-text" style={{ marginLeft: 6 }}>(pushed: needs a force push)</span>}
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <button type="button" className="btn" onClick={() => submit(false)} disabled={busy} title="Commit (Ctrl+Enter)">
            {busy ? 'Committing…' : amend ? 'Amend Commit' : fixupOn ? 'Commit Fixup' : 'Commit'}
          </button>
          <button type="button" className="btn" onClick={() => submit(true)} disabled={busy} title="Commit, then review and push">
            {amend ? 'Amend Commit and Push…' : fixupOn ? 'Commit Fixup and Push…' : 'Commit and Push…'}
          </button>
          <span className="grow" />
          <button type="button" className={'icon-btn' + (prefs.signOff ? ' active' : '')} aria-label="Commit options" title="Commit Options" aria-haspopup="menu" onClick={optionsMenu}>
            <Icon name="gear" size={15} />
          </button>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

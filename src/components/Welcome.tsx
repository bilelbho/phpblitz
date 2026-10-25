// The welcome window, shown when no project is open: recent projects with search, New Project,
// Open and Clone Repository, plus a Customize page for the theme and font sizes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { homeDir } from '@tauri-apps/api/path';
import { colorOfProject, projectInitials, shortPath } from '../projectColors';
import { forgetProject, isTauri, pickFolder, recentProjects } from '../platform';
import { KEYMAPS } from '../keymap/keymaps';
import { shortcut } from '../keymap/store';
import { getSettings, saveSettings, useSettings, type UiSettings } from '../settings';
import { MAX_ZOOM, MIN_ZOOM } from '../uiSettings';
import { openAppDialog, useAppDialog } from '../appDialogs';
import { Icon, Logo } from './Icon';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { ThemeOptions } from './SettingsAppearance';
import { WindowControls } from './WindowControls';
import { AboutDialog } from './lazy';
import { ErrorLogDialog } from './ErrorLogDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { checkForUpdates, RELEASES_URL, restartToUpdate, useUpdateState } from '../updater';

interface Props {
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  /** Only in the browser preview, where folders can't be opened. */
  onOpenSample?: () => void;
}

type Page = 'projects' | 'customize';

const nameOf = (path: string) => path.split('/').pop() || path;
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
const toNative = (path: string) => (/^[A-Za-z]:\//.test(path) ? path.replace(/\//g, '\\') : path);

export function Welcome({ onOpenFolder, onOpenPath, onOpenSample }: Props) {
  const [page, setPage] = useState<Page>('projects');
  const [version, setVersion] = useState('');
  const [gear, setGear] = useState<{ x: number; y: number } | null>(null);
  const appDialog = useAppDialog();

  useEffect(() => {
    if (isTauri) getVersion().then(setVersion, () => {});
  }, []);

  return (
    <div className="app">
      <header className="topbar" data-tauri-drag-region>
        <span style={{ display: 'inline-flex', padding: '0 8px' }}>
          <Logo size={18} />
        </span>
        <span className="tw-title" data-tauri-drag-region>
          Welcome to PHPBlitz
        </span>
        <div className="drag" data-tauri-drag-region />
        <WindowControls />
      </header>
      <main className="welcome island">
        <nav className="welcome-side" aria-label="Welcome">
          <div className="welcome-brand">
            <Logo size={34} />
            <span>
              <span className="welcome-brand-name">PHPBlitz</span>
              <span className="welcome-brand-version">{version || 'A fast PHP IDE'}</span>
            </span>
          </div>
          {(['projects', 'customize'] as const).map((p) => (
            <button key={p} type="button" className={'welcome-nav' + (page === p ? ' active' : '')} aria-current={page === p ? 'page' : undefined} onClick={() => setPage(p)}>
              {p === 'projects' ? 'Projects' : 'Customize'}
            </button>
          ))}
          <span className="grow" />
          <UpdateNote />
          <button
            type="button"
            className="icon-btn welcome-gear"
            aria-label="Help"
            title="Help"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setGear({ x: r.left, y: r.top - 8 });
            }}
          >
            <Icon name="gear" size={16} />
          </button>
        </nav>
        <section className="welcome-content">{page === 'projects' ? <Projects onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onOpenSample={onOpenSample} /> : <Customize />}</section>
      </main>
      {gear && (
        <ContextMenu
          x={gear.x}
          y={gear.y - 100}
          items={[
            { label: 'Check for Updates', disabled: !isTauri, run: () => void checkForUpdates({ manual: true }) },
            { kind: 'sep' },
            { label: 'About PHPBlitz', run: () => openAppDialog('about') },
            { label: 'Open Source Licenses', run: () => openAppDialog('licenses') },
          ]}
          onClose={() => setGear(null)}
        />
      )}
      {appDialog === 'errors' && <ErrorLogDialog onClose={() => openAppDialog(null)} />}
      {(appDialog === 'about' || appDialog === 'licenses') && <AboutDialog view={appDialog} onClose={() => openAppDialog(null)} />}
    </div>
  );
}

/** The update state, above the gear: downloading, ready to install, or the result of a check. */
function UpdateNote() {
  const update = useUpdateState();
  if (update.kind === 'downloading')
    return <div className="welcome-update muted">Downloading PHPBlitz {update.version}{update.percent !== null ? ` (${update.percent}%)` : ''}…</div>;
  if (update.kind === 'ready')
    return (
      <div className="welcome-update">
        <span>PHPBlitz {update.version} is ready.</span>
        <button type="button" className="btn primary small" onClick={() => void restartToUpdate().catch(() => {})}>
          Restart and Update
        </button>
      </div>
    );
  if (update.kind === 'available')
    return (
      <div className="welcome-update">
        <span>PHPBlitz {update.version} is available.</span>
        <button type="button" className="btn small" onClick={() => void invoke('open_external', { url: RELEASES_URL }).catch(() => {})}>
          Download
        </button>
      </div>
    );
  if (update.manual && update.kind === 'checking') return <div className="welcome-update muted">Checking for updates…</div>;
  if (update.manual && update.kind === 'none') return <div className="welcome-update muted">PHPBlitz is up to date.</div>;
  if (update.manual && update.kind === 'error') return <div className="welcome-update error-text" title={update.message}>Could not check for updates.</div>;
  return null;
}

interface Recent {
  path: string;
  name: string;
  branch?: string;
  missing?: boolean;
}

/** Recent projects, their git branch, and whether the folder still exists. */
function useRecent(): [Recent[], (path: string) => void] {
  const [list, setList] = useState<Recent[]>(() => (isTauri ? recentProjects() : []).map((path) => ({ path, name: nameOf(path) })));

  useEffect(() => {
    if (!isTauri) return;
    let live = true;
    for (const { path } of list) {
      const update = (patch: Partial<Recent>) => live && setList((l) => l.map((r) => (r.path === path ? { ...r, ...patch } : r)));
      invoke('list_dir', { path }).then(
        () =>
          invoke<{ code: number; stdout: string }>('run_process', { cwd: path, program: 'git', args: ['branch', '--show-current'] }).then(
            (r) => r.code === 0 && r.stdout.trim() && update({ branch: r.stdout.trim() }),
            () => {},
          ),
        () => update({ missing: true }),
      );
    }
    return () => {
      live = false;
    };
    // Once per welcome screen; removing a project shouldn't rescan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = (path: string) => {
    forgetProject(path);
    setList((l) => l.filter((r) => r.path !== path));
  };
  return [list, remove];
}

function Projects({ onOpenFolder, onOpenPath, onOpenSample }: Props) {
  const [recent, remove] = useRecent();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [dialog, setDialog] = useState<'new' | 'clone' | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? recent.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : recent;
  }, [recent, query]);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => search.current?.focus(), []);

  const open = (r: Recent) => !r.missing && onOpenPath(r.path);
  const menuFor = (r: Recent): ContextItem[] => [
    { label: 'Open', disabled: r.missing, run: () => open(r) },
    { label: 'Show in Explorer', icon: 'explorer', disabled: r.missing, run: () => void invoke('reveal_in_explorer', { path: r.path }).catch(() => {}) },
    { label: 'Copy Path', icon: 'copy', run: () => void navigator.clipboard.writeText(toNative(r.path)).catch(() => {}) },
    { kind: 'sep' },
    { label: 'Remove from Recent Projects', run: () => remove(r.path) },
  ];
  // Where new and cloned projects go: next to the last project, else the home folder.
  const location = recent.find((r) => !r.missing)?.path;

  const actions = (
    <>
      <button type="button" className="btn" disabled={!isTauri} onClick={() => setDialog('new')}>
        New Project
      </button>
      <button type="button" className="btn" disabled={!isTauri} onClick={onOpenFolder}>
        Open
      </button>
      <button type="button" className="btn" disabled={!isTauri} onClick={() => setDialog('clone')}>
        Clone Repository
      </button>
    </>
  );
  const dialogs = (
    <>
      {dialog === 'new' && <NewProjectDialog near={location} onClose={() => setDialog(null)} onCreated={onOpenPath} />}
      {dialog === 'clone' && <CloneDialog near={location} onClose={() => setDialog(null)} onCloned={onOpenPath} />}
    </>
  );

  if (!recent.length)
    return (
      <div className="welcome-empty">
        <Logo size={56} />
        <h1>Welcome to PHPBlitz</h1>
        <p>Create a new project to start from scratch.</p>
        <p>Open an existing project from disk or version control.</p>
        <div className="welcome-empty-actions">{actions}</div>
        {!isTauri && (
          <p className="muted">
            Projects open in the desktop app only.{' '}
            {onOpenSample && (
              <button type="button" className="link-btn" onClick={onOpenSample}>
                Open the demo project
              </button>
            )}
          </p>
        )}
        {dialogs}
      </div>
    );

  return (
    <>
      <div className="welcome-head">
        <label className="welcome-search">
          <Icon name="search" size={15} />
          <input
            ref={search}
            value={query}
            placeholder="Search projects"
            aria-label="Search projects"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setSelected((i) => Math.min(i + 1, shown.length - 1));
              else if (e.key === 'ArrowUp') setSelected((i) => Math.max(i - 1, 0));
              else if (e.key === 'Enter' && shown[selected]) open(shown[selected]);
              else if (e.key === 'Escape' && query) setQuery('');
              else if (e.key === 'Delete' && !query && shown[selected]) remove(shown[selected].path);
              else return;
              e.preventDefault();
            }}
          />
        </label>
        <span className="grow" />
        {actions}
      </div>
      <div className="welcome-list" role="listbox" aria-label="Recent projects">
        {!shown.length && <div className="empty">No projects match “{query}”.</div>}
        {shown.map((r, i) => (
          <div
            key={r.path}
            role="option"
            aria-selected={i === selected}
            aria-disabled={r.missing || undefined}
            className={'welcome-project' + (i === selected ? ' selected' : '') + (r.missing ? ' missing' : '')}
            title={r.missing ? `${toNative(r.path)} was not found` : toNative(r.path)}
            onMouseEnter={() => setSelected(i)}
            onClick={() => open(r)}
            onContextMenu={(e) => {
              e.preventDefault();
              setSelected(i);
              setMenu({ x: e.clientX, y: e.clientY, items: menuFor(r) });
            }}
          >
            <span className="welcome-badge" style={{ background: colorOfProject(r.path, r.name) }}>
              {projectInitials(r.name)}
            </span>
            <span className="welcome-project-text">
              <span className="welcome-project-name">{r.name}</span>
              <span className="welcome-project-path">{r.missing ? `${shortPath(r.path)} (not found)` : shortPath(r.path)}</span>
              {r.branch && (
                <span className="welcome-project-path">
                  <Icon name="branch" size={12} /> {r.branch}
                </span>
              )}
            </span>
            <button
              type="button"
              className="icon-btn small welcome-project-more"
              aria-label={`Options for ${r.name}`}
              title="Options"
              onClick={(e) => {
                e.stopPropagation();
                const b = e.currentTarget.getBoundingClientRect();
                setMenu({ x: b.left, y: b.bottom + 2, items: menuFor(r) });
              }}
            >
              <Icon name="more" size={14} />
            </button>
          </div>
        ))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialogs}
    </>
  );
}

function Customize() {
  const settings = useSettings();
  const setUi = (patch: Partial<UiSettings>) => saveSettings({ ...getSettings(), ui: { ...getSettings().ui, ...patch } });
  const setEditorFont = (fontSize: number) => saveSettings({ ...getSettings(), editor: { ...getSettings().editor, fontSize } });
  const ui = settings.ui;
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

  return (
    <div className="welcome-customize">
      <h2>Appearance</h2>
      <div className="welcome-setting">
        <label htmlFor="welcome-theme">Theme:</label>
        {/* With Sync with OS the OS picks light or dark; the choice still picks islands or flat panels. */}
        <select id="welcome-theme" className="settings-select" value={ui.theme} onChange={(e) => setUi({ theme: e.target.value as UiSettings['theme'] })}>
          <ThemeOptions />
        </select>
        <label className="settings-check">
          <input type="checkbox" className="checkbox" checked={ui.syncOs} onChange={(e) => setUi({ syncOs: e.target.checked })} />
          Sync with OS
        </label>
      </div>
      <div className="welcome-setting">
        <label htmlFor="welcome-layout">Layout:</label>
        <select id="welcome-layout" className="settings-select" value={ui.layout} onChange={(e) => setUi({ layout: e.target.value as UiSettings['layout'] })}>
          <option value="classic">Classic</option>
          <option value="focus">Focus</option>
        </select>
      </div>
      <p className="muted">
        {ui.layout === 'focus'
          ? 'Tabs in the top bar; panels in columns you drag anywhere, beside, above or into each other.'
          : 'Tool window bars on the sides and a bottom panel.'}
      </p>
      <div className="welcome-setting">
        <label htmlFor="welcome-zoom">Zoom:</label>
        <select id="welcome-zoom" className="settings-select" value={ui.zoom} onChange={(e) => setUi({ zoom: Number(e.target.value) })}>
          {[80, 90, 100, 110, 125, 150, 175, 200]
            .filter((z) => z >= MIN_ZOOM && z <= MAX_ZOOM)
            .map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
        </select>
      </div>
      <h2>Editor</h2>
      <div className="welcome-setting">
        <label htmlFor="welcome-font">Font size:</label>
        <input id="welcome-font" type="number" className="settings-select welcome-number" min={8} max={40} value={settings.editor.fontSize} onChange={(e) => e.target.value && setEditorFont(clamp(Number(e.target.value), 8, 40))} />
      </div>
      <h2>Keymap</h2>
      <div className="welcome-setting">
        <label htmlFor="welcome-keymap">Keys like in:</label>
        <select id="welcome-keymap" className="settings-select" value={settings.keymap.preset} onChange={(e) => saveSettings({ ...getSettings(), keymap: { ...getSettings().keymap, preset: e.target.value } })}>
          {KEYMAPS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">Coming from another editor? Its keys work here. Change single shortcuts in Settings ▸ Keymap.</p>
      <p className="muted">More options are in Settings{shortcut('phpblitz.settings') ? ` (${shortcut('phpblitz.settings')})` : ''} once a project is open.</p>
    </div>
  );
}

/** Location field: a folder path typed in or picked with Browse. */
function FolderField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="welcome-folder">
      <div className="field">
        <input id={id} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      </div>
      <button
        type="button"
        className="btn"
        onClick={async () => {
          const picked = await pickFolder();
          if (picked) onChange(toNative(picked.replace(/\\/g, '/')));
        }}
      >
        Browse…
      </button>
    </div>
  );
}

/** The folder new and cloned projects go into by default. */
function useDefaultLocation(near?: string): [string, (v: string) => void] {
  const [location, setLocation] = useState(near ? toNative(parentOf(near)) : '');
  useEffect(() => {
    if (!near && isTauri) homeDir().then((h) => setLocation((cur) => cur || h), () => {});
  }, [near]);
  return [location, setLocation];
}

const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${name}`;
const VALID_NAME = /^[^\\/:*?"<>|]+$/;

function DialogShell({ title, busy, error, okLabel, canOk, onOk, onClose, children }: { title: string; busy: boolean; error: string; okLabel: string; canOk: boolean; onOk: () => void; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="pb-dialog welcome-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          if (canOk && !busy) onOk();
        }}
      >
        <div className="pb-dialog-title">{title}</div>
        <div className="pb-dialog-body">
          {children}
          {error && <div className="error-text welcome-dialog-error">{error}</div>}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canOk || busy}>
            {busy ? `${okLabel.replace(/e$/, '')}ing…` : okLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/** "https://github.com/acme/shop.git" → "shop" */
const repoName = (url: string) =>
  url
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/, '')
    .split(/[\\/:]/)
    .pop() ?? '';

function CloneDialog({ near, onClose, onCloned }: { near?: string; onClose: () => void; onCloned: (path: string) => void }) {
  const [url, setUrl] = useState('');
  const [location, setLocation] = useDefaultLocation(near);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = repoName(url);

  const clone = async () => {
    const parent = location.trim();
    const path = joinPath(parent, name);
    setBusy(true);
    setError('');
    try {
      const r = await invoke<{ code: number; stdout: string; stderr: string }>('run_process', { cwd: parent, program: 'git', args: ['clone', '--', url.trim(), name] });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'git clone failed');
      onClose();
      onCloned(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <DialogShell title="Clone Repository" busy={busy} error={error} okLabel="Clone" canOk={!!name && VALID_NAME.test(name) && !!location.trim()} onOk={clone} onClose={onClose}>
      <label htmlFor="clone-url">URL:</label>
      <div className="field">
        <input id="clone-url" value={url} autoFocus spellCheck={false} placeholder="https://github.com/owner/repository.git" onChange={(e) => setUrl(e.target.value)} />
      </div>
      <label htmlFor="clone-location">Directory:</label>
      <FolderField id="clone-location" value={location} onChange={setLocation} />
      {name && <span className="muted welcome-dialog-hint">Will clone into: {toNative(joinPath(location || '…', name))}</span>}
    </DialogShell>
  );
}

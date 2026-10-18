// The project widget's popup: Open… / Clone Repository…, the open project with
// its color, path and branch, recent projects, project color and Close Project.

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Workspace } from '../useWorkspace';
import { forgetProject, isTauri, recentProjects } from '../platform';
import { colorOfProject, PROJECT_PALETTE, projectInitials, setProjectColor, shortPath } from '../projectColors';
import { Icon } from './Icon';

interface Props {
  ws: Workspace;
  anchor: DOMRect;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onCloseProject: () => void;
  onColorChange: () => void;
  onClose: () => void;
}

export function ProjectPopup({ ws, anchor, onOpenFolder, onOpenPath, onCloseProject, onColorChange, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState(() => recentProjects().filter((p) => p !== ws.backend.root));
  const [cloning, setCloning] = useState(false);
  const { backend } = ws;

  useEffect(() => {
    box.current?.focus();
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', outside, true);
    return () => window.removeEventListener('mousedown', outside, true);
  }, [onClose]);

  const name = (p: string) => p.split('/').pop() ?? p;
  const badge = (root: string, label: string) => (
    <span className="pp-badge" style={{ background: colorOfProject(root, label) }}>
      {projectInitials(label)}
    </span>
  );

  if (cloning) return <CloneDialog onClose={() => (setCloning(false), onClose())} onCloned={(path) => (onClose(), onOpenPath(path))} />;

  return (
    <div
      ref={box}
      className="project-popup"
      tabIndex={-1}
      style={{ left: anchor.left, top: anchor.bottom + 4 }}
      role="dialog"
      aria-label="Projects"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <button type="button" className="pp-row pp-action" disabled={!isTauri} onClick={() => (onClose(), onOpenFolder())}>
        <Icon name="folderOpen" size={15} /> Open…
      </button>
      <button type="button" className="pp-row pp-action" disabled={!isTauri} onClick={() => setCloning(true)}>
        <Icon name="branch" size={15} /> Clone Repository…
      </button>

      <div className="pp-head">Open Projects</div>
      <div className="pp-row pp-project current" title={backend.root}>
        {badge(backend.root, backend.name)}
        <span className="pp-text">
          <span className="pp-name">{backend.name}</span>
          <span className="pp-path">{backend.kind === 'disk' ? shortPath(backend.root) : 'sample project'}</span>
          {ws.git && (
            <span className="pp-path">
              <Icon name="branch" size={11} /> {ws.git.branch}
            </span>
          )}
        </span>
      </div>
      <div className="pp-colors" role="radiogroup" aria-label="Project color">
        <span className="pp-colors-label">Color:</span>
        {PROJECT_PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={colorOfProject(backend.root, backend.name) === c}
            aria-label={`Project color ${c}`}
            className={'pp-swatch' + (colorOfProject(backend.root, backend.name) === c ? ' on' : '')}
            style={{ background: c }}
            onClick={() => {
              setProjectColor(backend.root, c);
              onColorChange();
            }}
          />
        ))}
      </div>

      {recent.length > 0 && <div className="pp-head">Recent Projects</div>}
      {recent.slice(0, 8).map((p) => (
        <div key={p} className="pp-row pp-project" role="button" tabIndex={0} title={p} onClick={() => (onClose(), onOpenPath(p))} onKeyDown={(e) => e.key === 'Enter' && (onClose(), onOpenPath(p))}>
          {badge(p, name(p))}
          <span className="pp-text">
            <span className="pp-name">{name(p)}</span>
            <span className="pp-path">{shortPath(p)}</span>
          </span>
          <button
            type="button"
            className="icon-btn small pp-remove"
            aria-label={`Remove ${name(p)} from recent projects`}
            title="Remove from Recent Projects"
            onClick={(e) => {
              e.stopPropagation();
              forgetProject(p);
              setRecent((r) => r.filter((x) => x !== p));
            }}
          >
            <Icon name="close" size={9} />
          </button>
        </div>
      ))}

      <div className="pp-sep" />
      <button type="button" className="pp-row pp-action" onClick={() => (onClose(), onCloseProject())}>
        <Icon name="close" size={12} /> Close Project
      </button>
    </div>
  );
}

/** Clone Repository: URL and the folder to clone into, then opens the project. */
function CloneDialog({ onClose, onCloned }: { onClose: () => void; onCloned: (path: string) => void }) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState('');
  const [folder, setFolder] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    // Default parent: where the most recent project lives.
    const last = recentProjects()[0];
    if (last) setParent(last.slice(0, last.lastIndexOf('/')));
  }, []);

  const guess = (u: string) => u.trim().replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? '';
  const target = parent && folder ? `${parent}/${folder}` : '';

  const browse = async () => {
    const picked = await open({ directory: true, multiple: false, title: 'Clone into', defaultPath: parent || undefined });
    if (typeof picked === 'string') setParent(picked.replace(/\\/g, '/'));
  };

  const clone = async () => {
    if (!url.trim() || !target || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await invoke<{ code: number; stdout: string; stderr: string }>('run_process', { cwd: parent, program: 'git', args: ['clone', url.trim(), folder] });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'git clone failed');
      onCloned(target);
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
        aria-label="Clone Repository"
        style={{ width: 560 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose();
          if (e.key === 'Enter') clone();
        }}
      >
        <div className="pb-dialog-title">Clone Repository</div>
        <div className="pb-dialog-body">
          <label htmlFor="clone-url">URL:</label>
          <div className="field">
            <input
              id="clone-url"
              ref={input}
              value={url}
              placeholder="https://github.com/acme/shop.git or git@github.com:acme/shop.git"
              spellCheck={false}
              onChange={(e) => {
                setUrl(e.target.value);
                if (!folderTouched) setFolder(guess(e.target.value));
              }}
            />
          </div>
          <label htmlFor="clone-dir">Directory:</label>
          <div className="settings-row">
            <div className="field grow">
              <input id="clone-dir" value={parent.replace(/\//g, '\\')} spellCheck={false} onChange={(e) => setParent(e.target.value.replace(/\\/g, '/'))} />
            </div>
            <button type="button" className="icon-btn" aria-label="Choose the parent folder" title="Browse…" onClick={browse}>
              <Icon name="folderOpen" size={15} />
            </button>
          </div>
          <label htmlFor="clone-folder">Folder name:</label>
          <div className="field">
            <input
              id="clone-folder"
              value={folder}
              spellCheck={false}
              onChange={(e) => {
                setFolderTouched(true);
                setFolder(e.target.value);
              }}
            />
          </div>
          {target && <span className="muted" style={{ fontSize: 12 }}>Clones into {target.replace(/\//g, '\\')}</span>}
          {error && <div className="error-text" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!url.trim() || !target || busy} onClick={clone}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  );
}

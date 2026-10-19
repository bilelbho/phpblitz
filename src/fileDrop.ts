// Files dragged in from Explorer / Finder / the file manager: dropped on the Project tree, they're
// copied into the folder under the mouse (the folder highlights while dragging); dropped anywhere
// else, files open in the editor. Tauri reports the drop with the files' paths.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { Workspace } from './useWorkspace';
import { isTauri } from './platform';

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
const norm = (p: string) => p.replace(/\\/g, '/');

/** `name`, or `name (2).ext`, `name (3).ext`… for the first one not in `taken`. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** The tree folder at a point of the window: a folder row, a file row's folder, or the project. */
function folderAt(x: number, y: number, root: string): { folder: string; row: HTMLElement | null } | null {
  const el = document.elementFromPoint(x, y);
  const tree = el?.closest('.project-tree, [aria-label="Project"]');
  if (!el || !tree) return null;
  const row = el.closest<HTMLElement>('[data-path]');
  if (!row) return { folder: root, row: null };
  const path = row.dataset.path!;
  if (row.dataset.dir !== undefined) return { folder: path, row };
  const folder = path.slice(0, path.lastIndexOf('/'));
  return { folder, row: tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(folder)}"]`) };
}

export function useFileDrop(workspace: Workspace) {
  // The drop reads the workspace as it is then, not as it was when the listener started.
  const latest = useRef(workspace);
  latest.current = workspace;
  const backend = workspace.backend;
  useEffect(() => {
    if (!isTauri || backend.kind !== 'disk') return;
    const ws = () => latest.current;
    let highlighted: HTMLElement | null = null;
    const highlight = (row: HTMLElement | null) => {
      if (row === highlighted) return;
      highlighted?.classList.remove('drop-target');
      row?.classList.add('drop-target');
      highlighted = row;
    };
    const root = backend.root;

    const copyInto = async (folder: string, paths: string[]) => {
      const names = new Set((await backend.listDir(folder).catch(() => [])).map((e) => e.name.toLowerCase()));
      const copied: string[] = [];
      const failed: string[] = [];
      for (const from of paths) {
        const name = freeName(baseName(from), (n) => names.has(n.toLowerCase()));
        names.add(name.toLowerCase());
        const to = `${folder}/${name}`;
        if (norm(from).replace(/\/$/, '') === to) continue;
        try {
          await invoke('copy_path', { from: norm(from), to });
          copied.push(to);
        } catch (e) {
          failed.push(`${baseName(from)}: ${e}`);
        }
      }
      await ws().loadDir(folder);
      if (copied.length) ws().revealInTree(copied[0]);
      const where = folder === root ? backend.name : folder.slice(root.length + 1);
      if (failed.length) ws().notify({ title: `Couldn't copy ${failed.length === 1 ? 'a file' : `${failed.length} files`}`, body: failed.join('\n'), tone: 'error' });
      if (copied.length) ws().setStatus(`Copied ${copied.length === 1 ? baseName(copied[0]) : `${copied.length} items`} to ${where}.`);
    };

    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'leave') return highlight(null);
        // Positions come in physical pixels.
        const x = p.position.x / window.devicePixelRatio;
        const y = p.position.y / window.devicePixelRatio;
        const target = folderAt(x, y, root);
        if (p.type === 'over' || p.type === 'enter') {
          highlight(target ? (target.row ?? document.querySelector<HTMLElement>(`[data-path="${CSS.escape(root)}"]`)) : null);
          return;
        }
        // Drop.
        highlight(null);
        if (!p.paths.length) return;
        if (target) void copyInto(target.folder, p.paths);
        else for (const path of p.paths) void ws().openFile(norm(path));
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
      highlight(null);
    };
  }, [backend]);
}

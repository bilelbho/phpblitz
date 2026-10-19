// Local History: the versions a file was saved with (kept by the Rust side on every save, see
// src-tauri/src/history.rs), each shown as a diff against the current text. Revert puts a version
// back: in an open file as one edit (Ctrl+Z undoes it), else by saving it.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from '../useWorkspace';
import { useSettings } from '../settings';
import { themeId } from '../editor/themes';
import { activeEditor } from '../editor/active';
import { Icon } from './Icon';

let current: string | null = null;
const listeners = new Set<() => void>();

/** Opens Local History for a file. */
export function openLocalHistory(path: string | null) {
  current = path;
  listeners.forEach((l) => l());
}

export function useLocalHistory(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

interface Version {
  time: number;
  size: number;
}

const baseName = (p: string) => p.split('/').pop() ?? p;

function when(time: number): string {
  const d = new Date(time);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const clock = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${clock}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${clock}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${clock}`;
}

const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`);

function languageOf(path: string): string {
  const open = monaco.editor.getModel(monaco.Uri.file(path));
  if (open) return open.getLanguageId();
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext))?.id ?? 'plaintext';
}

export function LocalHistoryDialog({ ws, path, onClose }: { ws: Workspace; path: string; onClose: () => void }) {
  const settings = useSettings().editor;
  const root = ws.backend.root;
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [same, setSame] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const models = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  /** The file's text now: the editor's (unsaved changes included) or the disk's. */
  const currentText = () => monaco.editor.getModel(monaco.Uri.file(path))?.getValue() ?? ws.backend.readFile(path);

  useEffect(() => {
    invoke<Version[]>('history_list', { root, path })
      .then(setVersions)
      .catch((e) => setError(String(e)));
  }, [root, path]);

  // The diff: the chosen version on the left, the current text on the right.
  useEffect(() => {
    const el = host.current;
    if (!el || !versions?.length) return;
    const language = languageOf(path);
    const original = monaco.editor.createModel('', language);
    const modified = monaco.editor.createModel('', language);
    models.current = { original, modified };
    const diff = monaco.editor.createDiffEditor(el, {
      // Set here too: with no file open, no editor has set the theme yet.
      theme: themeId(settings.scheme),
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: el.clientWidth > 700,
      fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
      fontSize: settings.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
      contextmenu: false,
    });
    diff.setModel({ original, modified });
    const changed = diff.onDidUpdateDiff(() => {
      const changes = diff.getLineChanges() ?? [];
      setSame(changes.length === 0);
      const c = changes[0];
      if (c) diff.getModifiedEditor().revealLineInCenter(c.modifiedStartLineNumber || c.modifiedEndLineNumber || 1);
    });
    return () => {
      changed.dispose();
      diff.dispose();
      original.dispose();
      modified.dispose();
      models.current = null;
    };
    // The editor settings apply the next time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, path]);

  useEffect(() => {
    const v = versions?.[chosen];
    if (!v) return;
    let stale = false;
    setText(null);
    Promise.all([invoke<string>('history_read', { root, path, time: v.time }), currentText()])
      .then(([old, now]) => {
        if (stale || !models.current) return;
        models.current.original.setValue(old);
        models.current.modified.setValue(now);
        setText(old);
        setError('');
      })
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, chosen, root, path]);

  useEffect(() => list.current?.querySelector<HTMLElement>('[aria-selected=true]')?.focus(), [versions]);

  const revert = async () => {
    if (text === null) return;
    const label = when(versions![chosen].time);
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    onClose();
    try {
      if (model) {
        await ws.openFile(path);
        // One edit, so Ctrl+Z brings the text back.
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        model.pushStackElement();
        // Ctrl+Z goes to the editor.
        activeEditor()?.focus();
        ws.setStatus(`Reverted ${baseName(path)} to ${label}. Save to keep it, Ctrl+Z to undo.`);
      } else {
        // Saving keeps the text it replaces in Local History too.
        await ws.backend.writeFile(path, text);
        await ws.openFile(path);
        ws.setStatus(`Reverted ${baseName(path)} to ${label}.`);
      }
    } catch (e) {
      ws.notify({ title: `Couldn't revert ${baseName(path)}`, body: String(e), tone: 'error' });
    }
  };

  const move = (by: number) => versions?.length && setChosen((i) => Math.max(0, Math.min(versions.length - 1, i + by)));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-dialog local-history"
        role="dialog"
        aria-modal="true"
        aria-label={`Local History of ${baseName(path)}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="ai-dialog-title">
          <Icon name="history" size={14} />
          <span className="ai-review-title">Local History: {baseName(path)}</span>
          <span className="muted ai-dialog-sub">{versions?.length ? `${versions.length} saved version${versions.length === 1 ? '' : 's'} · left: the version, right: now` : ''}</span>
        </div>
        {versions && !versions.length ? (
          <div className="muted local-history-empty">No saved versions yet. Every save from now on is kept here, also the ones never committed.</div>
        ) : (
          <div className="local-history-body">
            <div
              ref={list}
              className="local-history-list"
              role="listbox"
              aria-label="Versions"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(e.key === 'ArrowDown' ? 1 : -1);
                  requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-selected=true]')?.focus());
                } else if (e.key === 'Enter' && text !== null && !same) void revert();
              }}
            >
              {versions?.map((v, i) => (
                <div key={v.time} role="option" tabIndex={i === chosen ? 0 : -1} aria-selected={i === chosen} className="local-history-item" onClick={() => setChosen(i)}>
                  <span className="grow">{when(v.time)}</span>
                  <span className="muted">{size(v.size)}</span>
                </div>
              ))}
            </div>
            <div ref={host} className="ai-review-diff local-history-diff" />
          </div>
        )}
        {error && <div className="error-text ai-error">{error}</div>}
        <div className="pb-dialog-buttons">
          {same && text !== null && <span className="muted local-history-same">Same as the current text.</span>}
          <button type="button" className="btn primary" disabled={text === null || same} onClick={() => void revert()}>
            Revert to This Version
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

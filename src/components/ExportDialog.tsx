// Export data (table editor, query results): what to export, the format, then copy it or save it.

import { useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from '../useWorkspace';
import { isTauri } from '../platform';
import { EXPORT_FORMATS, exportText, type ExportData, type ExportFormat, type ExportOptions } from '../db/export';

export interface ExportScope {
  id: string;
  label: string;
  load: () => Promise<ExportData>;
}

const FORMAT_KEY = 'phpblitz.exportFormat';

export function ExportDialog({ ws, scopes, fileName, options, onClose }: { ws: Workspace; scopes: ExportScope[]; fileName: string; options: Omit<ExportOptions, 'header'>; onClose: () => void }) {
  const [scope, setScope] = useState(scopes[0].id);
  const [format, setFormat] = useState<ExportFormat>(() => {
    try {
      const f = localStorage.getItem(FORMAT_KEY) as ExportFormat | null;
      return f && EXPORT_FORMATS.some((x) => x.id === f) ? f : 'csv';
    } catch {
      return 'csv';
    }
  });
  const [header, setHeader] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const build = async () => {
    setError('');
    setBusy('Reading the data…');
    try {
      localStorage.setItem(FORMAT_KEY, format);
    } catch {
      // Only a convenience.
    }
    const data = await scopes.find((s) => s.id === scope)!.load();
    return { data, text: exportText(format, data, { ...options, header }) };
  };

  const run = async (to: 'clipboard' | 'file') => {
    try {
      const extension = EXPORT_FORMATS.find((f) => f.id === format)!.extension;
      let path: string | null = null;
      if (to === 'file' && isTauri) {
        path = await save({ defaultPath: `${fileName}.${extension}`, filters: [{ name: EXPORT_FORMATS.find((f) => f.id === format)!.label, extensions: [extension] }] });
        if (!path) return;
      }
      const { data, text } = await build();
      setBusy('Writing…');
      if (to === 'clipboard') await navigator.clipboard.writeText(text);
      else if (path) await invoke('write_file', { path, content: text });
      else {
        // The browser demo: a download.
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        a.download = `${fileName}.${extension}`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
      const rows = `${data.rows.length.toLocaleString()} ${data.rows.length === 1 ? 'row' : 'rows'}`;
      ws.setStatus(to === 'clipboard' ? `Copied ${rows} as ${format.toUpperCase()}` : `Exported ${rows} to ${path ?? `${fileName}.${extension}`}`);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pb-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" style={{ width: 420 }} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="pb-dialog-title" id="export-title">
          Export Data
        </div>
        <div className="pb-dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {scopes.length > 1 && (
            <fieldset className="export-group">
              <legend>Rows</legend>
              {scopes.map((s) => (
                <label key={s.id} className="settings-check">
                  <input type="radio" name="export-scope" checked={scope === s.id} onChange={() => setScope(s.id)} />
                  {s.label}
                </label>
              ))}
            </fieldset>
          )}
          <label htmlFor="export-format">Format:</label>
          <select id="export-format" className="te-size" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {EXPORT_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {(format === 'csv' || format === 'tsv') && (
            <label className="settings-check">
              <input type="checkbox" className="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
              Column names on the first line
            </label>
          )}
          {busy && <span className="muted">{busy}</span>}
          {error && <span className="error-text">{error}</span>}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => void run('clipboard')}>
            Copy to Clipboard
          </button>
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run('file')}>
            Save to File…
          </button>
        </div>
      </div>
    </div>
  );
}

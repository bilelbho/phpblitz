// Data Sources dialog (Database tool window ▸ +): driver, connection details, Test Connection,
// and "Import from .env" for Laravel (DB_*) and Symfony (DATABASE_URL) projects.

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Workspace } from '../useWorkspace';
import { DRIVERS, defaultName, type DataSource, type Driver } from '../db/types';
import { dataSourceFromEnv, db } from '../db/store';
import { isTauri } from '../platform';
import { Icon } from './Icon';

const newId = () => `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function DataSourceDialog({ ws, source, onClose }: { ws: Workspace; source: DataSource | null; onClose: (saved?: DataSource) => void }) {
  const [ds, setDs] = useState<DataSource>(
    () =>
      source ?? {
        id: newId(),
        name: '',
        driver: 'postgres',
        host: 'localhost',
        port: 5432,
        user: '',
        database: '',
        file: '',
        ssl: false,
        savePassword: true,
      },
  );
  const [password, setPassword] = useState('');
  /** Editing a data source with a saved password: empty field = keep it. */
  const [hasSaved, setHasSaved] = useState(false);
  const [nameTouched, setNameTouched] = useState(!!source);
  const [test, setTest] = useState<{ state: 'running' | 'ok' | 'error'; text: string } | null>(null);
  const [envNote, setEnvNote] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const disk = ws.backend.kind === 'disk';

  useEffect(() => {
    first.current?.focus();
    if (source && isTauri) invoke<boolean>('db_has_password', { id: source.id }).then(setHasSaved).catch(() => {});
  }, [source]);

  const set = (patch: Partial<DataSource>) =>
    setDs((d) => {
      const next = { ...d, ...patch };
      if (!nameTouched) next.name = defaultName(next);
      return next;
    });

  const pickDriver = (driver: Driver) => {
    const info = DRIVERS.find((d) => d.id === driver);
    set({ driver, port: info?.port });
    setTest(null);
  };

  const typedPassword = () => (password || !hasSaved ? password : undefined);

  const runTest = async () => {
    setTest({ state: 'running', text: 'Connecting…' });
    try {
      const version = await invoke<string>('db_test', { source: ds, password: typedPassword() ?? null });
      setTest({ state: 'ok', text: `Succeeded. ${version}` });
    } catch (e) {
      setTest({ state: 'error', text: String(e) });
    }
  };

  const importEnv = async () => {
    const root = ws.backend.root;
    for (const name of ['.env.local', '.env']) {
      const text = await ws.backend.readFile(`${root}/${name}`).catch(() => null);
      const found = text ? (dataSourceFromEnv(text) as (Partial<DataSource> & { password?: string }) | null) : null;
      if (!found) continue;
      const { password: pw, ...rest } = found;
      if (rest.driver === 'sqlite' && rest.file && !/^([A-Za-z]:|\/)/.test(rest.file)) rest.file = `${root}/${rest.file.replace(/^\.?\//, '')}`;
      const info = DRIVERS.find((d) => d.id === rest.driver);
      set({ port: info?.port, ...rest });
      if (pw !== undefined) setPassword(pw);
      setEnvNote(
        `Filled in from ${name}.` + (rest.host && !/^(localhost|127\.0\.0\.1|::1)$/.test(rest.host) ? ` "${rest.host}" may be a Docker service name: from PHPBlitz use localhost and the published port.` : ''),
      );
      return;
    }
    setEnvNote('No database settings found in .env (DB_CONNECTION or DATABASE_URL).');
  };

  const browseFile = async () => {
    if (!isTauri) return;
    const picked = await open({ multiple: false, title: 'SQLite database file', defaultPath: ws.backend.root, filters: [{ name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] }, { name: 'All files', extensions: ['*'] }] });
    if (typeof picked === 'string') set({ file: picked });
  };

  const valid = ds.driver === 'sqlite' ? !!ds.file.trim() : !!ds.host.trim();
  const save = async () => {
    if (!valid) return;
    const final = { ...ds, name: ds.name.trim() || defaultName(ds) };
    await db.save(final, typedPassword());
    onClose(final);
  };

  const sqlite = ds.driver === 'sqlite';
  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="jb-dialog ds-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Data Source"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') save();
        }}
      >
        <div className="settings-title">{source ? 'Data Source Properties' : 'New Data Source'}</div>
        <div className="ds-body">
          <div className="settings-grid">
            <label htmlFor="ds-name">Name:</label>
            <div className="field">
              <input
                id="ds-name"
                ref={first}
                value={ds.name}
                placeholder={defaultName(ds)}
                spellCheck={false}
                onChange={(e) => {
                  setNameTouched(true);
                  setDs((d) => ({ ...d, name: e.target.value }));
                }}
              />
            </div>
            <span>Driver:</span>
            <div className="settings-row wrap" role="radiogroup" aria-label="Driver">
              {DRIVERS.map((d) => (
                <button key={d.id} type="button" role="radio" aria-checked={ds.driver === d.id} className={'chip-btn' + (ds.driver === d.id ? ' on' : '')} onClick={() => pickDriver(d.id)}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>

          <div className="ds-section">
            <span>Connection</span>
            {disk && (
              <button type="button" className="link-btn" onClick={importEnv}>
                Import from .env
              </button>
            )}
          </div>
          {envNote && <div className="muted ds-note">{envNote}</div>}

          {sqlite ? (
            <div className="settings-grid">
              <label htmlFor="ds-file">File:</label>
              <div className="settings-row">
                <div className="field grow">
                  <input id="ds-file" value={ds.file} placeholder="database/database.sqlite" spellCheck={false} onChange={(e) => set({ file: e.target.value })} />
                </div>
                <button type="button" className="icon-btn" aria-label="Browse for the database file" title="Browse…" disabled={!isTauri} onClick={browseFile}>
                  <Icon name="folderOpen" size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-grid">
              <label htmlFor="ds-host">Host:</label>
              <div className="settings-row">
                <div className="field grow">
                  <input id="ds-host" value={ds.host} spellCheck={false} onChange={(e) => set({ host: e.target.value })} />
                </div>
                <label htmlFor="ds-port" style={{ marginLeft: 8 }}>
                  Port:
                </label>
                <div className="field" style={{ width: 90 }}>
                  <input id="ds-port" inputMode="numeric" value={ds.port ?? ''} onChange={(e) => set({ port: e.target.value ? Number(e.target.value.replace(/\D/g, '')) || undefined : undefined })} />
                </div>
              </div>
              <label htmlFor="ds-user">User:</label>
              <div className="field">
                <input id="ds-user" value={ds.user} spellCheck={false} autoComplete="off" onChange={(e) => set({ user: e.target.value })} />
              </div>
              <label htmlFor="ds-password">Password:</label>
              <div className="settings-row">
                <div className="field grow">
                  <input
                    id="ds-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    placeholder={hasSaved ? '<saved>' : ''}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <label className="settings-check" style={{ marginLeft: 8 }}>
                  <input type="checkbox" className="checkbox" checked={ds.savePassword} onChange={(e) => set({ savePassword: e.target.checked })} />
                  Save
                </label>
              </div>
              <label htmlFor="ds-db">Database:</label>
              <div className="field">
                <input id="ds-db" value={ds.database} spellCheck={false} onChange={(e) => set({ database: e.target.value })} />
              </div>
              <span />
              <label className="settings-check">
                <input type="checkbox" className="checkbox" checked={ds.ssl} onChange={(e) => set({ ssl: e.target.checked })} />
                Use SSL (encrypted; server certificate not verified)
              </label>
            </div>
          )}

          <div className="ds-test">
            <button type="button" className="link-btn" onClick={runTest} disabled={!valid || test?.state === 'running' || !isTauri}>
              Test Connection
            </button>
            {test && <span className={'ds-test-result ' + test.state}>{test.text}</span>}
            {!isTauri && <span className="muted">Connections need the desktop app.</span>}
          </div>
        </div>
        <div className="jb-dialog-buttons settings-buttons">
          <button type="button" className="btn primary" disabled={!valid} onClick={save}>
            OK
          </button>
          <button type="button" className="btn" onClick={() => onClose()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

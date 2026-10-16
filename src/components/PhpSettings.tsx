// Settings ▸ PHP, like PhpStorm's: language level, CLI interpreter (with the CLI Interpreters
// dialog: local, Docker, Docker Compose, SSH), and the Include Path / PHP Runtime / Composer Files tabs.

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Workspace } from '../useWorkspace';
import type { Entry } from '../backend/types';
import { isTauri } from '../platform';
import {
  LANGUAGE_LEVELS,
  allInterpreters,
  cachedInspect,
  composeServices,
  composerPhpLevel,
  interpretersFor,
  kindLabel,
  newInterpreter,
  pathMappings,
  projectPhp,
  saveInterpreters,
  useInterpreters,
  type ComposeService,
  type Interpreter,
  type InterpreterKind,
  type PathMapping,
  type PhpInfo,
  type ProjectPhp,
} from '../interpreters';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon } from './Icon';

const nativePath = (p: string) => (/^[A-Za-z]:\//.test(p) ? p.replace(/\//g, '\\') : p);

/** The PHP page. `draft` is saved by the Settings dialog's OK / Apply. */
export function PhpPage({ ws, draft, onChange }: { ws: Workspace; draft: ProjectPhp; onChange: (patch: Partial<ProjectPhp>) => void }) {
  useInterpreters();
  const root = ws.backend.root;
  const list = interpretersFor(root);
  const current = list.find((i) => i.id === draft.interpreterId) ?? null;
  const [dialog, setDialog] = useState(false);
  const [tab, setTab] = useState<'include' | 'runtime' | 'composer'>('include');
  const [composerJson, setComposerJson] = useState<string | null>(null);
  const [info, setInfo] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; info?: PhpInfo; error?: string }>({ state: 'idle' });

  useEffect(() => {
    ws.backend.readFile(`${root}/composer.json`).then(setComposerJson).catch(() => setComposerJson(null));
  }, [ws.backend, root]);

  useEffect(() => {
    if (!current) return setInfo({ state: 'idle' });
    let live = true;
    setInfo({ state: 'loading' });
    cachedInspect(current, root)
      .then((i) => live && setInfo({ state: 'ok', info: i }))
      .catch((e) => live && setInfo({ state: 'error', error: String(e instanceof Error ? e.message : e) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(current), root]);

  const fromComposer = composerPhpLevel(composerJson);
  const fromInterpreter = info.info?.version.split('.').slice(0, 2).join('.');
  const autoLevel = fromComposer ?? fromInterpreter ?? '8.4';
  const levelLabel = (id: string) => `${id} (${LANGUAGE_LEVELS.find((l) => l.id === id)?.features ?? ''})`;

  return (
    <>
      <div className="settings-grid" style={{ marginTop: 10 }}>
        <label htmlFor="php-level">PHP language level:</label>
        <select id="php-level" className="settings-select wide" value={draft.languageLevel} onChange={(e) => onChange({ languageLevel: e.target.value })}>
          <option value="auto">
            Auto: {levelLabel(autoLevel)} {fromComposer ? '· from composer.json' : fromInterpreter ? '· from the interpreter' : ''}
          </option>
          {LANGUAGE_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {levelLabel(l.id)}
            </option>
          ))}
        </select>
        <label htmlFor="php-interpreter">CLI Interpreter:</label>
        <div className="settings-row">
          <select id="php-interpreter" className="settings-select wide grow" value={draft.interpreterId} onChange={(e) => onChange({ interpreterId: e.target.value })}>
            <option value="">&lt;no interpreter&gt;</option>
            {list.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({kindLabel(i)})
              </option>
            ))}
          </select>
          <button type="button" className="btn small" title="CLI Interpreters…" onClick={() => setDialog(true)}>
            …
          </button>
        </div>
        <span />
        <InterpreterStatus info={info} />
      </div>

      <div className="php-tabs" role="tablist">
        {(
          [
            ['include', 'Include Path'],
            ['runtime', 'PHP Runtime'],
            ['composer', 'Composer Files'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={'tw-tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'include' && <IncludePaths ws={ws} draft={draft} onChange={onChange} />}
      {tab === 'runtime' && <Runtime info={info} />}
      {tab === 'composer' && <ComposerFiles ws={ws} composerJson={composerJson} />}

      {dialog && (
        <CliInterpreters
          ws={ws}
          selected={draft.interpreterId}
          onClose={(chosen) => {
            setDialog(false);
            if (chosen !== undefined) onChange({ interpreterId: chosen });
          }}
        />
      )}
    </>
  );
}

function InterpreterStatus({ info }: { info: { state: string; info?: PhpInfo; error?: string } }) {
  if (info.state === 'idle') return <span className="muted">Choose an interpreter to run tests, Composer and the debugger with it.</span>;
  if (info.state === 'loading') return <span className="muted">Checking the interpreter…</span>;
  if (info.state === 'error')
    return (
      <span className="php-status error" title={info.error}>
        <Icon name="error" size={13} /> {info.error?.split('\n')[0]}
      </span>
    );
  const i = info.info!;
  return (
    <span className="php-status">
      <span className="ok">
        <Icon name="check" size={13} strokeWidth={2.4} /> PHP {i.version}
      </span>
      <span className={i.xdebug ? 'ok' : 'muted'}>Debugger: {i.xdebug ? `Xdebug ${i.xdebug}${i.xdebugMode ? ` (mode: ${i.xdebugMode})` : ''}` : 'Not installed'}</span>
    </span>
  );
}

/** Include Path: vendor packages (automatic) and folders added by hand. */
function IncludePaths({ ws, draft, onChange }: { ws: Workspace; draft: ProjectPhp; onChange: (patch: Partial<ProjectPhp>) => void }) {
  const root = ws.backend.root;
  const [vendor, setVendor] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const vendors = await ws.backend.listDir(`${root}/vendor`).catch(() => [] as Entry[]);
      const packages = await Promise.all(
        vendors.filter((v) => v.isDir && v.name !== 'bin').map((v) => ws.backend.listDir(v.path).then((ps) => (v.name === 'composer' ? [v] : ps.filter((p) => p.isDir))).catch(() => [] as Entry[])),
      );
      if (live) setVendor(packages.flat().map((p) => p.path).sort());
    })();
    return () => {
      live = false;
    };
  }, [ws.backend, root]);

  const add = async () => {
    if (!isTauri) return;
    const picked = await open({ directory: true, multiple: false, title: 'Add include path', defaultPath: root });
    if (typeof picked === 'string') {
      const p = picked.replace(/\\/g, '/');
      if (!draft.includePaths.includes(p)) onChange({ includePaths: [...draft.includePaths, p] });
    }
  };

  return (
    <div className="php-list">
      <div className="php-list-tools">
        <button type="button" className="icon-btn small" title="Add" aria-label="Add include path" disabled={!isTauri} onClick={add}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="icon-btn small" title="Remove" aria-label="Remove include path" disabled={!selected || !draft.includePaths.includes(selected)} onClick={() => onChange({ includePaths: draft.includePaths.filter((p) => p !== selected) })}>
          <Icon name="minus" size={14} />
        </button>
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
          Packages in vendor/ are added automatically (green).
        </span>
      </div>
      <div className="php-list-body">
        {draft.includePaths.map((p) => (
          <div key={p} className={'php-list-row' + (selected === p ? ' selected' : '')} onClick={() => setSelected(p)}>
            <Icon name="folder" size={14} /> {nativePath(p)}
          </div>
        ))}
        {vendor === null && <div className="muted php-list-row">Reading vendor/…</div>}
        {vendor?.map((p) => (
          <div key={p} className="php-list-row vendor" title="From Composer (vendor/)">
            <Icon name="folder" size={14} /> {nativePath(p)}
          </div>
        ))}
        {vendor?.length === 0 && !draft.includePaths.length && <div className="muted php-list-row">No packages in vendor/. Run composer install.</div>}
      </div>
    </div>
  );
}

function Runtime({ info }: { info: { state: string; info?: PhpInfo; error?: string } }) {
  if (!info.info) return <div className="muted php-pad">{info.state === 'loading' ? 'Checking the interpreter…' : 'Choose a working interpreter to see its PHP runtime.'}</div>;
  const i = info.info;
  return (
    <div className="php-pad">
      <div className="settings-grid">
        <span>PHP:</span>
        <span>
          {i.version} · {i.os}
        </span>
        <span>Binary:</span>
        <span className="mono">{i.binary}</span>
        <span>php.ini:</span>
        <span className="mono">{i.ini || '(none loaded)'}</span>
      </div>
      <div className="muted" style={{ margin: '10px 0 6px' }}>
        {i.extensions.length} extensions loaded
      </div>
      <div className="php-extensions">
        {[...i.extensions].sort((a, b) => a.localeCompare(b)).map((e) => (
          <span key={e} className={'chip' + (e.toLowerCase() === 'xdebug' ? ' ok' : '')}>
            {e}
          </span>
        ))}
      </div>
    </div>
  );
}

function ComposerFiles({ ws, composerJson }: { ws: Workspace; composerJson: string | null }) {
  const root = ws.backend.root;
  const parsed = useMemo(() => {
    try {
      return composerJson ? JSON.parse(composerJson) : null;
    } catch {
      return null;
    }
  }, [composerJson]);
  return (
    <div className="php-pad">
      <div className="settings-grid">
        <span>Path to composer.json:</span>
        <span className="mono">{composerJson !== null ? nativePath(`${root}/composer.json`) : 'not found'}</span>
        <span>Vendor directory:</span>
        <span className="mono">{nativePath(`${root}/${parsed?.config?.['vendor-dir'] ?? 'vendor'}`)}</span>
        <span>PHP requirement:</span>
        <span className="mono">{parsed?.require?.php ?? '—'}</span>
      </div>
      {parsed?.autoload && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          Sources and test folders come from autoload / autoload-dev (Project tree ▸ Mark Directory As).
        </div>
      )}
    </div>
  );
}

// ── CLI Interpreters dialog ────────────────────────────────────

function CliInterpreters({ ws, selected, onClose }: { ws: Workspace; selected: string; onClose: (chosen?: string) => void }) {
  const root = ws.backend.root;
  const [list, setList] = useState<Interpreter[]>(() => allInterpreters());
  const visible = list.filter((i) => !i.projectRoot || i.projectRoot === root);
  const [currentId, setCurrentId] = useState<string | null>(selected || visible[0]?.id || null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [remote, setRemote] = useState(false);
  const current = list.find((i) => i.id === currentId) ?? null;
  const dirty = JSON.stringify(list) !== JSON.stringify(allInterpreters());

  const update = (patch: Partial<Interpreter>) => setList((l) => l.map((i) => (i.id === currentId ? { ...i, ...patch } : i)));
  const add = (i: Interpreter) => {
    setList((l) => [...l, i]);
    setCurrentId(i.id);
  };
  const uniqueName = (base: string) => {
    const used = new Set(list.map((i) => i.name));
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(`${base} (${n})`)) return `${base} (${n})`;
  };

  const addLocal = async () => {
    if (!isTauri) return;
    const found = await invoke<string | null>('find_executable', { names: ['php'] }).catch(() => null);
    const picked = await open({ multiple: false, title: 'PHP executable', defaultPath: found ?? undefined, filters: [{ name: 'PHP', extensions: ['exe', ''] }] });
    if (typeof picked === 'string') add(newInterpreter('local', { name: uniqueName('PHP'), phpPath: picked.replace(/\\/g, '/') }));
  };

  const plusMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'Select CLI Interpreter', disabled: true },
        { label: 'From Docker, Docker Compose, SSH…', run: () => setRemote(true) },
        { label: 'Local Path to Interpreter…', disabled: !isTauri, run: addLocal },
      ],
    });
  };

  const apply = () => saveInterpreters(list);

  return (
    <div className="modal-backdrop settings-backdrop" style={{ zIndex: 90 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="jb-dialog cli-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="CLI Interpreters"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !remote && !menu) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="settings-title">CLI Interpreters</div>
        <div className="cli-main">
          <div className="cli-list">
            <div className="php-list-tools">
              <button type="button" className="icon-btn small" title="Add" aria-label="Add interpreter" onClick={plusMenu}>
                <Icon name="plus" size={14} />
              </button>
              <button
                type="button"
                className="icon-btn small"
                title="Remove"
                aria-label="Remove interpreter"
                disabled={!current}
                onClick={() => {
                  setList((l) => l.filter((i) => i.id !== currentId));
                  setCurrentId(visible.find((i) => i.id !== currentId)?.id ?? null);
                }}
              >
                <Icon name="minus" size={14} />
              </button>
              <button type="button" className="icon-btn small" title="Copy" aria-label="Copy interpreter" disabled={!current} onClick={() => current && add({ ...current, id: newInterpreter(current.kind).id, name: uniqueName(`${current.name} copy`) })}>
                <Icon name="copy" size={13} />
              </button>
            </div>
            {visible.map((i) => (
              <button key={i.id} type="button" className={'cli-item' + (i.id === currentId ? ' active' : '')} onClick={() => setCurrentId(i.id)} title={kindLabel(i)}>
                <Icon name={i.kind === 'local' ? 'terminal' : 'box'} size={13} /> {i.name}
              </button>
            ))}
            {!visible.length && <div className="muted cli-empty">Nothing to show</div>}
          </div>
          <div className="cli-form">{current ? <InterpreterForm key={current.id} ws={ws} value={current} onChange={update} /> : <div className="muted cli-empty">Add an interpreter with +</div>}</div>
        </div>
        <div className="jb-dialog-buttons settings-buttons">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              apply();
              onClose(current?.id ?? '');
            }}
          >
            OK
          </button>
          <button type="button" className="btn" onClick={() => onClose()}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!dirty} onClick={apply}>
            Apply
          </button>
        </div>
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        {remote && (
          <RemoteInterpreterDialog
            ws={ws}
            onClose={(created) => {
              setRemote(false);
              if (created) add({ ...created, name: uniqueName(created.name) });
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The right side of the CLI Interpreters dialog. */
function InterpreterForm({ ws, value: i, onChange }: { ws: Workspace; value: Interpreter; onChange: (patch: Partial<Interpreter>) => void }) {
  const root = ws.backend.root;
  const [info, setInfo] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; info?: PhpInfo; error?: string }>({ state: 'idle' });
  const [mappings, setMappings] = useState<PathMapping[] | null>(null);
  const check = (refresh: boolean) => {
    setInfo({ state: 'loading' });
    cachedInspect(i, root, refresh)
      .then((info) => setInfo({ state: 'ok', info }))
      .catch((e) => setInfo({ state: 'error', error: String(e instanceof Error ? e.message : e) }));
    if (i.kind === 'compose') pathMappings(i, root).then(setMappings).catch(() => setMappings([]));
  };
  useEffect(() => {
    if (isTauri && (i.kind !== 'local' || i.phpPath)) check(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const browse = async (key: 'phpPath' | 'debuggerExtension', title: string) => {
    if (!isTauri || i.kind !== 'local') return;
    const picked = await open({ multiple: false, title });
    if (typeof picked === 'string') onChange({ [key]: picked.replace(/\\/g, '/') });
  };

  return (
    <>
      <div className="settings-grid">
        <label htmlFor="cli-name">Name:</label>
        <div className="settings-row">
          <div className="field grow">
            <input id="cli-name" value={i.name} spellCheck={false} onChange={(e) => onChange({ name: e.target.value })} />
          </div>
          <label className="settings-check" style={{ marginLeft: 12 }}>
            <input type="checkbox" className="checkbox" checked={!!i.projectRoot} onChange={(e) => onChange({ projectRoot: e.target.checked ? root : undefined })} />
            Visible only for this project
          </label>
        </div>
      </div>

      <h3 className="settings-section">{i.kind === 'local' ? 'General' : i.kind === 'compose' ? 'Docker Compose' : i.kind === 'docker' ? 'Docker' : 'SSH'}</h3>
      <div className="settings-grid">
        {i.kind === 'docker' && (
          <>
            <label htmlFor="cli-image">Image name:</label>
            <div className="field">
              <input id="cli-image" value={i.image ?? ''} placeholder="php:8.4-cli" spellCheck={false} onChange={(e) => onChange({ image: e.target.value })} />
            </div>
          </>
        )}
        {i.kind === 'compose' && <ComposeFields ws={ws} value={i} onChange={onChange} />}
        {i.kind === 'ssh' && (
          <>
            <label htmlFor="cli-host">Host:</label>
            <div className="settings-row">
              <div className="field grow">
                <input id="cli-host" value={i.host ?? ''} spellCheck={false} onChange={(e) => onChange({ host: e.target.value })} />
              </div>
              <label htmlFor="cli-port" style={{ marginLeft: 8 }}>
                Port:
              </label>
              <div className="field" style={{ width: 70 }}>
                <input id="cli-port" value={i.port ?? 22} onChange={(e) => onChange({ port: Number(e.target.value.replace(/\D/g, '')) || 22 })} />
              </div>
            </div>
            <label htmlFor="cli-user">User:</label>
            <div className="field">
              <input id="cli-user" value={i.user ?? ''} spellCheck={false} onChange={(e) => onChange({ user: e.target.value })} />
            </div>
            <label htmlFor="cli-key">Private key file:</label>
            <div className="field">
              <input id="cli-key" value={i.keyFile ?? ''} placeholder="~/.ssh/id_ed25519 (optional; uses your SSH agent otherwise)" spellCheck={false} onChange={(e) => onChange({ keyFile: e.target.value })} />
            </div>
          </>
        )}
        <label htmlFor="cli-php">{i.kind === 'local' ? 'PHP executable:' : 'PHP interpreter path:'}</label>
        <div className="settings-row">
          <div className="field grow">
            <input id="cli-php" value={i.kind === 'local' ? nativePath(i.phpPath) : i.phpPath} spellCheck={false} onChange={(e) => onChange({ phpPath: e.target.value.replace(/\\/g, '/') })} />
          </div>
          {i.kind === 'local' && (
            <button type="button" className="icon-btn" aria-label="Browse for php" title="Browse…" disabled={!isTauri} onClick={() => browse('phpPath', 'PHP executable')}>
              <Icon name="folderOpen" size={15} />
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Check the interpreter" title="Reload PHP info" disabled={!isTauri} onClick={() => check(true)}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <span>Configuration file:</span>
        <span className="mono muted">{info.info ? info.info.ini || '(none loaded)' : '—'}</span>
      </div>
      <div className="cli-status">
        {info.state === 'loading' && <span className="muted">Checking…</span>}
        {info.state === 'error' && (
          <span className="error-text" title={info.error}>
            <Icon name="error" size={13} /> PHP version: {info.error?.split('\n')[0] || 'Not installed'}
          </span>
        )}
        {info.state === 'ok' && (
          <>
            <span className="ok">
              <Icon name="check" size={13} strokeWidth={2.4} /> PHP version: {info.info!.version}
            </span>
            <span className={info.info!.xdebug ? 'ok' : 'muted'}>Debugger: {info.info!.xdebug ? `Xdebug ${info.info!.xdebug}` : 'Not installed'}</span>
          </>
        )}
        {info.state === 'idle' && <span className="muted">{isTauri ? 'Set the PHP path, then reload.' : 'Checking interpreters needs the desktop app.'}</span>}
      </div>

      {i.kind === 'compose' && (
        <>
          <h3 className="settings-section">Path Mappings</h3>
          <div className="cli-mappings">
            {mappings === null && <span className="muted">{isTauri ? "From the service's volumes…" : 'Read from the compose files in the desktop app.'}</span>}
            {mappings?.length === 0 && <span className="muted">No project folder is mounted into the service, so breakpoints can't be matched. Add a volume like ./:/var/www/html.</span>}
            {mappings?.map((m) => (
              <div key={m.remote} className="mono">
                {nativePath(m.local)} <span className="muted">→</span> {m.remote}
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="settings-section">Additional</h3>
      <div className="settings-grid">
        <label htmlFor="cli-debugger">Debugger extension:</label>
        <div className="field">
          <input id="cli-debugger" value={i.debuggerExtension} placeholder="Only when Xdebug isn't enabled in php.ini, e.g. xdebug.so" spellCheck={false} onChange={(e) => onChange({ debuggerExtension: e.target.value })} />
        </div>
        <label htmlFor="cli-options">Configuration options:</label>
        <div className="field">
          <input id="cli-options" value={i.options.join('; ')} placeholder="memory_limit=-1; xdebug.mode=debug" spellCheck={false} onChange={(e) => onChange({ options: e.target.value.split(';').map((s) => s.trim()).filter(Boolean) })} />
        </div>
        <span />
        <span className="muted" style={{ fontSize: 12 }}>
          Passed with PHP's -d option, separated by ;
        </span>
      </div>
    </>
  );
}

function ComposeFields({ ws, value: i, onChange }: { ws: Workspace; value: Interpreter; onChange: (patch: Partial<Interpreter>) => void }) {
  const root = ws.backend.root;
  const [services, setServices] = useState<ComposeService[] | null>(null);
  const [error, setError] = useState('');
  const files = (i.composeFiles ?? ['./docker-compose.yml']).join('; ');
  useEffect(() => {
    if (!isTauri) return;
    let live = true;
    composeServices(root, i.composeFiles ?? ['./docker-compose.yml'])
      .then((s) => {
        if (!live) return;
        setServices(s);
        setError('');
        // A PHP-looking service by default (app, php, php-fpm…).
        if (!i.service && s.length) onChange({ service: (s.find((x) => /php|app|web|backend/i.test(x.name) || /php/i.test(x.image ?? '')) ?? s[0]).name });
      })
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, files]);

  return (
    <>
      <label htmlFor="cli-compose">Configuration files:</label>
      <div className="field">
        <input id="cli-compose" value={files} spellCheck={false} onChange={(e) => onChange({ composeFiles: e.target.value.split(';').map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <label htmlFor="cli-service">Service:</label>
      <select id="cli-service" className="settings-select wide" value={i.service ?? ''} onChange={(e) => onChange({ service: e.target.value })}>
        {!i.service && <option value="">{services ? 'Choose a service' : 'Reading the compose files…'}</option>}
        {services?.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
            {s.image ? ` (${s.image})` : ''}
          </option>
        ))}
        {i.service && !services?.some((s) => s.name === i.service) && <option value={i.service}>{i.service}</option>}
      </select>
      {error && (
        <>
          <span />
          <span className="error-text" style={{ whiteSpace: 'pre-wrap' }}>
            {error}
          </span>
        </>
      )}
      <label htmlFor="cli-env">Environment variables:</label>
      <div className="field">
        <input id="cli-env" value={i.env ?? ''} placeholder="APP_ENV=dev; XDEBUG_MODE=debug" spellCheck={false} onChange={(e) => onChange({ env: e.target.value })} />
      </div>
      <span>Lifecycle:</span>
      <div className="settings-row">
        <label className="settings-radio">
          <input type="radio" name="cli-lifecycle" checked={(i.lifecycle ?? 'exec') === 'exec'} onChange={() => onChange({ lifecycle: 'exec' })} />
          Connect to existing container (exec)
        </label>
        <label className="settings-radio">
          <input type="radio" name="cli-lifecycle" checked={i.lifecycle === 'run'} onChange={() => onChange({ lifecycle: 'run' })} />
          Start a new container (run)
        </label>
      </div>
    </>
  );
}

/** "Configure Remote PHP Interpreter": SSH, Docker or Docker Compose. */
function RemoteInterpreterDialog({ ws, onClose }: { ws: Workspace; onClose: (created?: Interpreter) => void }) {
  const [kind, setKind] = useState<Exclude<InterpreterKind, 'local'>>('compose');
  const [draft, setDraft] = useState<Record<string, Interpreter>>(() => ({
    compose: newInterpreter('compose'),
    docker: newInterpreter('docker'),
    ssh: newInterpreter('ssh'),
  }));
  const value = draft[kind];
  const set = (patch: Partial<Interpreter>) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], ...patch } }));
  const valid = kind === 'compose' ? !!value.service : kind === 'docker' ? !!value.image?.trim() : !!value.host?.trim();

  const create = () => {
    if (!valid) return;
    const name = kind === 'compose' ? `${value.service}` : kind === 'docker' ? `${value.image}` : `${value.host}`;
    onClose({ ...value, name: `PHP (${name})` });
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 95 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="jb-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Configure Remote PHP Interpreter"
        style={{ width: 620 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="jb-dialog-title">Configure Remote PHP Interpreter</div>
        <div className="jb-dialog-body">
          <div className="settings-row" role="radiogroup" aria-label="Kind">
            {(
              [
                ['ssh', 'SSH'],
                ['docker', 'Docker'],
                ['compose', 'Docker Compose'],
              ] as const
            ).map(([id, label]) => (
              <label key={id} className="settings-radio">
                <input type="radio" name="remote-kind" checked={kind === id} onChange={() => setKind(id)} />
                {label}
              </label>
            ))}
          </div>
          <div className="settings-grid" style={{ marginTop: 6 }}>
            {kind === 'compose' && <ComposeFields ws={ws} value={value} onChange={set} />}
            {kind === 'docker' && (
              <>
                <label htmlFor="rm-image">Image name:</label>
                <div className="field">
                  <input id="rm-image" value={value.image ?? ''} placeholder="php:8.4-cli" spellCheck={false} onChange={(e) => set({ image: e.target.value })} />
                </div>
              </>
            )}
            {kind === 'ssh' && (
              <>
                <label htmlFor="rm-host">Host:</label>
                <div className="field">
                  <input id="rm-host" value={value.host ?? ''} placeholder="example.com" spellCheck={false} onChange={(e) => set({ host: e.target.value })} />
                </div>
                <label htmlFor="rm-user">User:</label>
                <div className="field">
                  <input id="rm-user" value={value.user ?? ''} spellCheck={false} onChange={(e) => set({ user: e.target.value })} />
                </div>
              </>
            )}
            <label htmlFor="rm-php">PHP interpreter path:</label>
            <div className="field">
              <input id="rm-php" value={value.phpPath} spellCheck={false} onChange={(e) => set({ phpPath: e.target.value })} />
            </div>
          </div>
          {!isTauri && <span className="muted">Docker and SSH need the desktop app.</span>}
        </div>
        <div className="jb-dialog-buttons">
          <button type="button" className="btn primary" disabled={!valid} onClick={create}>
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

export { projectPhp };

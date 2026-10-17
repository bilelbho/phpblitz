import type { Workspace } from '../useWorkspace';
import { relativePath } from '../backend/types';
import { db } from '../db/store';
import { useEffect, useState } from 'react';
import { debug } from '../debug/manager';
import { useSymbols } from '../symbols';
import { cachedInspect, composerPhpLevel, interpretersFor, kindLabel, projectPhp, useInterpreters } from '../interpreters';
import { Icon, Sym } from './Icon';
import { FileIcon } from './FileIcon';
import { NavBarPopup, type NavRequest } from './NavBarPopup';

const LSP_STATE: Record<string, [string, string]> = {
  starting: ['#e5a33d', 'starting…'],
  ready: ['#5fb865', 'ready'],
  stopped: ['#f75464', 'stopped. Click to restart'],
  error: ['#f75464', 'failed to start. Click to retry'],
  missing: ['#868a91', 'none (optional: navigation and usages already work from the index; install one with cargo install phpantom_lsp for rename and richer completion). Click to retry'],
};

/** The project's PHP: its language level and interpreter. Opens Settings ▸ PHP. */
function PhpLevel({ ws }: { ws: Workspace }) {
  useInterpreters();
  const root = ws.backend.root;
  const php = projectPhp(root);
  const interpreter = interpretersFor(root).find((i) => i.id === php.interpreterId);
  const [version, setVersion] = useState<string | null>(null);
  const [composer, setComposer] = useState<string | null>(null);
  useEffect(() => {
    ws.backend.readFile(`${root}/composer.json`).then(setComposer).catch(() => setComposer(null));
  }, [ws.backend, root]);
  useEffect(() => {
    setVersion(null);
    if (!interpreter) return;
    let live = true;
    cachedInspect(interpreter, root)
      .then((i) => live && setVersion(i.version))
      .catch(() => live && setVersion(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(interpreter), root]);
  const fallback = ws.phpVersion?.split(' ')[0] ?? null;
  const running = version ?? (interpreter ? null : fallback);
  const level = php.languageLevel !== 'auto' ? php.languageLevel : (composerPhpLevel(composer) ?? running?.split('.').slice(0, 2).join('.'));
  const title = [
    `PHP language level: ${level ?? 'unknown'}${php.languageLevel === 'auto' ? ' (auto)' : ''}`,
    interpreter ? `Interpreter: ${interpreter.name} (${kindLabel(interpreter)})${version ? `, PHP ${version}` : ''}` : fallback ? `PHP ${fallback} from PATH` : 'No interpreter. PHP was not found on PATH',
    'Click to open Settings ▸ PHP',
  ].join('\n');
  return (
    <button type="button" className="item" title={title} onClick={() => ws.openSettings('php')}>
      {level ? `PHP ${level}` : 'No PHP'}
    </button>
  );
}

/** Which language server is running, JetBrains-style ("PHPantom ●"). */
function LanguageServer({ ws }: { ws: Workspace }) {
  const s = ws.lspStatus;
  if (s.state === 'off') return null;
  const [color, text] = LSP_STATE[s.state];
  const clickable = s.state !== 'ready' && s.state !== 'starting';
  return (
    <button
      type="button"
      className="item"
      title={`Language server ${s.name ?? ''}: ${text}${s.message ? `\n${s.message}` : ''}`}
      onClick={() => clickable && ws.restartLanguageServer()}
    >
      <span className="dot" style={{ background: color, width: 7, height: 7 }} />
      {s.name ?? 'No language server'}
    </button>
  );
}

/** Mago's project analysis state. */
function MagoStatus({ ws }: { ws: Workspace }) {
  const s = ws.magoStatus;
  if (s.state === 'off') return null;
  const color = s.state === 'ready' ? '#5fb865' : s.state === 'analyzing' ? '#e5a33d' : '#f75464';
  const title =
    s.state === 'ready' && s.summary
      ? `Mago: ${s.summary.files} files analyzed in ${(s.summary.millis / 1000).toFixed(1)} s · PHP ${s.summary.phpVersion}` +
        (s.summary.integrations.length ? ` · ${s.summary.integrations.join(', ')} rules` : '') +
        (s.summary.needsInstall ? ' · type checking is off until you run composer install' : '')
      : s.state === 'analyzing'
        ? 'Mago is analyzing the project in the background. Open files are already checked.'
        : `Mago failed: ${s.message ?? ''}. Click to retry`;
  return (
    <button type="button" className="item" title={title} onClick={() => (s.state === 'error' ? ws.reanalyzeProject() : ws.showBottom('problems'))}>
      <span className="dot" style={{ background: color, width: 7, height: 7 }} />
      {s.state === 'analyzing' ? 'Mago analyzing…' : 'Mago'}
    </button>
  );
}

export function StatusBar({ ws }: { ws: Workspace }) {
  const idx = useSymbols();
  const tab = ws.activeTab;
  const all = Object.values(ws.problems).flat();
  const errors = all.filter((p) => p.severity === 'error').length;

  const [nav, setNav] = useState<NavRequest | null>(null);
  // Breadcrumbs: project › folders › file › class › member at the caret. Each one opens a popup:
  // folders and the file list their folder, the class and member list the class's members.
  type Crumb = { label: string; sym?: [string, string]; icon?: React.ReactNode; open?: (anchor: DOMRect) => NavRequest };
  const root = ws.backend.root;
  const crumbs: Crumb[] = [{ label: ws.backend.name, icon: <Icon name="folder" size={13} className="folder-icon" />, open: (anchor) => ({ kind: 'dir', path: root, anchor }) }];
  if (tab?.kind === 'file') {
    const parts = relativePath(ws.backend, tab.path).split('/');
    parts.forEach((part, i) => {
      const path = `${root}/${parts.slice(0, i + 1).join('/')}`;
      const isFile = i === parts.length - 1;
      const parent = i === 0 ? root : `${root}/${parts.slice(0, i).join('/')}`;
      crumbs.push({
        label: part,
        icon: isFile ? <FileIcon path={path} size={14} /> : undefined,
        // A folder lists its own contents; the file lists its folder with itself selected.
        open: (anchor) => (isFile ? { kind: 'dir', path: parent, selected: path, anchor } : { kind: 'dir', path, anchor }),
      });
    });
    const cls = ws.structure.find((s) => s.depth === 0 && s.kind !== 'function');
    const member = [...ws.structure].reverse().find((s) => s.depth > 0 && s.kind === 'method' && s.line <= ws.cursor.line);
    if (cls) crumbs.push({ label: cls.name, sym: ['c', '#548af7'], open: (anchor) => ({ kind: 'members', path: tab.path, selected: member?.line, anchor }) });
    if (member) crumbs.push({ label: `${member.name}()`, sym: ['m', '#e55765'], open: (anchor) => ({ kind: 'members', path: tab.path, selected: member.line, anchor }) });
  } else if (tab?.kind === 'table') {
    crumbs.push({ label: db.get(tab.source)?.name ?? tab.source }, { label: tab.schema }, { label: tab.table });
  } else if (tab?.kind === 'console') {
    crumbs.push({ label: db.get(tab.source)?.name ?? tab.source }, { label: tab.name ?? 'console' });
  }

  const loaded = tab?.kind === 'file' ? ws.loaded[tab.path] : undefined;
  const lineEnding = loaded?.includes('\r\n') ? 'CRLF' : 'LF';

  return (
    <footer className="statusbar">
      <nav className="crumbs" aria-label="Navigation bar">
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: 'contents' }}>
            {i > 0 && (
              <span className="sep">
                <Icon name="chevronRight" size={11} strokeWidth={2.2} />
              </span>
            )}
            <button
              type="button"
              className={'item crumb' + (nav && nav.anchor && c.open ? '' : '')}
              style={{ padding: '0 3px' }}
              disabled={!c.open}
              onClick={(e) => c.open && setNav(c.open((e.currentTarget as HTMLElement).getBoundingClientRect()))}
            >
              {c.sym && <Sym letter={c.sym[0]} color={c.sym[1]} />}
              {!c.sym && c.icon}
              {c.label}
            </button>
          </span>
        ))}
      </nav>
      {nav && <NavBarPopup ws={ws} request={nav} onClose={() => setNav(null)} />}
      <span className="grow" />
      {!ws.indexStats && (
        <span className="item muted" title="Indexing PHP files (project and vendor). Editing works meanwhile.">
          {idx.progress && idx.progress.total ? `Indexing… ${idx.progress.done.toLocaleString()} / ${idx.progress.total.toLocaleString()}` : 'Indexing…'}
        </span>
      )}
      {ws.status && <span className="item muted">{ws.status}</span>}
      {ws.listening && (
        <span className="item" style={{ color: '#5fb865' }}>
          <Icon name="listen" size={13} /> Listening on :{debug.port}
        </span>
      )}
      <button type="button" className="item" onClick={() => ws.showBottom('problems')} title="Problems" style={{ color: errors ? '#f0787f' : undefined }}>
        <Icon name={errors ? 'error' : 'check'} size={13} />
        {errors || ''}
      </button>
      {tab?.kind === 'file' && (
        <>
          <span className="item" title="Line:Column">
            {ws.cursor.line}:{ws.cursor.col}
          </span>
          <span className="item" title="Line separator">
            {lineEnding}
          </span>
          <span className="item" title="File encoding">
            UTF-8
          </span>
          <span className="item" title="Indentation">
            4 spaces
          </span>
        </>
      )}
      <MagoStatus ws={ws} />
      <LanguageServer ws={ws} />
      <PhpLevel ws={ws} />
      {tab?.kind === 'file' && (
        <span className="item" title="File is writable">
          <Icon name="lockOpen" size={13} />
        </span>
      )}
    </footer>
  );
}

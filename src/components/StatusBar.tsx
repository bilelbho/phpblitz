import type { Workspace } from '../useWorkspace';
import { relativePath } from '../backend/types';
import { db } from '../db/store';
import { Icon, Sym } from './Icon';

const LSP_STATE: Record<string, [string, string]> = {
  starting: ['#e5a33d', 'starting…'],
  ready: ['#5fb865', 'ready'],
  stopped: ['#f75464', 'stopped. Click to restart'],
  error: ['#f75464', 'failed to start. Click to retry'],
  missing: ['#868a91', 'not installed (cargo install phpantom_lsp). Click to retry'],
};

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
        (s.summary.integrations.length ? ` · ${s.summary.integrations.join(', ')} rules` : '')
      : s.state === 'analyzing'
        ? 'Mago is analyzing the project…'
        : `Mago failed: ${s.message ?? ''}. Click to retry`;
  return (
    <button type="button" className="item" title={title} onClick={() => (s.state === 'error' ? ws.reanalyzeProject() : ws.showBottom('problems'))}>
      <span className="dot" style={{ background: color, width: 7, height: 7 }} />
      {s.state === 'analyzing' ? 'Mago analyzing…' : 'Mago'}
    </button>
  );
}

export function StatusBar({ ws }: { ws: Workspace }) {
  const tab = ws.activeTab;
  const all = Object.values(ws.problems).flat();
  const errors = all.filter((p) => p.severity === 'error').length;

  // Breadcrumbs: project › folders › file › class › member at the caret.
  const crumbs: { label: string; sym?: [string, string] }[] = [{ label: ws.backend.name }];
  if (tab?.kind === 'file') {
    for (const part of relativePath(ws.backend, tab.path).split('/')) crumbs.push({ label: part });
    const cls = ws.structure.find((s) => s.depth === 0 && s.kind !== 'function');
    if (cls) crumbs.push({ label: cls.name, sym: ['c', '#548af7'] });
    const member = [...ws.structure].reverse().find((s) => s.depth > 0 && s.kind === 'method' && s.line <= ws.cursor.line);
    if (member) crumbs.push({ label: `${member.name}()`, sym: ['m', '#e55765'] });
  } else if (tab?.kind === 'table') {
    crumbs.push({ label: db.get(tab.source)?.name ?? tab.source }, { label: tab.schema }, { label: tab.table });
  } else if (tab?.kind === 'console') {
    crumbs.push({ label: db.get(tab.source)?.name ?? tab.source }, { label: 'console' });
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
            <span className="item" style={{ padding: '0 3px' }}>
              {c.sym && <Sym letter={c.sym[0]} color={c.sym[1]} />}
              {c.label}
            </span>
          </span>
        ))}
      </nav>
      <span className="grow" />
      {!ws.indexStats && <span className="item muted">Indexing…</span>}
      {ws.status && <span className="item muted">{ws.status}</span>}
      {ws.listening && (
        <span className="item" style={{ color: '#5fb865' }}>
          <Icon name="bug" size={13} /> Listening on :9003
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
      <span className="item" title={ws.phpVersion ? 'PHP language level' : 'PHP was not found on PATH'}>
        {ws.phpVersion ? `PHP ${ws.phpVersion.split(' ')[0]}` : 'No PHP'}
      </span>
      {tab?.kind === 'file' && (
        <span className="item" title="File is writable">
          <Icon name="lockOpen" size={13} />
        </span>
      )}
    </footer>
  );
}

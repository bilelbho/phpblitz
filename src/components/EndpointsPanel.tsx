import { useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { phpIndex, type Route } from '../php';
import { baseName } from '../backend/types';
import { Icon } from './Icon';

export function EndpointsPanel({ ws }: { ws: Workspace }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const routes = ws.routes.filter((r) => !q || `${r.method} ${r.uri} ${r.handler}`.toLowerCase().includes(q));

  const open = (r: Route) => {
    const cls = r.controller ? phpIndex.find(r.controller) : undefined;
    if (cls && r.action) ws.openFile(cls.path, { find: String.raw`function\s+${r.action}\s*\(` });
    else ws.openFile(r.path, { line: r.line });
  };

  return (
    <>
      <div style={{ padding: '0 10px 6px' }}>
        <div className="field">
          <Icon name="search" size={13} />
          <label htmlFor="endpoint-filter" className="sr-only">
            Filter routes
          </label>
          <input id="endpoint-filter" placeholder="Filter routes" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <div className="panel-body list">
        {routes.map((r) => (
          <button key={`${r.path}:${r.line}`} type="button" className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }} onClick={() => open(r)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
              <span className={`method ${r.method}`}>{r.method}</span>
              <span className="mono" style={{ color: 'var(--text-strong)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.uri}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8, paddingLeft: 54, fontSize: 12, whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--muted-2)' }}>{r.handler}</span>
              <span className="muted">
                {baseName(r.path)}:{r.line}
              </span>
            </span>
          </button>
        ))}
        {!ws.routes.length && <div className="empty">{ws.indexStats ? 'No Laravel routes found in routes/*.php.' : 'Indexing…'}</div>}
        {!!ws.routes.length && !routes.length && <div className="empty">No routes match “{filter}”.</div>}
      </div>
    </>
  );
}

import type { Workspace } from '../useWorkspace';

export function ComposerPanel({ ws }: { ws: Workspace }) {
  const outdated = ws.outdated ?? {};
  const updates = Object.keys(outdated).length;
  const busy = !!ws.composerBusy;

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '0 10px 8px' }}>
        <button type="button" className="btn small" onClick={() => ws.openFile(`${ws.backend.root}/composer.json`)}>
          Open composer.json
        </button>
        <button type="button" className="btn small" onClick={ws.checkOutdated} disabled={busy}>
          Check for updates
        </button>
        {updates > 0 && (
          <button type="button" className="btn small primary" onClick={() => ws.updatePackage(null)} disabled={busy}>
            Update all ({updates})
          </button>
        )}
      </div>
      {ws.composerBusy && <div className="empty" style={{ paddingBottom: 0 }}>{ws.composerBusy}</div>}
      <div className="panel-body list">
        {ws.packages.map((p) => {
          const latest = outdated[p.name];
          return (
            <div key={p.name} className="list-item">
              <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {p.version} · {p.kind}
                </span>
              </div>
              {latest ? (
                <button
                  type="button"
                  className="btn small"
                  style={{ borderColor: 'rgba(242,169,59,0.5)', color: '#f2b65a' }}
                  onClick={() => ws.updatePackage(p.name)}
                  disabled={busy}
                >
                  Update to {latest}
                </button>
              ) : (
                ws.outdated && <span className="chip ok">up to date</span>
              )}
            </div>
          );
        })}
        {!ws.packages.length && <div className="empty">No composer.json found in this project.</div>}
        {!!ws.packages.length && !ws.outdated && !busy && (
          <div className="empty" style={{ fontSize: 12 }}>
            Versions come from composer.lock. Use “Check for updates” to run composer outdated.
          </div>
        )}
      </div>
    </>
  );
}

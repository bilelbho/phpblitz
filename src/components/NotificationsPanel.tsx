import type { Workspace } from '../useWorkspace';
import { Icon } from './Icon';

const TONE = { info: 'var(--blue-text)', success: 'var(--green)', warning: 'var(--orange)', error: 'var(--red)' } as const;

export function NotificationsPanel({ ws }: { ws: Workspace }) {
  if (!ws.notices.length) return <div className="empty">No new notifications.</div>;
  return (
    <div className="panel-body" style={{ padding: '4px 0' }}>
      {ws.notices.map((n) => (
        <div key={n.id} className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
            <span className="dot" style={{ background: TONE[n.tone], marginTop: 6 }} />
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div className="card-title">{n.title}</div>
              <div className="card-body">{n.body}</div>
            </div>
            <button type="button" className="icon-btn small" aria-label={`Dismiss: ${n.title}`} onClick={() => ws.dismissNotice(n.id)}>
              <Icon name="close" size={10} />
            </button>
          </div>
          {(n.action || n.secondary) && (
            <div className="card-actions">
              {[n.action, n.secondary].map(
                (a) =>
                  a && (
                    <button
                      key={a.label}
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        a.run();
                        ws.dismissNotice(n.id);
                      }}
                    >
                      {a.label}
                    </button>
                  ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

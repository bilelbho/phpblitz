// New notifications pop up as balloons above the status bar, bottom right: the tone's icon, the
// title, the text and the actions side by side. Errors and warnings stay until closed (or acted
// on); the others go after a few seconds, unless the mouse is on them. Closing a balloon keeps the
// notification in the Notifications tool window; an action, as there, dismisses it.

import { useEffect, useRef, useState } from 'react';
import type { Notice, Workspace } from '../useWorkspace';
import { Icon } from './Icon';

const HIDE_AFTER_MS = 8000;
const MAX_SHOWN = 3;

const ICON = { info: 'info', success: 'circleCheck', warning: 'warning', error: 'error' } as const;

export function NotificationBalloons({ ws }: { ws: Workspace }) {
  const [shown, setShown] = useState<number[]>([]);
  const seen = useRef(new Set<number>());
  const timers = useRef(new Map<number, number>());
  const panelOpen = ws.isToolOpen('notifications');

  const hide = (id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setShown((list) => list.filter((x) => x !== id));
  };
  const schedule = (n: Notice) => {
    if (n.tone === 'error' || n.tone === 'warning') return;
    window.clearTimeout(timers.current.get(n.id));
    timers.current.set(n.id, window.setTimeout(() => hide(n.id), HIDE_AFTER_MS));
  };

  // New notices pop up (not while the Notifications window shows them anyway).
  useEffect(() => {
    const fresh = ws.notices.filter((n) => !seen.current.has(n.id));
    fresh.forEach((n) => seen.current.add(n.id));
    const live = new Set(ws.notices.map((n) => n.id));
    setShown((list) => {
      const kept = list.filter((id) => live.has(id));
      if (panelOpen) return kept;
      fresh.forEach(schedule);
      return [...fresh.map((n) => n.id), ...kept].slice(0, MAX_SHOWN);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.notices]);

  useEffect(() => {
    if (panelOpen) setShown([]);
  }, [panelOpen]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const balloons = shown.map((id) => ws.notices.find((n) => n.id === id)).filter((n): n is Notice => !!n);
  if (!balloons.length) return null;
  return (
    <div className="balloons" aria-live="polite">
      {/* The newest at the bottom, nearest the status bar. */}
      {[...balloons].reverse().map((n) => (
        <div
          key={n.id}
          className={`balloon tone-${n.tone}`}
          role={n.tone === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => window.clearTimeout(timers.current.get(n.id))}
          onMouseLeave={() => schedule(n)}
        >
          <Icon name={ICON[n.tone]} size={16} />
          <div className="balloon-main">
            <div className="balloon-title">{n.title}</div>
            {n.body && <div className="balloon-body">{n.body}</div>}
            {(n.action || n.secondary) && (
              <div className="balloon-actions">
                {[n.action, n.secondary].map(
                  (a) =>
                    a && (
                      <button
                        key={a.label}
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          a.run();
                          hide(n.id);
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
          <button type="button" className="icon-btn small balloon-close" aria-label={`Close: ${n.title}`} title="Close (stays in Notifications)" onClick={() => hide(n.id)}>
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

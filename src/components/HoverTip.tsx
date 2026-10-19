// A tooltip in the IDE's style (instead of the system's plain title box): shown above the element
// after a short pause, kept inside the window, gone on leave or click.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const DELAY_MS = 400;

export function HoverTip({ text, children }: { text: string; children: ReactNode }) {
  const host = useRef<HTMLSpanElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const [shown, setShown] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const hide = () => {
    window.clearTimeout(timer.current);
    setShown(false);
    setPos(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Centered above the element once its size is known, never past the window's edges.
  useLayoutEffect(() => {
    if (!shown || !host.current || !tipEl.current) return;
    const r = host.current.getBoundingClientRect();
    const t = tipEl.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const top = r.top - t.height - 8 >= 8 ? r.top - t.height - 8 : r.bottom + 8;
    setPos({ left, top });
  }, [shown, text]);

  return (
    <span
      ref={host}
      className="hover-tip-host"
      onMouseEnter={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setShown(true), DELAY_MS);
      }}
      onMouseLeave={hide}
      onMouseDown={hide}
    >
      {children}
      {shown && (
        <div ref={tipEl} className="tab-tooltip hover-tip" role="tooltip" style={pos ?? { left: -9999, top: -9999 }}>
          {text}
        </div>
      )}
    </span>
  );
}

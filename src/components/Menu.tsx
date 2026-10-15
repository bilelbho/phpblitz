import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuEntry =
  | { kind?: 'item'; label: string; shortcut?: string; disabled?: boolean; run: () => void }
  | { kind: 'sep' }
  | { kind: 'head'; label: string };

/** A popup menu anchored below a toolbar button. Closes on outside click, Escape or choice. */
export function MenuButton({
  className,
  label,
  title,
  entries,
  children,
}: {
  className: string;
  label: string;
  title?: string;
  entries: MenuEntry[] | (() => MenuEntry[]);
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const width = menu.current?.offsetWidth ?? 240;
    setPos({ left: Math.min(r.left, window.innerWidth - width - 8), top: r.bottom + 4 });
    menu.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const list = open ? (typeof entries === 'function' ? entries() : entries) : [];

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={className + (open ? ' open' : '')}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <div ref={menu} className="menu" role="menu" style={{ position: 'fixed', left: pos.left, top: pos.top }}>
          {list.map((e, i) => {
            if (e.kind === 'sep') return <div key={i} className="menu-sep" role="separator" />;
            if (e.kind === 'head') return <div key={i} className="menu-head">{e.label}</div>;
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={e.disabled}
                onClick={() => {
                  setOpen(false);
                  e.run();
                }}
              >
                {e.label}
                {e.shortcut && <span className="shortcut">{e.shortcut}</span>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

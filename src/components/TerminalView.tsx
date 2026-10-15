// The Terminal tool window: its own header with session tabs (drag to reorder, double-click to
// rename), + and ▾, and the active xterm below.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { getSettings, useSettings } from '../settings';
import { tabLabel, terminals, useTerminals, type ShellSpec } from '../terminal/manager';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon } from './Icon';

/** Folder new tabs start in: Settings ▸ Start directory, else the project root. */
export function terminalStartDir(ws: Workspace): string {
  const configured = getSettings().terminal.startDir.trim();
  if (configured) return configured;
  return ws.backend.kind === 'disk' ? ws.backend.root : '';
}

/** A tab being dragged: pointer-based, since the desktop web view keeps HTML5 drag and drop for files. */
interface Drag {
  id: number;
  startX: number;
  /** Pointer offset from the tab's place in the strip, for drawing it under the cursor. */
  dx: number;
  moved: boolean;
}

export function TerminalView({ ws }: { ws: Workspace }) {
  const { sessions, activeId } = useTerminals();
  useSettings(); // re-render tab labels when "use application title" changes
  const host = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [shells, setShells] = useState<ShellSpec[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const active = sessions.find((s) => s.id === activeId) ?? null;

  useEffect(() => {
    terminals.shells().then(setShells);
    // Opening the Terminal tool window with no tabs starts one, like PhpStorm.
    if (!terminals.sessions.length && !terminals.creating) terminals.create({ cwd: terminalStartDir(ws) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the active session; keep it sized to the panel.
  useLayoutEffect(() => {
    if (!active || !host.current) return;
    terminals.attach(active, host.current);
    const observer = new ResizeObserver(() => terminals.fit(active));
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      terminals.detach(active);
    };
  }, [active]);

  const newTab = (shell?: ShellSpec) => terminals.create({ cwd: terminalStartDir(ws), shell });

  const shellMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        ...shells.map((s) => ({ label: s.name, run: () => newTab(s) })),
        ...(shells.length ? [{ kind: 'sep' as const }] : [{ label: 'No shells found', disabled: true }]),
        { label: 'Settings', icon: 'gear' as const, run: () => ws.openSettings('terminal') },
      ],
    });
  };

  const optionsMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right - 220,
      y: r.bottom + 4,
      items: [
        { label: 'New Tab', icon: 'plus', run: () => newTab() },
        { label: 'Rename Session…', icon: 'pencil', disabled: !active, run: () => active && setRenaming(active.id) },
        { label: 'Close Session', disabled: !active, run: () => active && terminals.close(active.id) },
        { label: 'Close All Sessions', disabled: !sessions.length, run: () => terminals.closeAll() },
        { kind: 'sep' },
        { label: 'Settings…', icon: 'gear', shortcut: 'Ctrl+Alt+S', run: () => ws.openSettings('terminal') },
      ],
    });
  };

  const tabMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'New Tab', icon: 'plus', run: () => newTab() },
        { label: 'Rename Session…', icon: 'pencil', run: () => setRenaming(id) },
        { kind: 'sep' },
        { label: 'Close Tab', run: () => terminals.close(id) },
        { label: 'Close Other Tabs', disabled: sessions.length < 2, run: () => terminals.closeOthers(id) },
      ],
    });
  };

  // ── Dragging tabs ──
  // The tab follows the pointer and swaps places as soon as it passes a neighbour's middle.
  const dragRef = useRef<Drag | null>(null);
  const tabElements = () => [...(strip.current?.querySelectorAll<HTMLElement>('.term-tab') ?? [])];
  const startDrag = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0 || renaming === id || (e.target as HTMLElement).closest('.term-tab-close')) return;
    dragRef.current = { id, startX: e.clientX, dx: 0, moved: false };
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      if (!cur.moved && Math.abs(ev.clientX - cur.startX) < 4) return;
      const from = terminals.sessions.findIndex((s) => s.id === cur.id);
      const tabs = tabElements();
      if (from < 0 || !tabs[from]) return;
      // Its new index: how many other tabs have their middle left of the pointer.
      const to = tabs.filter((t, i) => {
        if (i === from) return false;
        const r = t.getBoundingClientRect();
        return r.left + r.width / 2 < ev.clientX;
      }).length;
      let startX = cur.startX;
      if (to !== from) {
        // The tab's place in the strip changes; move the reference point with it so it stays under the cursor.
        const before = tabs[from].offsetLeft;
        terminals.move(from, to);
        const after = tabElements()[to]?.offsetLeft ?? before;
        startX += after - before;
      }
      const next = { ...cur, moved: true, startX, dx: ev.clientX - startX };
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (cur && !cur.moved) terminals.setActive(cur.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <>
      <div className="tw-head term-head">
        <span className="tw-title">Terminal</span>
        <div ref={strip} className="term-tabs" role="tablist" aria-label="Terminal sessions">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            const dragging = !!drag?.moved && drag.id === s.id;
            return (
              <div
                key={s.id}
                className={'term-tab' + (isActive ? ' active' : '') + (dragging ? ' dragging' : '')}
                style={dragging ? { transform: `translateX(${drag!.dx}px)` } : undefined}
                onPointerDown={(e) => startDrag(e, s.id)}
                onContextMenu={(e) => tabMenu(e, s.id)}
              >
                {renaming === s.id ? (
                  <RenameInput
                    initial={s.name}
                    onDone={(name) => {
                      if (name !== null) terminals.rename(s.id, name);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="term-tab-main"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') terminals.setActive(s.id);
                    }}
                    onDoubleClick={() => setRenaming(s.id)}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        terminals.close(s.id);
                      }
                    }}
                    title={`${s.shell.name} · ${s.cwd || 'home'}${s.exited ? ' · ended' : ''}\nDrag to reorder, double-click to rename`}
                  >
                    <span className={s.exited ? 'muted' : undefined}>{tabLabel(s)}</span>
                  </button>
                )}
                <button type="button" className="icon-btn small term-tab-close" aria-label={`Close ${tabLabel(s)}`} onClick={() => terminals.close(s.id)}>
                  <Icon name="close" size={9} strokeWidth={2.6} />
                </button>
              </div>
            );
          })}
          <button type="button" className="icon-btn small" aria-label="New tab" title="New Tab" onClick={() => newTab()}>
            <Icon name="plus" size={14} />
          </button>
          <button type="button" className="icon-btn small" aria-label="Choose shell" title="New tab with…" aria-haspopup="menu" onClick={shellMenu}>
            <Icon name="chevronDown" size={12} strokeWidth={2.2} />
          </button>
        </div>
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Options" title="Options" aria-haspopup="menu" onClick={optionsMenu}>
          <Icon name="more" size={14} strokeWidth={3} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={() => ws.setBottomOpen(false)}>
          <Icon name="minus" size={14} />
        </button>
      </div>
      <div className="terminal-view">
        <div ref={host} className="term-host" onMouseDown={() => active?.term.focus()} />
        {!sessions.length && (
          <div className="empty" style={{ position: 'absolute', top: 12 }}>
            No terminal sessions.{' '}
            <button type="button" className="link-btn" onClick={() => newTab()}>
              Open a new tab
            </button>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="term-rename"
      aria-label="Session name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(value);
        if (e.key === 'Escape') onDone(null);
        e.stopPropagation();
      }}
    />
  );
}

// The Terminal tool window: its own header with session tabs (drag to reorder, double-click to
// rename), + and ▾, and the terminal below. Dragging a tab onto the terminal splits it: the
// highlighted half is where that session goes.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { useSettings } from '../settings';
import { tabLabel, terminals, useTerminals, type Session, type ShellSpec } from '../terminal/manager';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon } from './Icon';
import { useTabDrag } from './useTabDrag';
import { terminalStartDir } from '../terminal/startDir';
import { useHideTool } from './toolHide';


type Zone = 'left' | 'right' | 'top' | 'bottom';

/** A split terminal: a second session beside (or below / above) the main one. */
interface Split {
  second: number;
  zone: Zone;
}

export function TerminalView({ ws }: { ws: Workspace }) {
  const hide = useHideTool(() => ws.setBottomOpen(false));
  const { sessions, activeId } = useTerminals();
  useSettings(); // re-render tab labels when "use application title" changes
  const strip = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [shells, setShells] = useState<ShellSpec[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [split, setSplit] = useState<Split | null>(null);
  /** Which pane tab clicks go to. */
  const [focus, setFocus] = useState<'main' | 'second'>('main');
  const [zone, setZone] = useState<Zone | null>(null);
  const active = sessions.find((s) => s.id === activeId) ?? null;
  const second = split ? sessions.find((s) => s.id === split.second) ?? null : null;

  useEffect(() => {
    terminals.shells().then(setShells);
    // Opening the Terminal tool window with no tabs starts one.
    if (!terminals.sessions.length && !terminals.creating) terminals.create({ cwd: terminalStartDir(ws) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A split ends when its session closes, or when both panes would show the same one.
  useEffect(() => {
    if (split && (!second || second.id === activeId)) {
      setSplit(null);
      setFocus('main');
    }
  }, [split, second, activeId]);

  const newTab = (shell?: ShellSpec) => terminals.create({ cwd: terminalStartDir(ws), shell });

  /** Clicking a tab shows it in the focused pane. */
  const show = (id: number) => {
    if (split && focus === 'second') {
      if (id === activeId) setFocus('main');
      else setSplit({ ...split, second: id });
    } else if (split && id === split.second) {
      setFocus('second');
    } else {
      terminals.setActive(id);
    }
  };

  // ── Split by dropping a tab on the terminal ──
  const zoneAt = (x: number, y: number): Zone | null => {
    const r = body.current?.getBoundingClientRect();
    if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const rx = (x - r.left) / r.width;
    const ry = (y - r.top) / r.height;
    const edges: [Zone, number][] = [
      ['left', rx],
      ['right', 1 - rx],
      ['top', ry],
      ['bottom', 1 - ry],
    ];
    return edges.sort((a, b) => a[1] - b[1])[0][0];
  };

  const splitWith = async (id: number, where: Zone) => {
    let main = activeId;
    // The dropped session goes to that side; the other side keeps (or gets) another session.
    if (main === id || main === null) {
      main = sessions.find((s) => s.id !== id)?.id ?? null;
      if (main === null) {
        const created = await terminals.create({ cwd: terminalStartDir(ws) });
        main = created?.id ?? null;
      }
      if (main !== null) terminals.setActive(main);
    }
    if (main === null || main === id) return;
    setSplit({ second: id, zone: where });
    setFocus('second');
  };

  const { drag, start: startDrag, shiftOf } = useTabDrag({
    ids: sessions.map((s) => String(s.id)),
    strip,
    onMove: (from, to) => terminals.move(from, to),
    outside: {
      over: (x, y) => setZone(zoneAt(x, y)),
      leave: () => setZone(null),
      drop: (id, x, y) => {
        const where = zoneAt(x, y);
        if (!where) return false;
        splitWith(Number(id), where);
        return true;
      },
    },
  });

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

  const splitItems = (id: number | null): ContextItem[] => [
    { label: 'Split Right', disabled: id === null || sessions.length < 1, run: () => id !== null && splitInto(id, 'right') },
    { label: 'Split Down', disabled: id === null || sessions.length < 1, run: () => id !== null && splitInto(id, 'bottom') },
    ...(split ? [{ label: 'Unsplit', run: () => (setSplit(null), setFocus('main')) }] : []),
  ];

  /** Split Right / Down from a menu: that session beside a new one (or the other session). */
  const splitInto = async (id: number, where: Zone) => {
    if (id !== activeId) return splitWith(id, where);
    const created = await terminals.create({ cwd: terminalStartDir(ws) });
    if (!created) return;
    terminals.setActive(id);
    setSplit({ second: created.id, zone: where });
    setFocus('second');
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
        ...splitItems(activeId),
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
        ...splitItems(id),
        { kind: 'sep' },
        { label: 'Close Tab', run: () => terminals.close(id) },
        { label: 'Close Other Tabs', disabled: sessions.length < 2, run: () => terminals.closeOthers(id) },
      ],
    });
  };

  const ghost = drag ? sessions.find((s) => String(s.id) === drag.id) : undefined;
  const horizontal = !split || split.zone === 'left' || split.zone === 'right';
  const secondFirst = split?.zone === 'left' || split?.zone === 'top';

  return (
    <>
      <div className="tw-head term-head">
        <span className="tw-title">Terminal</span>
        <div ref={strip} className="term-tabs" role="tablist" aria-label="Terminal sessions">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            const isSecond = s.id === split?.second;
            const shift = shiftOf(String(s.id));
            return (
              <div
                key={s.id}
                data-drag-id={String(s.id)}
                className={'term-tab' + (isActive ? ' active' : '') + (isSecond ? ' active-second' : '') + ((isActive && focus === 'main' && split) || (isSecond && focus === 'second') ? ' focused' : '')}
                style={drag ? { transform: `translateX(${shift.x}px)`, opacity: shift.dragged ? 0 : undefined, transition: shift.dragged ? 'none' : 'transform 120ms ease' } : undefined}
                onPointerDown={(e) => renaming !== s.id && startDrag(e, String(s.id))}
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
                    aria-selected={isActive || isSecond}
                    className="term-tab-main"
                    onClick={() => show(s.id)}
                    onDoubleClick={() => setRenaming(s.id)}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        terminals.close(s.id);
                      }
                    }}
                    title={`${s.shell.name} · ${s.cwd || 'home'}${s.exited ? ' · ended' : ''}\nDrag to reorder, or onto the terminal to split`}
                  >
                    <span className={s.exited ? 'muted' : undefined}>{tabLabel(s)}</span>
                  </button>
                )}
                <button type="button" className="icon-btn small term-tab-close" aria-label={`Close ${tabLabel(s)}`} onClick={() => terminals.close(s.id)}>
                  <Icon name="close" size={9} />
                </button>
              </div>
            );
          })}
          <button type="button" className="icon-btn small" aria-label="New tab" title="New Tab" onClick={() => newTab()}>
            <Icon name="plus" size={14} />
          </button>
          <button type="button" className="icon-btn small" aria-label="Choose shell" title="New tab with…" aria-haspopup="menu" onClick={shellMenu}>
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Options" title="Options" aria-haspopup="menu" onClick={optionsMenu}>
          <Icon name="more" size={14} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={hide}>
          <Icon name="minus" size={14} />
        </button>
      </div>
      <div ref={body} className={'terminal-view' + (split ? (horizontal ? ' split-h' : ' split-v') : '')}>
        {split && second && secondFirst && <Pane session={second} focused={focus === 'second'} onFocus={() => setFocus('second')} />}
        {active && <Pane session={active} focused={!split || focus === 'main'} onFocus={() => setFocus('main')} />}
        {split && second && !secondFirst && <Pane session={second} focused={focus === 'second'} onFocus={() => setFocus('second')} />}
        {!sessions.length && (
          <div className="empty" style={{ position: 'absolute', top: 12 }}>
            No terminal sessions.{' '}
            <button type="button" className="link-btn" onClick={() => newTab()}>
              Open a new tab
            </button>
          </div>
        )}
        {zone && <div className={`term-drop-zone ${zone}`} />}
      </div>
      {drag && ghost && (
        <div className="term-tab term-tab-ghost" style={{ left: drag.x - drag.grabX, top: drag.y - drag.grabY, width: drag.width, height: drag.height }}>
          <span className="term-tab-main">{tabLabel(ghost)}</span>
          <Icon name="close" size={9} />
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

/** One terminal on screen, kept sized to its pane. */
function Pane({ session, focused, onFocus }: { session: Session; focused: boolean; onFocus: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    terminals.attach(session, host.current);
    const observer = new ResizeObserver(() => terminals.fit(session));
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      terminals.detach(session);
    };
  }, [session]);
  return (
    <div
      ref={host}
      className={'term-host' + (focused ? ' focused' : '')}
      onMouseDown={() => {
        onFocus();
        session.term.focus();
      }}
    />
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

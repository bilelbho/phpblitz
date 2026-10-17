// Editor tabs, like PhpStorm's new UI: one row of rounded tabs with file-type icons and file
// colors; tabs that don't fit go to the ▾ list (the active one always stays visible); ⋮ and
// right-click for Close Others / All / Unmodified…; the full path in a tooltip.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Tab, Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { db } from '../db/store';
import { useDirMarks } from '../dirMarks';
import { Badge, Icon } from './Icon';
import { FileIcon } from './FileIcon';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { copyText } from '../editorMenu';
import { useSettings } from '../settings';
import { useTabDrag } from './useTabDrag';

/** Native path for tooltips: backslashes on Windows. */
const nativePath = (p: string) => (/^[A-Za-z]:\//.test(p) ? p.replace(/\//g, '\\') : p);

function tabInfo(ws: Workspace, t: Tab): { name: string; icon: ReactNode; title: string } {
  switch (t.kind) {
    case 'file':
      return { name: baseName(t.path), icon: <FileIcon path={t.path} />, title: ws.backend.kind === 'disk' ? nativePath(t.path) : relativePath(ws.backend, t.path) };
    case 'table':
      return { name: t.table, icon: <Badge text="T" color="#5fc9be" />, title: `${db.get(t.source)?.name ?? ''} · ${t.schema}.${t.table}` };
    case 'console':
      return { name: `${t.name ?? 'console'} [${db.get(t.source)?.name ?? t.source}]`, icon: <Badge text="Q" color="#e3a869" />, title: `Query console ${t.name ?? 'console'}: ${db.get(t.source)?.name ?? ''}` };
    case 'diff':
      return {
        name: t.commit ? `${baseName(t.path)} (${t.commit.slice(0, 7)})` : `Diff: ${baseName(t.path)}`,
        icon: <FileIcon path={t.path} />,
        title: `${relativePath(ws.backend, t.path)}: ${t.commit ? `changes in ${t.commit.slice(0, 8)}` : 'HEAD vs your version'}`,
      };
  }
}

export function TabBar({ ws }: { ws: Workspace }) {
  const marks = useDirMarks();
  const opts = useSettings().tabs;
  const bar = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  /** Tabs out of view (scroll mode), listed by ▾. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [list, setList] = useState<DOMRect | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tipTimer = useRef(0);

  const color = (t: Tab) => (t.kind === 'file' || t.kind === 'diff' ? marks.colorOf(t.path) : null);
  const isDirty = (t: Tab) => t.kind === 'file' && ws.dirty.has(t.path);
  // Drag to reorder (not while tabs are kept sorted alphabetically).
  const { drag, start: startDrag, shiftOf } = useTabDrag({ ids: ws.tabs.map((t) => t.id), strip: row, onMove: ws.moveTab, disabled: opts.sortAlphabetically });

  /** Names shared by several open files: those tabs also show their folder. */
  const dupes = useMemo(() => {
    const count = new Map<string, number>();
    for (const t of ws.tabs) if (t.kind === 'file') count.set(baseName(t.path), (count.get(baseName(t.path)) ?? 0) + 1);
    return count;
  }, [ws.tabs]);
  const label = (t: Tab) => {
    const info = tabInfo(ws, t);
    let name = info.name;
    if (t.kind === 'file' && !opts.showExtension && name.lastIndexOf('.') > 0) name = name.slice(0, name.lastIndexOf('.'));
    const dir = t.kind === 'file' && opts.showDirForDuplicates && (dupes.get(baseName(t.path)) ?? 0) > 1 ? relativePath(ws.backend, t.path).split('/').slice(-2, -1)[0] : null;
    return { ...info, name, dir };
  };

  // Which tabs are out of view (scroll mode only; squeeze and multiple rows show them all).
  const measure = () => {
    const el = row.current;
    if (!el || opts.mode !== 'scroll') {
      setHidden((h) => (h.size ? new Set() : h));
      return;
    }
    const box = el.getBoundingClientRect();
    const next = new Set<string>();
    el.querySelectorAll<HTMLElement>('[data-tab]').forEach((t) => {
      const r = t.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) next.add(t.dataset.tab!);
    });
    setHidden((h) => (h.size === next.size && [...next].every((id) => h.has(id)) ? h : next));
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  // Keep the active tab in view.
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(ws.activeId ?? '')}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [ws.activeId, opts.mode]);

  const closeMenuItems = (t: Tab | null): ContextItem[] => {
    const ids = ws.tabs.map((x) => x.id);
    const at = t ? ids.indexOf(t.id) : -1;
    return [
      ...(t ? [{ label: 'Close', shortcut: 'Ctrl+F4', run: () => ws.closeTab(t.id) }] : []),
      { label: 'Close Other Tabs', disabled: ws.tabs.length < 2, run: () => ws.closeTabs(ids.filter((id) => id !== (t?.id ?? ws.activeId))) },
      { label: 'Close All Tabs', run: () => ws.closeTabs(ids) },
      { label: 'Close Unmodified Tabs', run: () => ws.closeTabs(ws.tabs.filter((x) => !isDirty(x)).map((x) => x.id)) },
      ...(t
        ? [
            { label: 'Close Tabs to the Left', disabled: at <= 0, run: () => ws.closeTabs(ids.slice(0, at)) },
            { label: 'Close Tabs to the Right', disabled: at >= ids.length - 1, run: () => ws.closeTabs(ids.slice(at + 1)) },
          ]
        : []),
    ];
  };

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    e.preventDefault();
    const path = t.kind === 'file' || t.kind === 'diff' ? t.path : null;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...closeMenuItems(t),
        ...(path
          ? [
              { kind: 'sep' as const },
              ...(t.kind === 'file' && t.preview ? [{ label: 'Keep Tab Open', run: () => ws.pinTab(t.id) }] : []),
              { label: 'Copy Path', icon: 'copy' as const, run: () => copyText(ws, ws.backend.kind === 'disk' ? nativePath(path) : relativePath(ws.backend, path), 'path') },
              { label: 'Select in Project View', icon: 'target' as const, run: () => ws.revealInTree(path) },
            ]
          : []),
      ],
    });
  };

  const showTip = (e: React.MouseEvent, text: string) => {
    if (!opts.pathOnHover) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip({ text, x: r.left + 12, y: r.bottom + 6 }), 600);
  };
  const hideTip = () => {
    window.clearTimeout(tipTimer.current);
    setTip(null);
  };

  // A tab can close or move under the pointer (no mouseleave then): the tooltip goes with any change or click.
  const tabIds = ws.tabs.map((t) => t.id).join('|');
  useLayoutEffect(() => {
    window.clearTimeout(tipTimer.current);
    setTip(null);
  }, [tabIds, ws.activeId]);
  useLayoutEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('mousedown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('mousedown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [tip]);

  const listed = hidden.size ? ws.tabs.filter((t) => hidden.has(t.id)) : ws.tabs;

  return (
    <div className={`tabs tabs-${opts.mode} tabs-${opts.placement}`} role="tablist" aria-label="Open files" ref={bar}>
      <div
        className="tabs-row"
        ref={row}
        onScroll={measure}
        onWheel={(e) => {
          // A vertical wheel scrolls the tabs sideways.
          if (opts.mode === 'scroll' && row.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) row.current.scrollLeft += e.deltaY;
        }}
      >
        {ws.tabs.map((t) => {
            const { name, icon, title, dir } = label(t);
            const active = t.id === ws.activeId;
            const dirty = isDirty(t);
            const preview = t.kind === 'file' && !!t.preview;
            const c = color(t);
            const shift = shiftOf(t.id);
            return (
              <div
                key={t.id}
                data-tab={t.id}
                data-drag-id={t.id}
                onPointerDown={(e) => {
                  hideTip();
                  startDrag(e, t.id);
                }}
                style={drag ? { transform: `translateX(${shift.x}px)`, opacity: shift.dragged ? 0 : undefined, transition: shift.dragged ? 'none' : 'transform 120ms ease' } : undefined}
                className={'tab' + (active ? ' active' : '') + (dirty ? ' dirty' : '') + (preview ? ' preview' : '') + (c ? ` file-color-${c}` : '') + (opts.closeButton === 'left' ? ' close-left' : '')}
                onContextMenu={(e) => tabMenu(e, t)}
                onMouseEnter={(e) => showTip(e, title + (preview ? '\nPreview tab: double-click to keep it open' : ''))}
                onMouseLeave={hideTip}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="tab-main"
                  onClick={() => ws.setActiveId(t.id)}
                  onDoubleClick={() => ws.pinTab(t.id)}
                  onMouseDown={(e) => {
                    hideTip();
                    if (e.button === 1) {
                      e.preventDefault();
                      ws.closeTab(t.id);
                    }
                  }}
                >
                    {opts.showIcon && icon}
                  <span className="tab-name">{name}</span>
                  {dir && <span className="tab-dir">{dir}</span>}
                  {dirty && opts.markModified && <span className="dirty-mark" aria-label="unsaved changes">*</span>}
                </button>
                {opts.closeButton !== 'none' && (
                  <button type="button" className="icon-btn small tab-close" aria-label={`Close ${name}`} title={dirty ? 'Unsaved changes. Close' : 'Close (Ctrl+F4)'} onClick={() => ws.closeTab(t.id)}>
                    <Icon name="close" size={10} />
                  </button>
                )}
              </div>
            );
          })}
      </div>
      <div className="tabs-controls">
        <button
          type="button"
          className={'icon-btn small' + (hidden.size ? ' has-hidden' : '')}
          aria-label={hidden.size ? `${hidden.size} more tabs` : 'All tabs'}
          title={hidden.size ? `${hidden.size} more tab${hidden.size === 1 ? '' : 's'}` : 'All tabs'}
          onClick={(e) => setList(list ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
        >
          <Icon name="chevronDown" size={13} />
          {hidden.size > 0 && <span className="tabs-more">{hidden.size}</span>}
        </button>
        <button
          type="button"
          className="icon-btn small"
          aria-label="Tab actions"
          title="Tab Actions"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({ x: r.right - 220, y: r.bottom + 4, items: closeMenuItems(null) });
          }}
        >
          <Icon name="more" size={13} />
        </button>
      </div>
      {list && (
        <TabList
          anchor={list}
          tabs={listed}
          ws={ws}
          color={color}
          onPick={(id) => {
            setList(null);
            ws.setActiveId(id);
          }}
          onClose={() => setList(null)}
        />
      )}
      {drag && (() => {
        const t = ws.tabs.find((x) => x.id === drag.id);
        if (!t) return null;
        const { name, icon } = label(t);
        const c = color(t);
        return (
          <div className={'tab tab-ghost' + (t.id === ws.activeId ? ' active' : '') + (c ? ` file-color-${c}` : '')} style={{ left: drag.x - drag.grabX, top: drag.y - drag.grabY, width: drag.width }}>
            <span className="tab-main">
              {opts.showIcon && icon}
              <span className="tab-name">{name}</span>
            </span>
          </div>
        );
      })()}
      {tip && (
        <div className="tab-tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {tip.text}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The ▾ list: tabs that don't fit (all tabs when everything fits), with close buttons. */
function TabList({ anchor, tabs, ws, color, onPick, onClose }: { anchor: DOMRect; tabs: Tab[]; ws: Workspace; color: (t: Tab) => string | null; onPick: (id: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    box.current?.focus();
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', outside, true);
    return () => window.removeEventListener('mousedown', outside, true);
  }, [onClose]);

  return (
    <div
      ref={box}
      className="tab-list"
      tabIndex={-1}
      style={{ right: Math.max(8, window.innerWidth - anchor.right), top: anchor.bottom + 4 }}
      role="listbox"
      aria-label="Open tabs"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, tabs.length - 1));
        else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
        else if (e.key === 'Enter' && tabs[active]) onPick(tabs[active].id);
        else return;
        e.preventDefault();
      }}
    >
      {tabs.map((t, i) => {
        const { name, icon, title } = tabInfo(ws, t);
        const c = color(t);
        return (
          <div
            key={t.id}
            role="option"
            aria-selected={t.id === ws.activeId}
            className={'tab-list-item' + (i === active ? ' active' : '') + (t.id === ws.activeId ? ' current' : '') + (c ? ` file-color-${c}` : '')}
            title={title}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(t.id)}
          >
            {icon}
            <span className="tab-name">{name}</span>
            {t.kind === 'file' && ws.dirty.has(t.path) && <span className="dirty-mark">*</span>}
            <span className="grow" />
            <button
              type="button"
              className="icon-btn small"
              aria-label={`Close ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                ws.closeTab(t.id);
              }}
            >
              <Icon name="close" size={9} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// The Show Usages popup (Ctrl+Alt+F7, clicking "N usages"): what was searched and how many
// usages, filters (read / write access, dynamic usages, merge lines), the scope (Project Files or
// Project and Libraries), the usages with their code, and the selected one's path below.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { Usage } from '../lsp/monacoBridge';
import { baseName, relativePath } from '../backend/types';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

export function UsagesPopup({ ws }: { ws: Workspace }) {
  const p = ws.usagesPopup!;
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(true);
  const [dynamic, setDynamic] = useState(true);
  const [merge, setMerge] = useState(false);
  const [selected, setSelected] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const hasAccess = p.items.some((u) => u.access);
  const hasDynamic = p.items.some((u) => u.dynamic);
  const shown = useMemo(() => {
    let items = p.items.filter((u) => (u.access === 'read' ? read : u.access === 'write' ? write : true) && (dynamic || !u.dynamic));
    if (merge) {
      const seen = new Set<string>();
      items = items.filter((u) => {
        const k = `${u.path}:${u.line}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return items;
  }, [p.items, read, write, dynamic, merge]);

  useEffect(() => setSelected(0), [shown.length]);
  useEffect(() => {
    list.current?.querySelector('.up-row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  // Below the line it was opened from; above when there is no room; never off screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = p.request.anchor.y + 22;
    const top = below + r.height > window.innerHeight - 8 ? Math.max(8, p.request.anchor.y - r.height - 6) : below;
    setPlace({ left: Math.max(8, Math.min(p.request.anchor.x, window.innerWidth - r.width - 8)), top });
  }, [p.request, shown.length, p.loading]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.usages-popup, .ctx-menu')) ws.closeUsagesPopup();
    };
    window.addEventListener('mousedown', outside, true);
    box.current?.focus();
    return () => window.removeEventListener('mousedown', outside, true);
  }, [ws]);

  const open = (u: Usage) => {
    ws.closeUsagesPopup();
    ws.openFile(u.path, { line: u.line, column: u.column });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') ws.closeUsagesPopup();
    else if (e.key === 'ArrowDown') setSelected((i) => Math.min(i + 1, shown.length - 1));
    else if (e.key === 'ArrowUp') setSelected((i) => Math.max(i - 1, 0));
    else if (e.key === 'Enter' && shown[selected]) open(shown[selected]);
    else if (e.key === 'r' && e.ctrlKey && hasAccess) setRead(!read);
    else if (e.key === 'w' && e.ctrlKey && hasAccess) setWrite(!write);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const current = shown[selected];
  const count = p.items.length;
  return (
    <div
      ref={box}
      className="usages-popup"
      role="dialog"
      aria-label={`Usages of ${p.name}`}
      tabIndex={-1}
      style={place ? { left: place.left, top: place.top } : { left: p.request.anchor.x, top: p.request.anchor.y + 22, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      <div className="up-head">
        <span className="up-title">
          {p.kind && <span className="up-kind">{p.kind} </span>}
          <b>{p.title || p.name}</b>
          {p.container && <span className="muted"> {p.container}</span>}
        </span>
        <span className="grow" />
        <span className="muted">{p.loading ? 'Searching…' : `${count} ${count === 1 ? 'usage' : 'usages'}`}</span>
        <button type="button" className="icon-btn small" title="Open in Find Tool Window" aria-label="Open in Find tool window" onClick={ws.usagesToToolWindow} disabled={p.loading}>
          <Icon name="expandAll" size={13} />
        </button>
      </div>
      <div className="up-tools" role="toolbar">
        <Toggle on={merge} title="Merge Usages from the Same Line" icon="collapseAll" onClick={() => setMerge(!merge)} />
        {hasAccess && <Toggle on={read} title="Show Read Access (Ctrl+R)" text="←" onClick={() => setRead(!read)} />}
        {hasAccess && <Toggle on={write} title="Show Write Access (Ctrl+W)" text="→" onClick={() => setWrite(!write)} />}
        {hasDynamic && <Toggle on={dynamic} title="Show Dynamic Usages (called on untyped variables)" text="$" onClick={() => setDynamic(!dynamic)} />}
        <span className="up-sep" />
        <button
          type="button"
          className="btn small ghost up-scope"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: r.left,
              y: r.bottom + 2,
              items: [
                { label: 'Project Files', checked: !p.vendor, run: () => void ws.setUsagesScope(false) },
                { label: 'Project and Libraries', checked: p.vendor, run: () => void ws.setUsagesScope(true) },
              ],
            });
          }}
        >
          {p.vendor ? 'Project and Libraries' : 'Project Files'} <Icon name="chevronDown" size={11} />
        </button>
      </div>
      <div ref={list} className="up-list" role="listbox">
        {p.error && <div className="up-empty error-text">{p.error}</div>}
        {!p.error && !p.loading && !shown.length && <div className="up-empty muted">{count ? 'All usages are filtered out.' : 'No usages found.'}</div>}
        {shown.map((u, i) => (
          <div
            key={`${u.path}:${u.line}:${u.column}`}
            role="option"
            aria-selected={i === selected}
            className={'up-row' + (i === selected ? ' selected' : '') + (u.dynamic ? ' dynamic' : '')}
            onMouseMove={() => setSelected(i)}
            onClick={() => open(u)}
            title={u.dynamic ? 'Dynamic usage: called on something whose type is unknown' : relativePath(ws.backend, u.path)}
          >
            <FileIcon path={u.path} size={14} />
            <span className="up-file">{baseName(u.path)}</span>
            <span className="up-line">{u.line}</span>
            <span className={'up-access ' + (u.access || '')}>{u.access === 'write' ? '→' : u.access === 'read' ? '←' : u.dynamic ? '?' : ''}</span>
            <span className="up-code mono">
              <Code text={u.preview} name={nameOf(p.name)} />
            </span>
          </div>
        ))}
      </div>
      <div className="up-foot muted">{current ? relativePath(ws.backend, current.path) : ' '}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const nameOf = (name: string) => name.split('::').pop()!.replace(/[()$]/g, '').split('\\').pop()!;

function Toggle({ on, title, icon, text, onClick }: { on: boolean; title: string; icon?: 'collapseAll'; text?: string; onClick: () => void }) {
  return (
    <button type="button" className={'icon-btn small up-toggle' + (on ? ' on' : '')} title={title} aria-label={title} aria-pressed={on} onClick={onClick}>
      {icon ? <Icon name={icon} size={13} /> : <span className="up-glyph">{text}</span>}
    </button>
  );
}

/** The line of code with the searched name highlighted. */
function Code({ text, name }: { text: string; name: string }) {
  const i = name ? text.toLowerCase().indexOf(name.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b className="up-hit">{text.slice(i, i + name.length)}</b>
      {text.slice(i + name.length)}
    </>
  );
}

import { useRef } from 'react';
import { Icon, type IconName } from './Icon';
import { ANCHOR_LABELS, type Anchor, type Tool } from '../toolLayout';

export interface StripItem {
  id: string;
  label: string;
  icon: IconName;
  active: boolean;
  dot?: boolean;
  count?: number;
}

/** A tool window icon being dragged to another place (see WorkspaceView). */
export interface ToolDrag {
  tool: Tool;
  icon: IconName;
  x: number;
  y: number;
  target: { anchor: Anchor; index: number } | null;
}

interface Props {
  side: 'left' | 'right';
  /** Tool windows by place: the side's top place, then its bottom one. */
  groups: { anchor: Anchor; items: StripItem[] }[];
  /** The bottom panel's tool windows, at the foot of the strip. */
  bottomGroup?: { anchor: Anchor; items: StripItem[] };
  onPick: (id: string) => void;
  drag: ToolDrag | null;
  onDragStart: (tool: Tool, icon: IconName, x: number, y: number) => void;
}

export function ToolStrip({ side, groups, bottomGroup, onPick, drag, onDragStart }: Props) {
  /** A press that turned into a drag doesn't also click. */
  const dragged = useRef(false);

  const button = (item: StripItem, draggable: boolean) => (
    <button
      key={item.id}
      type="button"
      className={'strip-btn' + (item.active ? ' active' : '')}
      aria-label={item.label}
      aria-pressed={item.active}
      title={drag ? undefined : item.label}
      data-tool={draggable ? item.id : undefined}
      onPointerDown={
        draggable
          ? (e) => {
              if (e.button !== 0) return;
              dragged.current = false;
              const start = { x: e.clientX, y: e.clientY };
              const move = (ev: PointerEvent) => {
                if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
                dragged.current = true;
                cleanup();
                onDragStart(item.id as Tool, item.icon, ev.clientX, ev.clientY);
              };
              const cleanup = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', cleanup);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', cleanup);
            }
          : undefined
      }
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onPick(item.id);
      }}
    >
      <Icon name={item.icon} size={17} />
      {item.dot && <span className="strip-dot" />}
      {!!item.count && <span className="strip-count">{item.count > 9 ? '9+' : item.count}</span>}
    </button>
  );

  const placeholder = (anchor: Anchor) => (
    <span key="drop" className="strip-drop">
      <span className={`strip-drop-tip ${side}`}>Move to {ANCHOR_LABELS[anchor]}</span>
    </span>
  );

  /** One place's icons, with the drop placeholder while a tool is dragged over it. */
  const group = (anchor: Anchor, items: StripItem[]) => {
    const children = items.filter((i) => i.id !== drag?.tool).map((i) => button(i, true));
    const target = drag?.target?.anchor === anchor ? drag.target.index : -1;
    if (target >= 0) children.splice(Math.min(target, children.length), 0, placeholder(anchor));
    return (
      <div className="strip-group" data-anchor={anchor}>
        {children}
      </div>
    );
  };

  const visible = (g: number) => groups[g].items.some((i) => i.id !== drag?.tool) || drag?.target?.anchor === groups[g].anchor;

  return (
    <nav className={`strip ${side}` + (drag ? ' dragging' : '')} aria-label={side === 'left' ? 'Tool windows' : 'Right tool windows'}>
      {groups.map(({ anchor, items }, g) => (
        <span key={anchor} style={{ display: 'contents' }}>
          {g > 0 && (!!drag || (visible(0) && visible(g))) && <span className="strip-sep" />}
          {group(anchor, items)}
        </span>
      ))}
      {bottomGroup && (
        <>
          <span className="grow" />
          {group(bottomGroup.anchor, bottomGroup.items)}
        </>
      )}
    </nav>
  );
}

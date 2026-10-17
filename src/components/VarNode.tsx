// One variable in the debugger (Variables, Watches, the editor's hover), expandable like PhpStorm's.

import { useState } from 'react';
import { useDebug } from '../debug/manager';
import { displayValue, type Property } from '../debug/dbgp';
import { Icon } from './Icon';

const TYPE_LETTER: Record<string, string> = { array: '[]', object: '{}', string: 's', int: 'i', float: 'f', bool: 'b', null: '∅', resource: 'r' };

export function VarNode({
  p,
  context,
  depth,
  onMenu,
  watch,
  result,
  onRemove,
}: {
  p: Property;
  context: number;
  depth: number;
  onMenu: (e: React.MouseEvent, p: Property) => void;
  watch?: boolean;
  result?: boolean;
  onRemove?: () => void;
}) {
  const debug = useDebug();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Property[] | null>(p.children && p.children.length >= p.numChildren ? p.children : null);
  const [loading, setLoading] = useState(false);

  const load = async (page = 0) => {
    setLoading(true);
    const list = await debug.expand(p, context, page);
    setChildren((c) => (page ? [...(c ?? []), ...list.slice(c?.length ?? 0)] : list));
    setLoading(false);
  };

  const toggle = () => {
    if (!p.hasChildren) return;
    setOpen(!open);
    if (!open && !children) void load();
  };

  const value = displayValue(p);
  const pageSize = p.pageSize || children?.length || 0;
  const more = children && p.numChildren > children.length ? p.numChildren - children.length : 0;
  return (
    <>
      <div className="var-row" role="treeitem" aria-expanded={p.hasChildren ? open : undefined} style={{ paddingLeft: 6 + depth * 16 }} onClick={toggle} onContextMenu={(e) => onMenu(e, p)} title={p.fullname}>
        {p.hasChildren ? (
          <span className={'chev' + (open ? ' open' : '')}>
            <Icon name="chevronRight" size={11} strokeWidth={2.5} />
          </span>
        ) : (
          <span style={{ width: 11, flex: 'none' }} />
        )}
        {watch ? <Icon name="eye" size={12} /> : result ? <Icon name="evaluate" size={12} /> : <span className={'var-type t-' + p.type}>{TYPE_LETTER[p.type] ?? '·'}</span>}
        <span className={'var-name' + (p.facet?.includes('private') ? ' private' : p.facet?.includes('protected') ? ' protected' : '')}>{p.name}</span>
        <span className="muted"> = </span>
        <span className={'var-value t-' + p.type}>{value}</span>
        {onRemove && (
          <button
            type="button"
            className="icon-btn small var-remove"
            aria-label="Remove watch"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
      {open && loading && !children && (
        <div className="muted var-row" style={{ paddingLeft: 22 + (depth + 1) * 16 }}>
          Loading…
        </div>
      )}
      {open && children?.map((c) => <VarNode key={c.fullname || c.name} p={c} context={context} depth={depth + 1} onMenu={onMenu} />)}
      {open && more > 0 && (
        <button type="button" className="var-row var-more" style={{ paddingLeft: 22 + (depth + 1) * 16 }} onClick={() => void load(Math.floor((children?.length ?? 0) / Math.max(1, pageSize)))} disabled={loading}>
          Show {Math.min(more, pageSize || more)} more ({more} left)
        </button>
      )}
    </>
  );
}

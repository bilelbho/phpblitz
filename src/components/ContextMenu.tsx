import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import type { TextChange } from '../lsp/monacoBridge';

export type ContextItem =
  | {
      kind?: 'item';
      label: string;
      shortcut?: string;
      icon?: IconName;
      /** Shows a check mark (toggle options). */
      checked?: boolean;
      disabled?: boolean;
      run?: () => void;
      submenu?: ContextItem[];
      /** What running it would change in the current file (Alt+Enter popup preview). */
      preview?: () => Promise<TextChange[] | null>;
    }
  | { kind: 'sep' };

interface Props {
  x: number;
  y: number;
  items: ContextItem[];
  onClose: () => void;
}

/** JetBrains-style popup menu with submenus, opened at a screen position. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.ctx-menu')) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return <MenuList x={x} y={y} items={items} onClose={onClose} autoFocus />;
}

interface ListProps {
  x: number;
  y: number;
  /** For submenus: the parent row's left edge, used to flip left when there is no room on the right. */
  flipX?: number;
  items: ContextItem[];
  onClose: () => void;
  onBack?: () => void;
  autoFocus?: boolean;
}

function MenuList({ x, y, flipX, items, onClose, onBack, autoFocus }: ListProps) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);
  const hoverTimer = useRef<number>();

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const m = el.current;
    if (!m) return;
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    let left = x;
    if (left + w > window.innerWidth - 4) left = flipX !== undefined ? flipX - w : window.innerWidth - w - 4;
    const top = Math.max(4, Math.min(y, window.innerHeight - h - 4));
    setPos({ left: Math.max(4, left), top, ready: true });
    if (autoFocus) m.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
  }, [x, y, flipX, autoFocus]);

  const rows = () => [...(el.current?.querySelectorAll<HTMLButtonElement>(':scope > .menu-item:not(:disabled)') ?? [])];

  const openSubmenu = (index: number, row: HTMLElement, focus = false) => {
    const r = row.getBoundingClientRect();
    setOpenSub({ index, x: r.right + 2, y: r.top - 7, flipX: r.left - 2 });
    if (focus) {
      window.setTimeout(() => {
        const sub = el.current?.parentElement?.querySelector<HTMLButtonElement>(`[data-parent="${index}"] .menu-item:not(:disabled)`);
        sub?.focus();
      }, 0);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = rows();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 && !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'ArrowRight') {
      const index = Number(list[i]?.dataset.index);
      const item = items[index];
      if (item && item.kind !== 'sep' && item.submenu) {
        e.preventDefault();
        e.stopPropagation();
        openSubmenu(index, list[i], true);
      }
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };

  return (
    <>
      <div
        ref={el}
        className="menu ctx-menu"
        role="menu"
        style={{ position: 'fixed', left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          if (item.kind === 'sep') return <div key={index} className="menu-sep" role="separator" />;
          const hasSub = !!item.submenu;
          return (
            <button
              key={index}
              type="button"
              role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.checked}
              aria-haspopup={hasSub ? 'menu' : undefined}
              aria-expanded={hasSub ? openSub?.index === index : undefined}
              className={'menu-item' + (openSub?.index === index ? ' sub-open' : '')}
              data-index={index}
              disabled={item.disabled}
              onMouseEnter={(e) => {
                const row = e.currentTarget;
                row.focus({ preventScroll: true });
                window.clearTimeout(hoverTimer.current);
                hoverTimer.current = window.setTimeout(() => (hasSub ? openSubmenu(index, row) : setOpenSub(null)), hasSub ? 120 : 200);
              }}
              onClick={(e) => {
                if (hasSub) return openSubmenu(index, e.currentTarget, true);
                onClose();
                item.run?.();
              }}
            >
              <span className="menu-icon">
                {item.checked ? <Icon name="check" size={14} strokeWidth={2.4} /> : item.icon && <Icon name={item.icon} size={15} strokeWidth={1.8} />}
              </span>
              {item.label}
              {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
              {hasSub && (
                <span className="menu-chevron">
                  <Icon name="chevronRight" size={12} strokeWidth={2.2} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {openSub && (() => {
        const item = items[openSub.index];
        if (!item || item.kind === 'sep' || !item.submenu) return null;
        return (
          <div data-parent={openSub.index} style={{ display: 'contents' }}>
            <MenuList
              x={openSub.x}
              y={openSub.y}
              flipX={openSub.flipX}
              items={item.submenu}
              onClose={onClose}
              onBack={() => {
                setOpenSub(null);
                el.current?.querySelector<HTMLButtonElement>(`[data-index="${openSub.index}"]`)?.focus();
              }}
            />
          </div>
        );
      })()}
    </>
  );
}

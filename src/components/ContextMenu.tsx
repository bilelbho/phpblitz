import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import type { TextChange } from '../lsp/monacoBridge';

export type ContextItem =
  | {
      kind?: 'item';
      label: string;
      /** Underlined letter; pressing it while the menu is open picks the item (main menu). */
      mnemonic?: string;
      shortcut?: string;
      icon?: IconName;
      /** Shows a check mark (toggle options). */
      checked?: boolean;
      /** A section title ("View in Groups"), not clickable. */
      head?: boolean;
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
  /** Main menu: Left / Right past the menu's edge moves to the neighbouring menu. */
  onNavigate?: (step: -1 | 1) => void;
  /** Clicks in this element don't close the menu (the menu bar handles them). */
  ignoreClicksIn?: string;
}

/** popup menu with submenus, opened at a screen position. */
export function ContextMenu({ x, y, items, onClose, onNavigate, ignoreClicksIn }: Props) {
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest?.('.ctx-menu') && !(ignoreClicksIn && target.closest?.(ignoreClicksIn))) onClose();
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
  }, [onClose, ignoreClicksIn]);

  return <MenuList x={x} y={y} items={items} onClose={onClose} onNavigate={onNavigate} autoFocus />;
}

interface ListProps {
  x: number;
  y: number;
  /** For submenus: the parent row's left edge, used to flip left when there is no room on the right. */
  flipX?: number;
  items: ContextItem[];
  onClose: () => void;
  onBack?: () => void;
  onNavigate?: (step: -1 | 1) => void;
  autoFocus?: boolean;
}

function MenuList({ x, y, flipX, items, onClose, onBack, onNavigate, autoFocus }: ListProps) {
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
  }, [x, y, flipX]);

  // Once shown: a hidden (not yet placed) menu can't take focus.
  useEffect(() => {
    if (pos.ready && autoFocus) el.current?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
  }, [pos.ready, autoFocus]);

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
    // A mnemonic letter: the item underlining it.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const index = items.findIndex((it) => it.kind !== 'sep' && !it.disabled && it.mnemonic?.toLowerCase() === e.key.toLowerCase());
      const row = list.find((r) => Number(r.dataset.index) === index);
      if (row) {
        e.preventDefault();
        e.stopPropagation();
        row.focus();
        row.click();
        return;
      }
    }
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
      } else if (onNavigate) {
        e.preventDefault();
        e.stopPropagation();
        onNavigate(1);
      }
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    } else if (e.key === 'ArrowLeft' && onNavigate) {
      e.preventDefault();
      e.stopPropagation();
      onNavigate(-1);
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
          if (item.head) return <div key={index} className="menu-head" role="presentation">{item.label}</div>;
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
                {item.checked ? <Icon name="check" size={14} /> : item.icon && <Icon name={item.icon} size={15} />}
              </span>
              {item.mnemonic ? (
                <span>
                  <Mnemonic label={item.label} letter={item.mnemonic} />
                </span>
              ) : (
                item.label
              )}
              {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
              {hasSub && (
                <span className="menu-chevron">
                  <Icon name="chevronRight" size={12} />
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

/** A label with its mnemonic letter underlined (the first one, matching case first). */
export function Mnemonic({ label, letter }: { label: string; letter: string }) {
  let i = label.indexOf(letter);
  if (i < 0) i = label.toLowerCase().indexOf(letter.toLowerCase());
  if (i < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, i)}
      <span className="mnemonic">{label[i]}</span>
      {label.slice(i + 1)}
    </>
  );
}

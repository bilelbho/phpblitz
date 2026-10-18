// The main menu as a menu bar, like PhpStorm's: merged into the main toolbar (every menu that fits,
// then a › that shows the rest) or as a full row above it. Clicking a title opens its menu; while one is
// open, hovering another title or pressing Left / Right moves to it; Alt+<underlined letter> opens
// a menu from anywhere.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TopMenu } from '../mainMenu';
import { ContextMenu, Mnemonic } from './ContextMenu';
import { Icon } from './Icon';
import { getSettings } from '../settings';

export function MainMenuBar({ menus, merged }: { menus: TopMenu[]; merged: boolean }) {
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);
  /** The menu to open once its title is rendered (it may appear only after expanding). */
  const [pending, setPending] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(!merged);
  const titles = useRef<(HTMLButtonElement | null)[]>([]);
  const nav = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  /** Merged layout: how many titles fit in the toolbar (the rest go behind ›). */
  const [fit, setFit] = useState(menus.length);
  const shown = merged && !expanded ? menus.slice(0, fit) : menus;
  const folded = merged && !expanded && fit < menus.length;

  /** How many titles fit: the menu's own width plus the toolbar's stretchable gaps, less any overflow. */
  const measureFit = useCallback((): number | null => {
    const bar = nav.current;
    const host = bar?.parentElement;
    if (!bar || !host || !measure.current) return null;
    const widths = [...measure.current.children].map((c) => (c as HTMLElement).offsetWidth + 1);
    const more = widths.pop() ?? 0;
    let free = bar.offsetWidth - 16;
    for (const child of host.children) if (child.classList.contains('drag') && parseFloat(getComputedStyle(child).flexGrow) > 0) free += (child as HTMLElement).offsetWidth;
    // A toolbar wider than the window: the overflow isn't free either.
    free -= Math.max(0, host.scrollWidth - host.clientWidth);
    // Nor is the room taken from names shortened with "…": the menu folds before they shrink.
    for (const text of host.querySelectorAll<HTMLElement>('.widget-text')) free -= text.scrollWidth - text.clientWidth;
    if (widths.reduce((a, b) => a + b, 0) <= free) return widths.length;
    let n = 0;
    let used = more;
    while (n < widths.length && used + widths[n] <= free) used += widths[n++];
    return Math.max(1, n);
  }, []);

  // On every resize of the toolbar.
  useLayoutEffect(() => {
    const host = nav.current?.parentElement;
    if (!merged || !host) return;
    const update = () => {
      const n = measureFit();
      if (n !== null) setFit(n);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [merged, menus.length, measureFit]);

  // After folding, the names may still be shortened: fold further if so (never back, which could flicker).
  useLayoutEffect(() => {
    if (!merged) return;
    const n = measureFit();
    if (n !== null && n < fit) setFit(n);
  }, [merged, fit, measureFit]);

  useEffect(() => setExpanded(!merged), [merged]);

  // Expanded with › but no menu opened: a click elsewhere folds it back.
  useEffect(() => {
    if (!merged || !expanded || open) return;
    const outside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.menubar')) setExpanded(false);
    };
    window.addEventListener('mousedown', outside, true);
    return () => window.removeEventListener('mousedown', outside, true);
  }, [merged, expanded, open]);

  const openAt = useCallback(
    (index: number) => {
      if (merged && index >= fit) setExpanded(true);
      setPending(index);
    },
    [merged, fit],
  );

  useLayoutEffect(() => {
    if (pending === null) return;
    const r = titles.current[pending]?.getBoundingClientRect();
    if (r) setOpen({ index: pending, x: r.left, y: r.bottom + 2 });
    setPending(null);
  }, [pending, expanded]);

  const close = useCallback(() => {
    setOpen(null);
    if (merged) setExpanded(false);
  }, [merged]);

  // Alt+<letter> opens the menu with that underlined letter.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key.length !== 1) return;
      // Alt+F, Alt+B… are word moves in a shell: the terminal keeps them when it overrides IDE shortcuts.
      if (getSettings().terminal.overrideIdeShortcuts && (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      const index = menus.findIndex((m) => m.mnemonic.toLowerCase() === e.key.toLowerCase());
      if (index < 0) return;
      e.preventDefault();
      e.stopPropagation();
      openAt(index);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [menus, openAt]);

  return (
    <nav ref={nav} className="menubar" aria-label="Main menu">
      {shown.map((m, index) => (
        <button
          key={m.label}
          ref={(el) => {
            titles.current[index] = el;
          }}
          type="button"
          className={'menubar-title' + (open?.index === index ? ' open' : '')}
          aria-haspopup="menu"
          aria-expanded={open?.index === index}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (open?.index === index ? close() : openAt(index))}
          onMouseEnter={() => open && open.index !== index && openAt(index)}
        >
          <Mnemonic label={m.label} letter={m.mnemonic} />
        </button>
      ))}
      {folded && (
        <button type="button" className="menubar-title menubar-more" aria-label="Show the whole main menu" title="Main Menu" onClick={() => setExpanded(true)}>
          <Icon name="chevronRight" size={16} />
        </button>
      )}
      {merged && (
        // Every title, out of sight, to know their widths.
        <div ref={measure} className="menubar-measure" aria-hidden="true">
          {menus.map((m) => (
            <span key={m.label} className="menubar-title">
              {m.label}
            </span>
          ))}
          <span className="menubar-title menubar-more">
            <Icon name="chevronRight" size={16} />
          </span>
        </div>
      )}
      {open && (
        <ContextMenu
          key={open.index}
          x={open.x}
          y={open.y}
          items={menus[open.index].items()}
          ignoreClicksIn=".menubar"
          onClose={close}
          onNavigate={(step) => openAt((open.index + step + menus.length) % menus.length)}
        />
      )}
    </nav>
  );
}

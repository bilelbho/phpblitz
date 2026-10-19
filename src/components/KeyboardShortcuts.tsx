// Help ▸ Keyboard Shortcuts: every shortcut in one searchable list. The main menu's entries (their
// shortcuts are the ones bound), the tool windows', and the editor's and terminal's own keys.
// Typing filters by name, menu or keys ("ctrl+e"); clicking an entry runs it.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { ContextItem } from './ContextMenu';
import type { TopMenu } from '../mainMenu';
import { TOOL_WINDOWS } from './RecentFiles';
import { Icon } from './Icon';

interface Entry {
  group: string;
  label: string;
  shortcut: string;
  run?: () => void;
}

/** Keys that work without a menu entry. */
const MORE: Entry[] = [
  { group: 'Editor', label: 'Show Context Actions (fixes, refactorings)', shortcut: 'Alt+Enter' },
  { group: 'Editor', label: 'Edit with AI', shortcut: 'Ctrl+Shift+I' },
  { group: 'Editor', label: 'Find Usages', shortcut: 'Alt+F7' },
  { group: 'Editor', label: 'Rename', shortcut: 'Shift+F6' },
  { group: 'Editor', label: 'Go to Declaration', shortcut: 'Ctrl+B' },
  { group: 'Editor', label: 'Go to Declaration', shortcut: 'Ctrl+Click' },
  { group: 'Editor', label: 'Next / Previous Highlighted Error', shortcut: 'F2 / Shift+F2' },
  { group: 'Editor', label: 'Accept ghost text', shortcut: 'Tab' },
  { group: 'Navigation', label: 'Back / Forward', shortcut: 'Mouse side buttons' },
  { group: 'Terminal', label: 'Copy selection', shortcut: 'Ctrl+Shift+C' },
  { group: 'Terminal', label: 'Copy selection (when text is selected)', shortcut: 'Ctrl+C' },
  { group: 'Terminal', label: 'Paste', shortcut: 'Ctrl+Shift+V' },
  { group: 'Terminal', label: 'Find in the output', shortcut: 'Ctrl+F' },
  { group: 'Terminal', label: 'Previous / Next Command', shortcut: 'Ctrl+Up / Ctrl+Down' },
  { group: 'Terminal', label: 'Open a file path in the output', shortcut: 'Click' },
  { group: 'Recent Files', label: 'Show edited files only', shortcut: 'Ctrl+E (in Recent Files)' },
  { group: 'Recent Locations', label: 'Show changed places only', shortcut: 'Ctrl+Shift+E (in Recent Locations)' },
];

/** The menu's items with a shortcut, submenus included. */
function fromMenu(group: string, items: ContextItem[], out: Entry[]) {
  for (const item of items) {
    if (item.kind === 'sep' || !('label' in item)) continue;
    // Menu labels can carry a live value ("Zoom IDE (Current: 100%)"): not part of the name.
    if (item.submenu) fromMenu(`${group} ▸ ${item.label.replace(/\s*\(.*\)$/, '')}`, item.submenu, out);
    if (item.shortcut) out.push({ group, label: item.label.replace(/…$/, ''), shortcut: item.shortcut, run: item.disabled ? undefined : item.run });
  }
}

export function KeyboardShortcuts({ ws, menus, onClose }: { ws: Workspace; menus: TopMenu[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const all = useMemo(() => {
    const out: Entry[] = [];
    for (const m of menus) fromMenu(m.label, m.items(), out);
    for (const t of TOOL_WINDOWS) if (t.shortcut) out.push({ group: 'Tool Windows', label: t.label, shortcut: t.shortcut, run: () => t.run(ws) });
    out.push(...MORE);
    // The same command can be in two menus: once is enough.
    const seen = new Set<string>();
    return out.filter((e) => {
      const key = `${e.label}|${e.shortcut}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [menus, ws]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // "ctrl+e" matches the keys; words match names and menus.
    const keys = q.replace(/\s+/g, '');
    return all.filter((e) => e.shortcut.toLowerCase().replace(/\s+/g, '').includes(keys) || `${e.label} ${e.group}`.toLowerCase().includes(q));
  }, [all, query]);
  const groups = [...new Set(shown.map((e) => e.group))];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pb-dialog shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
        <div className="ai-dialog-title">
          <Icon name="code" size={14} />
          Keyboard Shortcuts
          <span className="muted ai-dialog-sub">{all.length} shortcuts · click one to run it</span>
        </div>
        <div className="field shortcuts-search">
          <Icon name="search" size={14} />
          <input ref={input} placeholder="Search by name or keys (ctrl+shift+e)" aria-label="Search shortcuts" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </div>
        <div className="shortcuts-list">
          {groups.map((g) => (
            <div key={g} className="shortcuts-group">
              <div className="shortcuts-group-title">{g}</div>
              {shown
                .filter((e) => e.group === g)
                .map((e) => (
                  <button
                    key={`${e.label}|${e.shortcut}`}
                    type="button"
                    className="shortcuts-row"
                    disabled={!e.run}
                    onClick={() => {
                      onClose();
                      e.run?.();
                    }}
                  >
                    <span className="grow">{e.label}</span>
                    <span className="shortcuts-keys">
                      {e.shortcut.split(' / ').map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </span>
                  </button>
                ))}
            </div>
          ))}
          {!shown.length && <div className="muted shortcuts-empty">No shortcut matches “{query}”.</div>}
        </div>
      </div>
    </div>
  );
}

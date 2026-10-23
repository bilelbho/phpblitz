// Help ▸ Keyboard Shortcuts: every shortcut in one searchable list. The active keymap's commands
// (Settings ▸ Keymap), and the keys that work without one (mouse, terminal, popups).
// Typing filters by name, group or keys ("ctrl+e"); clicking an entry runs it.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import type { TopMenu } from '../mainMenu';
import { COMMANDS } from '../keymap/catalog';
import { runCommand } from '../keymap/commands';
import { displayKeys } from '../keymap/keys';
import { keysFor } from '../keymap/store';
import { editorAction } from '../editorCommands';
import { Icon } from './Icon';

interface Entry {
  group: string;
  label: string;
  shortcut: string;
  run?: () => void;
}

/** Keys that aren't in the keymap. */
const MORE: Entry[] = [
  { group: 'Editor', label: 'Go to Declaration', shortcut: 'Ctrl+Click' },
  { group: 'Editor', label: 'Add Caret', shortcut: 'Alt+Click' },
  { group: 'Editor', label: 'Accept ghost text', shortcut: 'Tab' },
  { group: 'Editor', label: 'Back to one caret', shortcut: 'Escape' },
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

// The props stay as they were for the callers; the list comes from the keymap now.
export function KeyboardShortcuts({ onClose }: { ws: Workspace; menus: TopMenu[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const all = useMemo(() => {
    const out: Entry[] = [];
    for (const c of COMMANDS) {
      const keys = keysFor(c.id);
      if (!keys.length) continue;
      // Run where it applies: the workspace's handler, else in the code editor.
      const run = () => void (runCommand(c.id, null) || editorAction(c.id)?.());
      out.push({ group: c.group, label: c.label.replace(/…$/, ''), shortcut: keys.map(displayKeys).join(' / '), run });
    }
    // Cmd and Option on macOS for these too ("Ctrl+Click").
    out.push(...MORE.map((e) => ({ ...e, shortcut: e.shortcut.split(' / ').map(displayKeys).join(' / ') })));
    return out;
  }, []);

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

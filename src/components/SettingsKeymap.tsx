// Settings ▸ Keymap: which editor's keys PHPBlitz uses (its own, VS Code's, Sublime Text's…), and
// changes on top: every command with its keys, searchable by name or by pressing the keys;
// double-click or right-click a command to add keys (chords too), remove or reset them. Import
// VS Code's keybindings.json or a PHPBlitz keymap file; export yours.

import { useEffect, useMemo, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { KeymapSettings } from '../settings';
import { COMMANDS, command, type Command } from '../keymap/catalog';
import { clash, KEYMAPS } from '../keymap/keymaps';
import { displayKeys, formatStroke, isMac, strokeOf } from '../keymap/keys';
import { bindingsOf, resetKeysIn, setKeysIn } from '../keymap/store';
import { exportKeymap, importKeymap, importVsCode, looksLikeVsCode } from '../keymap/importExport';
import { isTauri } from '../platform';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon } from './Icon';

/** Records one or two strokes (a chord) from key presses. */
function useStrokeRecorder() {
  const [strokes, setStrokes] = useState<string[]>([]);
  const last = useRef(0);
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    const s = strokeOf(e.nativeEvent);
    if (!s) return false;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    const key = formatStroke(s);
    // A second stroke soon after the first makes a chord; later, or a third, starts over.
    setStrokes((prev) => (prev.length === 1 && now - last.current < 2000 ? [prev[0], key] : [key]));
    last.current = now;
    return true;
  };
  return { keys: strokes.join(' '), onKeyDown, clear: () => setStrokes([]) };
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="shortcuts-keys">
      {keys.map((k) => (
        <kbd key={k}>{displayKeys(k)}</kbd>
      ))}
    </span>
  );
}

/** The commands other than `id` that keys clash with (the same keys, or a chord's first half). */
function clashes(bindings: Map<string, string[]>, id: string, keys: string): Command[] {
  const out: Command[] = [];
  for (const [other, list] of bindings) if (other !== id && list.some((k) => clash(k, keys))) out.push(command(other)!);
  return out.filter(Boolean);
}

function AddKeysDialog({ cmd, bindings, onAdd, onClose }: { cmd: Command; bindings: Map<string, string[]>; onAdd: (keys: string, removeOthers: boolean) => void; onClose: () => void }) {
  const rec = useStrokeRecorder();
  const [removeOthers, setRemoveOthers] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const others = rec.keys ? clashes(bindings, cmd.id, rec.keys) : [];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pb-dialog keymap-add" role="dialog" aria-modal="true" aria-label="Add Keyboard Shortcut">
        <div className="ai-dialog-title">Keyboard Shortcut for “{cmd.label.replace(/…$/, '')}”</div>
        <div
          ref={box}
          tabIndex={0}
          className={'keymap-record' + (rec.keys ? '' : ' empty')}
          aria-label="Press the keys"
          onKeyDown={(e) => {
            // Escape with nothing recorded cancels; Escape is a key like any other after that.
            if (e.key === 'Escape' && !rec.keys) {
              e.stopPropagation();
              onClose();
              return;
            }
            rec.onKeyDown(e);
          }}
        >
          {rec.keys ? displayKeys(rec.keys) : 'Press the keys…'}
        </div>
        <p className="muted settings-help">A second key within two seconds makes a chord (like {isMac ? 'Cmd' : 'Ctrl'}+K {isMac ? 'Cmd' : 'Ctrl'}+C).</p>
        {others.length > 0 && (
          <div className="keymap-conflict">
            <Icon name="warning" size={14} />
            <span className="grow">
              Also used by {others.map((o) => `“${o.label.replace(/…$/, '')}”`).join(', ')}.
              <label className="settings-check keymap-remove-others">
                <input type="checkbox" className="checkbox" checked={removeOthers} onChange={(e) => setRemoveOthers(e.target.checked)} />
                Remove it from {others.length === 1 ? 'that command' : 'those commands'}
              </label>
            </span>
          </div>
        )}
        <div className="pb-dialog-buttons">
          <button type="button" className="link-btn" style={{ marginRight: 'auto' }} disabled={!rec.keys} onClick={() => (rec.clear(), box.current?.focus())}>
            Clear
          </button>
          <button type="button" className="btn primary" disabled={!rec.keys} onClick={() => onAdd(rec.keys, removeOthers && others.length > 0)}>
            OK
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function KeymapPage({ value, onChange }: { value: KeymapSettings; onChange: (next: KeymapSettings) => void }) {
  const bindings = useMemo(() => bindingsOf(value), [value]);
  const [query, setQuery] = useState('');
  const [byKeys, setByKeys] = useState(false);
  const rec = useStrokeRecorder();
  const keysInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (byKeys) keysInput.current?.focus();
  }, [byKeys]);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<Command | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const changed = Object.keys(value.overrides).length;

  const shown = useMemo(() => {
    if (byKeys) {
      if (!rec.keys) return COMMANDS;
      return COMMANDS.filter((c) => (bindings.get(c.id) ?? []).some((k) => k === rec.keys || k.startsWith(`${rec.keys} `)));
    }
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    const keysQuery = q.replace(/\s+/g, '');
    return COMMANDS.filter(
      (c) => `${c.label} ${c.group} ${c.id}`.toLowerCase().includes(q) || (bindings.get(c.id) ?? []).some((k) => displayKeys(k).toLowerCase().replace(/\s+/g, '').includes(keysQuery)),
    );
  }, [bindings, byKeys, query, rec.keys]);
  const groups = [...new Set(shown.map((c) => c.group))];

  /** Keys shared with another command (the debugger's, which only work while stopped, aside). */
  const conflictOf = (id: string): string | null => {
    const debugging = (x: string) => x.startsWith('phpblitz.debug');
    for (const k of bindings.get(id) ?? []) {
      const others = clashes(bindings, id, k).filter((o) => !(debugging(o.id) || debugging(id)));
      if (others.length) return `${displayKeys(k)} is also used by ${others.map((o) => o.label.replace(/…$/, '')).join(', ')}`;
    }
    return null;
  };

  const add = (cmd: Command, keys: string, removeOthers: boolean) => {
    let next = value;
    if (removeOthers) for (const o of clashes(bindings, cmd.id, keys)) next = setKeysIn(next, o.id, (bindings.get(o.id) ?? []).filter((k) => !clash(k, keys)));
    next = setKeysIn(next, cmd.id, [...(bindings.get(cmd.id) ?? []).filter((k) => k !== keys), keys]);
    onChange(next);
    setAdding(null);
  };

  const openMenu = (e: React.MouseEvent, c: Command) => {
    e.preventDefault();
    setSelected(c.id);
    const keys = bindings.get(c.id) ?? [];
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Add Keyboard Shortcut…', run: () => setAdding(c) },
        ...(keys.length ? [{ kind: 'sep' } as ContextItem] : []),
        ...keys.map((k) => ({ label: `Remove ${displayKeys(k)}`, run: () => onChange(setKeysIn(value, c.id, keys.filter((x) => x !== k))) })),
        { kind: 'sep' },
        { label: 'Reset Shortcuts', disabled: !(c.id in value.overrides), run: () => onChange(resetKeysIn(value, c.id)) },
      ],
    });
  };

  const importFile = async () => {
    setMessage(null);
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: 'Keymaps', extensions: ['json'] }] });
      if (typeof path !== 'string') return;
      const text = await invoke<string>('read_file', { path });
      const vscode = looksLikeVsCode(text);
      const result = vscode ? importVsCode(text) : importKeymap(text);
      onChange(result.keymap);
      const label = KEYMAPS.find((k) => k.id === result.keymap.preset)?.label ?? result.keymap.preset;
      const skipped = result.skipped.length ? ` ${result.skipped.length} ${vscode ? 'VS Code command' : 'command'}${result.skipped.length === 1 ? ' has' : 's have'} nothing to match in PHPBlitz.` : '';
      setMessage({ tone: 'info', text: `Imported ${result.applied} change${result.applied === 1 ? '' : 's'} on top of the ${label} keymap.${skipped} Apply or OK keeps them.` });
    } catch (e) {
      setMessage({ tone: 'error', text: `Could not import: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const exportFile = async () => {
    setMessage(null);
    try {
      const path = await save({ defaultPath: 'phpblitz-keymap.json', filters: [{ name: 'PHPBlitz keymap', extensions: ['json'] }] });
      if (!path) return;
      await invoke('write_file', { path, content: exportKeymap(value) });
      setMessage({ tone: 'info', text: `Exported to ${path}.` });
    } catch (e) {
      setMessage({ tone: 'error', text: `Could not export: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <>
      <div className="settings-row keymap-top">
        <label htmlFor="keymap-preset">Keymap:</label>
        <select id="keymap-preset" className="settings-select" value={value.preset} onChange={(e) => onChange({ ...value, preset: e.target.value })}>
          {KEYMAPS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn small" disabled={!isTauri} onClick={() => void importFile()} title="VS Code's keybindings.json, or a PHPBlitz keymap file">
          Import…
        </button>
        <button type="button" className="btn small" disabled={!isTauri} onClick={() => void exportFile()}>
          Export…
        </button>
        <button type="button" className="link-btn keymap-reset-all" disabled={!changed} onClick={() => onChange({ ...value, overrides: {} })}>
          Reset {changed || ''} change{changed === 1 ? '' : 's'}
        </button>
      </div>
      <p className="muted settings-help keymap-help">
        Commands this keymap doesn't set keep PHPBlitz's keys when they're free. Your changes stay on top when you switch keymaps.
      </p>
      {message && (
        <div className={'problems-banner keymap-message' + (message.tone === 'error' ? ' error' : '')}>
          <Icon name={message.tone === 'error' ? 'error' : 'info'} size={14} />
          <span className="grow">{message.text}</span>
        </div>
      )}
      <div className="settings-row keymap-search">
        <div className="field grow">
          <Icon name="search" size={14} />
          {byKeys ? (
            <input
              ref={keysInput}
              readOnly
              aria-label="Press keys to find their commands"
              placeholder="Press the keys…"
              value={rec.keys ? displayKeys(rec.keys) : ''}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !rec.keys) return;
                rec.onKeyDown(e);
              }}
            />
          ) : (
            <input aria-label="Search commands" placeholder="Search by name or keys (ctrl+shift+f)" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          )}
        </div>
        <button
          type="button"
          className={'icon-btn' + (byKeys ? ' active' : '')}
          aria-pressed={byKeys}
          aria-label="Find by pressing keys"
          title="Find by pressing keys"
          onClick={() => {
            setByKeys((b) => !b);
            rec.clear();
          }}
        >
          <Icon name="keyboard" size={15} />
        </button>
      </div>
      <div className="shortcuts-list keymap-list" role="list">
        {groups.map((g) => (
          <div key={g} className="shortcuts-group">
            <div className="shortcuts-group-title">{g}</div>
            {shown
              .filter((c) => c.group === g)
              .map((c) => {
                const keys = bindings.get(c.id) ?? [];
                const conflict = conflictOf(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="listitem"
                    className={'shortcuts-row keymap-row' + (selected === c.id ? ' selected' : '') + (c.id in value.overrides ? ' changed' : '')}
                    title={c.id in value.overrides ? 'Changed from the keymap' : undefined}
                    onClick={() => setSelected(c.id)}
                    onDoubleClick={() => setAdding(c)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), setAdding(c))}
                    onContextMenu={(e) => openMenu(e, c)}
                  >
                    <span className="grow">{c.label}</span>
                    {conflict && (
                      <span className="keymap-conflict-icon" title={conflict}>
                        <Icon name="warning" size={13} />
                      </span>
                    )}
                    <Keys keys={keys} />
                  </button>
                );
              })}
          </div>
        ))}
        {!shown.length && <div className="muted shortcuts-empty">No command matches.</div>}
      </div>
      {adding && <AddKeysDialog cmd={adding} bindings={bindings} onAdd={(keys, removeOthers) => add(adding, keys, removeOthers)} onClose={() => setAdding(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

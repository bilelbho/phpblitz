// The keys in use: the chosen keymap with the user's changes on top (Settings ▸ Keymap), kept in
// the settings. Menus ask it what to show, the dispatcher what to run. The pure functions over a
// keymap value (bindingsOf, setKeysIn…) are what Settings ▸ Keymap edits its draft with.

import { getSettings, type KeymapSettings, type Settings } from '../settings';
import { KEYMAPS, presetBindings, type Bindings, type KeymapId } from './keymaps';
import { displayKeys, normalizeKeys } from './keys';

export function presetOf(keymap: KeymapSettings): KeymapId {
  return KEYMAPS.some((k) => k.id === keymap.preset) ? (keymap.preset as KeymapId) : 'phpblitz';
}

/** Command id → keys (normalized) of a keymap value: its preset with its changes. */
export function bindingsOf(keymap: KeymapSettings): Bindings {
  const bindings: Bindings = new Map(presetBindings(presetOf(keymap)));
  for (const [id, keys] of Object.entries(keymap.overrides)) {
    const valid = keys.map((k) => normalizeKeys(k)).filter((k): k is string => !!k);
    if (valid.length) bindings.set(id, valid);
    else bindings.delete(id);
  }
  return bindings;
}

/** Keys → the commands they run, of some bindings. */
export function byKeysOf(bindings: Bindings): Map<string, string[]> {
  const byKeys = new Map<string, string[]>();
  for (const [id, keys] of bindings) for (const k of keys) byKeys.set(k, [...(byKeys.get(k) ?? []), id]);
  return byKeys;
}

/** A keymap value with a command's keys set (back to no change when they're the preset's). */
export function setKeysIn(keymap: KeymapSettings, id: string, keys: string[]): KeymapSettings {
  const preset = presetBindings(presetOf(keymap)).get(id) ?? [];
  const overrides = { ...keymap.overrides };
  const normal = [...new Set(keys.map((k) => normalizeKeys(k) ?? k))];
  if (normal.length === preset.length && normal.every((k, i) => k === preset[i])) delete overrides[id];
  else overrides[id] = normal;
  return { ...keymap, overrides };
}

/** A keymap value with a command back to its preset's keys. */
export function resetKeysIn(keymap: KeymapSettings, id: string): KeymapSettings {
  const overrides = { ...keymap.overrides };
  delete overrides[id];
  return { ...keymap, overrides };
}

let cached: { keymap: Settings['keymap']; bindings: Bindings; byKeys: Map<string, string[]> } | null = null;

function current() {
  const keymap = getSettings().keymap;
  if (cached?.keymap === keymap) return cached;
  const bindings = bindingsOf(keymap);
  cached = { keymap, bindings, byKeys: byKeysOf(bindings) };
  return cached;
}

/** A command's keys (normalized), the first one being the one menus show. */
export function keysFor(id: string): string[] {
  return current().bindings.get(id) ?? [];
}

/** The keys to show next to a command in a menu or tooltip ("Ctrl+Shift+F"), if it has any. */
export function shortcut(id: string): string | undefined {
  const k = keysFor(id)[0];
  return k ? displayKeys(k) : undefined;
}

/** A tooltip with the command's keys: "Show Context Actions (Alt+Enter)". */
export function withKeys(label: string, id: string): string {
  const k = shortcut(id);
  return k ? `${label} (${k})` : label;
}

/** The commands these keys run (normalized keys: "Ctrl+K Ctrl+C", "Double Shift"). */
export function commandsFor(keys: string): string[] {
  return current().byKeys.get(keys) ?? [];
}

/** Whether some binding starts with this stroke and goes on (a chord's first half). */
export function startsChord(stroke: string): boolean {
  for (const k of current().byKeys.keys()) if (k.startsWith(`${stroke} `) && !k.startsWith('Double ')) return true;
  return false;
}

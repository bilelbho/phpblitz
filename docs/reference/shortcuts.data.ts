// The keyboard shortcuts page's data, read from the app's own keymaps at build time
// (src/keymap): the page always lists what the app does.
import { COMMANDS } from '../../src/keymap/catalog';
import { KEYMAPS, presetBindings } from '../../src/keymap/keymaps';

export interface ShortcutRow {
  label: string;
  /** Each keymap's keys for the command (Windows and Linux spelling). */
  keys: Record<string, string[]>;
}

export interface ShortcutData {
  keymaps: { id: string; label: string }[];
  groups: { name: string; rows: ShortcutRow[] }[];
}

declare const data: ShortcutData;
export { data };

export default {
  load(): ShortcutData {
    const bindings = new Map(KEYMAPS.map((k) => [k.id, presetBindings(k.id)]));
    const groups: ShortcutData['groups'] = [];
    for (const c of COMMANDS) {
      const keys = Object.fromEntries(KEYMAPS.map((k) => [k.id, bindings.get(k.id)?.get(c.id) ?? []]));
      let group = groups.find((g) => g.name === c.group);
      if (!group) groups.push((group = { name: c.group, rows: [] }));
      group.rows.push({ label: c.label, keys });
    }
    return { keymaps: KEYMAPS.map((k) => ({ id: k.id, label: k.label })), groups };
  },
};

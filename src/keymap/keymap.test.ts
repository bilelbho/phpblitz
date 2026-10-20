import { describe, expect, it } from 'vitest';
import { normalizeKeys, parseKeys } from './keys';
import { clash, KEYMAPS, presetBindings, resolveId } from './keymaps';
import { COMMANDS } from './catalog';

describe('key strings', () => {
  it('normalizes spellings and modifier order', () => {
    expect(normalizeKeys('shift+ctrl+k')).toBe('Ctrl+Shift+K');
    expect(normalizeKeys('ctrl+k ctrl+c')).toBe('Ctrl+K Ctrl+C');
    expect(normalizeKeys('Ctrl++')).toBe('Ctrl+=');
    expect(normalizeKeys('cmd+shift+uparrow')).toBe('Ctrl+Shift+Up');
    expect(normalizeKeys('Ctrl+NumPad+')).toBe('Ctrl+NumPad+');
    expect(normalizeKeys('ctrl+shift+\\')).toBe('Ctrl+Shift+\\');
    expect(normalizeKeys('Double Ctrl Up')).toBe('Double Ctrl Up');
  });

  it('rejects what is not a key', () => {
    expect(parseKeys('Ctrl+Shift')).toBeNull();
    expect(parseKeys('Ctrl+K Ctrl+C Ctrl+D')).toBeNull();
    expect(parseKeys('Ctrl+Banana')).toBeNull();
  });

  it('sees chords clash with their first stroke', () => {
    expect(clash('Ctrl+K', 'Ctrl+K Ctrl+C')).toBe(true);
    expect(clash('Ctrl+K Ctrl+C', 'Ctrl+K Ctrl+U')).toBe(false);
    expect(clash('Ctrl+K', 'Ctrl+Shift+K')).toBe(false);
  });
});

describe('keymaps', () => {
  it('name only commands of the catalog, with valid keys', () => {
    for (const k of KEYMAPS)
      for (const [id, keys] of Object.entries(k.spec)) {
        expect(resolveId(id), `${k.id}: ${id}`).not.toBeNull();
        for (const key of Array.isArray(keys) ? keys : [keys]) expect(parseKeys(key), `${k.id}: ${id} ${key}`).not.toBeNull();
      }
  });

  it('give PHPBlitz keys to commands they leave out, unless the keys are taken', () => {
    const vscode = presetBindings('vscode');
    // VS Code's Ctrl+K is a chord prefix: Commit doesn't get it.
    expect(vscode.get('phpblitz.commit') ?? []).toEqual([]);
    expect(vscode.get('phpblitz.searchEverywhere')).toEqual(['Double Shift']);
    expect(vscode.get('editor.action.commentLine')).toEqual(['Ctrl+/']);
  });

  it('have no two commands on the same keys in the same place', () => {
    for (const k of KEYMAPS) {
      const seen = new Map<string, string>();
      for (const [id, keys] of presetBindings(k.id))
        for (const key of keys) {
          const other = seen.get(key);
          // The debugger's keys only work while it is stopped; elsewhere one command per key.
          const debugging = (x: string) => x.startsWith('phpblitz.debug');
          if (other && !debugging(other) && !debugging(id)) expect.fail(`${k.id}: ${key} is ${other} and ${id}`);
          seen.set(key, id);
        }
    }
  });

  it('cover the catalog in the PHPBlitz keymap only with known ids', () => {
    const ids = new Set(COMMANDS.map((c) => c.id));
    for (const id of presetBindings('phpblitz').keys()) expect(ids.has(id)).toBe(true);
  });
});

describe('import and export', () => {
  it('reads VS Code keybindings.json as changes on top of the VS Code keymap', async () => {
    const { importVsCode } = await import('./importExport');
    const text = `// Place your key bindings in this file
[
  { "key": "ctrl+shift+d", "command": "editor.action.copyLinesDownAction" },
  { "key": "shift+alt+down", "command": "-editor.action.copyLinesDownAction" },
  { "key": "ctrl+e", "command": "workbench.action.quickOpen", "when": "!inQuickOpen" }, // trailing comment
  { "key": "ctrl+alt+p", "command": "someExtension.doThing" },
]`;
    const r = importVsCode(text);
    expect(r.keymap.preset).toBe('vscode');
    expect(r.keymap.overrides['editor.action.copyLinesDownAction']).toEqual(['Ctrl+Shift+D']);
    expect(r.applied).toBe(3);
    expect(r.skipped).toEqual(['someExtension.doThing']);
  });

  it('round-trips a PHPBlitz keymap file', async () => {
    const { exportKeymap, importKeymap, looksLikeVsCode } = await import('./importExport');
    const keymap = { preset: 'zed', overrides: { 'phpblitz.commit': ['Ctrl+Alt+K'], 'phpblitz.push': [] } };
    const text = exportKeymap(keymap);
    expect(looksLikeVsCode(text)).toBe(false);
    expect(looksLikeVsCode('// x\n[]')).toBe(true);
    expect(importKeymap(text).keymap).toEqual(keymap);
  });
});

// Key strings (keys.ts) as Monaco keybindings: a number, or a chord of two.

import * as monaco from 'monaco-editor';
import { parseKeys, type Stroke } from './keys';

const KEY_CODES: Record<string, monaco.KeyCode> = (() => {
  const K = monaco.KeyCode;
  const map: Record<string, monaco.KeyCode> = {
    Enter: K.Enter, Escape: K.Escape, Tab: K.Tab, Space: K.Space, Backspace: K.Backspace, Delete: K.Delete, Insert: K.Insert,
    Home: K.Home, End: K.End, PageUp: K.PageUp, PageDown: K.PageDown, Up: K.UpArrow, Down: K.DownArrow, Left: K.LeftArrow, Right: K.RightArrow,
    '=': K.Equal, '-': K.Minus, '[': K.BracketLeft, ']': K.BracketRight, '\\': K.Backslash, '/': K.Slash, ';': K.Semicolon,
    "'": K.Quote, ',': K.Comma, '.': K.Period, '`': K.Backquote,
    'NumPad+': K.NumpadAdd, 'NumPad-': K.NumpadSubtract, 'NumPad*': K.NumpadMultiply, 'NumPad/': K.NumpadDivide,
  };
  for (let i = 0; i < 26; i++) map[String.fromCharCode(65 + i)] = K.KeyA + i;
  for (let i = 0; i < 10; i++) {
    map[String(i)] = K.Digit0 + i;
    map[`NumPad${i}`] = K.Numpad0 + i;
  }
  for (let i = 1; i <= 19; i++) map[`F${i}`] = K.F1 + i - 1;
  return map;
})();

function strokeToMonaco(s: Stroke): number | null {
  const code = KEY_CODES[s.key];
  if (code === undefined) return null;
  let k: number = code;
  if (s.mods.has('Ctrl')) k |= monaco.KeyMod.CtrlCmd;
  if (s.mods.has('Shift')) k |= monaco.KeyMod.Shift;
  if (s.mods.has('Alt')) k |= monaco.KeyMod.Alt;
  if (s.mods.has('Meta')) k |= monaco.KeyMod.WinCtrl;
  return k;
}

/** A key string as a Monaco keybinding (chords too); `null` for gestures and unknown keys. */
export function toMonaco(text: string): number | null {
  const p = parseKeys(text);
  if (!p || p.kind !== 'strokes') return null;
  const [a, b] = p.strokes.map(strokeToMonaco);
  if (a === null || a === undefined) return null;
  if (p.strokes.length === 1) return a;
  return b === null || b === undefined ? null : monaco.KeyMod.chord(a, b);
}

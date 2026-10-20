// Key strings, the way keymaps and Settings write them: "Ctrl+Shift+K", a two-stroke chord
// "Ctrl+K Ctrl+C", and the gestures "Double Shift" / "Double Ctrl". "Ctrl" is Cmd on macOS (like
// Monaco's CtrlCmd); "Meta" is the real Ctrl key there. Read from keyboard events and shown in menus;
// monacoKeys.ts turns them into Monaco keybindings. No Monaco here: menus use this at startup.

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = (typeof MODIFIERS)[number];

export interface Stroke {
  mods: Set<Modifier>;
  key: string;
}

/** Every key name a key string can use. */
export const KEY_NAMES: readonly string[] = [
  'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right',
  '=', '-', '[', ']', '\\', '/', ';', "'", ',', '.', '`', 'NumPad+', 'NumPad-', 'NumPad*', 'NumPad/',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ...Array.from({ length: 10 }, (_, i) => `NumPad${i}`),
  ...Array.from({ length: 19 }, (_, i) => `F${i + 1}`),
];

/** Other spellings people use (VS Code's keybindings.json, older lists) → our names. */
const ALIASES: Record<string, string> = {
  esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown', pageup: 'PageUp',
  uparrow: 'Up', downarrow: 'Down', leftarrow: 'Left', rightarrow: 'Right', plus: '=', equal: '=', minus: '-', backquote: '`',
  numpad_add: 'NumPad+', numpad_subtract: 'NumPad-', numpad_multiply: 'NumPad*', numpad_divide: 'NumPad/',
  cmd: 'Ctrl', command: 'Ctrl', control: 'Ctrl', option: 'Alt', win: 'Meta', super: 'Meta',
};

function canonicalKey(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const alias = ALIASES[t.toLowerCase()];
  if (alias) return alias;
  const mod = MODIFIERS.find((m) => m.toLowerCase() === t.toLowerCase());
  if (mod) return mod;
  if (t.length === 1) return /[a-z]/i.test(t) ? t.toUpperCase() : t;
  const m = t.match(/^numpad[_ ]?(\d)$/i);
  if (m) return `NumPad${m[1]}`;
  const found = KEY_NAMES.find((k) => k.toLowerCase() === t.toLowerCase());
  return found ?? null;
}

/** "Ctrl+Shift+K" → a stroke; `null` when it isn't one. */
export function parseStroke(text: string): Stroke | null {
  // "Ctrl++" (the plus key) and "Ctrl+=" both mean the = / + key; "NumPad+" is one key name.
  const parts = text.replace(/numpad\s*\+/gi, 'numpad_add').replace(/\+\+$/, '+=').split('+');
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const part of parts) {
    const p = canonicalKey(part);
    if (!p) return null;
    if ((MODIFIERS as readonly string[]).includes(p)) mods.add(p as Modifier);
    else if (key) return null;
    else key = p;
  }
  return key ? { mods, key } : null;
}

/** A key string: one or two strokes (a chord), or a gesture. */
export type ParsedKeys = { kind: 'strokes'; strokes: Stroke[] } | { kind: 'gesture'; name: 'Double Shift' | 'Double Ctrl'; then?: Stroke };

export function parseKeys(text: string): ParsedKeys | null {
  const t = text.trim();
  const gesture = t.match(/^Double (Shift|Ctrl)(?:\s+(.+))?$/i);
  if (gesture) {
    const then = gesture[2] ? parseStroke(gesture[2]) : undefined;
    if (gesture[2] && !then) return null;
    return { kind: 'gesture', name: gesture[1].toLowerCase() === 'shift' ? 'Double Shift' : 'Double Ctrl', then: then ?? undefined };
  }
  const strokes = t.split(/\s+/).map(parseStroke);
  if (!strokes.length || strokes.length > 2 || strokes.some((s) => !s)) return null;
  return { kind: 'strokes', strokes: strokes as Stroke[] };
}

export function formatStroke(s: Stroke): string {
  return [...MODIFIERS.filter((m) => s.mods.has(m)), s.key].join('+');
}

/** The canonical spelling (for comparing keys and spotting conflicts). */
export function normalizeKeys(text: string): string | null {
  const p = parseKeys(text);
  if (!p) return null;
  if (p.kind === 'gesture') return p.then ? `${p.name} ${formatStroke(p.then)}` : p.name;
  return p.strokes.map(formatStroke).join(' ');
}

/** How a key string is shown: Cmd/Option on macOS. */
export function displayKeys(text: string): string {
  const n = normalizeKeys(text) ?? text;
  return isMac ? n.replace(/\bCtrl\b/g, 'Cmd').replace(/\bMeta\b/g, 'Ctrl').replace(/\bAlt\b/g, 'Option') : n.replace(/\bMeta\b/g, 'Win');
}

/** `KeyboardEvent.code` → our key name. */
const CODE_KEYS: Record<string, string> = {
  Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Backquote: '`',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', NumpadAdd: 'NumPad+', NumpadSubtract: 'NumPad-', NumpadMultiply: 'NumPad*', NumpadDivide: 'NumPad/',
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

/** The stroke a key event is (`null` for a modifier alone). */
export function strokeOf(e: KeyboardEvent): Stroke | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = `NumPad${e.code.slice(6)}`;
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code] ?? null;
  if (!key) return null;
  const mods = new Set<Modifier>();
  if (isMac ? e.metaKey : e.ctrlKey) mods.add('Ctrl');
  if (isMac && e.ctrlKey) mods.add('Meta');
  if (!isMac && e.metaKey) mods.add('Meta');
  if (e.altKey) mods.add('Alt');
  if (e.shiftKey) mods.add('Shift');
  return { mods, key };
}

export function sameStroke(a: Stroke, b: Stroke): boolean {
  return a.key === b.key && a.mods.size === b.mods.size && [...a.mods].every((m) => b.mods.has(m));
}

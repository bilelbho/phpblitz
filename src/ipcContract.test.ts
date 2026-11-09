// The UI calls Rust commands by name, with their arguments as an object: nothing checks those
// against the Rust side when either changes. This test reads both: every `invoke('name', { … })`
// in src/ must name a registered command, pass only arguments it has, and every argument it
// requires (anything not an Option, nor given by Tauri itself like State or AppHandle).

import { describe, expect, it } from 'vitest';

const rustFiles = import.meta.glob('../src-tauri/src/*.rs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const uiFiles = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Parameter types Tauri fills in itself: not passed from the UI. */
const INJECTED = /^(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow|Webview)\b/;

type Param = { name: string; required: boolean };

/** Skips a string, template or comment starting at `i`; returns the index after it, or `i`. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end < 0 ? src.length : end;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (c === "'" || c === '"' || c === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === c) return j + 1;
    }
    return src.length;
  }
  return i;
}

/** Splits `src[open+1 .. matching close)` at top-level commas; returns the parts and the close index. */
function splitGroup(src: string, open: number, angles = false): { parts: string[]; end: number } {
  const opening = angles ? '([{<' : '([{';
  const closing = angles ? ')]}>' : ')]}';
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    const skipped = angles ? i : skipLiteral(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const c = src[i];
    if (angles && c === '>' && src[i - 1] === '-') continue; // `->`
    if (opening.includes(c)) depth++;
    else if (closing.includes(c)) {
      if (depth === 0) {
        parts.push(src.slice(start, i));
        return { parts: parts.map((p) => p.trim()).filter(Boolean), end: i };
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  throw new Error('unbalanced group');
}

const camel = (snake: string) => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `#[tauri::command] fn` signatures in the Rust sources, by name. */
function rustCommands(): Map<string, Param[]> {
  const commands = new Map<string, Param[]>();
  for (const src of Object.values(rustFiles)) {
    for (const m of src.matchAll(/#\[tauri::command[^\]]*\](?:\s*#\[[^\]]*\](?:[^\n]*))*\s*pub\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(/g)) {
      const open = m.index + m[0].length - 1;
      const { parts } = splitGroup(src, open, true);
      const params = parts.map((p) => {
        const colon = p.indexOf(':');
        return { name: p.slice(0, colon).replace(/^mut\s+/, '').trim(), type: p.slice(colon + 1).trim() };
      });
      commands.set(
        m[1],
        params.filter((p) => !INJECTED.test(p.type)).map((p) => ({ name: camel(p.name), required: !/^Option\s*</.test(p.type) })),
      );
    }
  }
  return commands;
}

/** The names in lib.rs's `generate_handler![…]`. */
function registered(): Set<string> {
  const lib = Object.entries(rustFiles).find(([path]) => path.endsWith('/lib.rs'))![1];
  const list = /generate_handler!\[([\s\S]*?)\]/.exec(lib)![1];
  return new Set(list.split(',').map((s) => s.trim().split('::').pop()!).filter(Boolean));
}

type Call = { file: string; line: number; command: string; keys: string[] | null };

/** Every `invoke('name', …)` in the UI, with its argument keys when they are a plain object literal. */
function uiCalls(): Call[] {
  const calls: Call[] = [];
  for (const [file, src] of Object.entries(uiFiles)) {
    for (const m of src.matchAll(/\binvoke\b/g)) {
      let i = m.index + m[0].length;
      if (src[i] === '<') i = splitGroup(src, i, true).end + 1; // invoke<T>(…)
      if (src[i] !== '(') continue;
      const { parts } = splitGroup(src, i);
      const name = /^'([^']*)'$/.exec(parts[0] ?? '');
      if (!name) continue; // a variable: checked where its values are written
      const args = parts[1];
      let keys: string[] | null = [];
      if (args !== undefined) {
        if (!args.startsWith('{')) keys = null;
        else {
          const entries = splitGroup(args, 0).parts;
          keys = entries.some((e) => e.startsWith('...')) ? null : entries.map((e) => /^['"]?(\w+)/.exec(e)![1]);
        }
      }
      calls.push({ file: file.replace(/^\.\//, 'src/'), line: src.slice(0, m.index).split('\n').length, command: name[1], keys });
    }
  }
  return calls;
}

describe('UI ↔ Rust commands', () => {
  const commands = rustCommands();
  const names = registered();
  const calls = uiCalls();

  it('finds the calls and the commands', () => {
    expect(calls.length).toBeGreaterThan(100);
    expect(names.size).toBeGreaterThan(80);
  });

  it('registers only commands that exist', () => {
    expect([...names].filter((n) => !commands.has(n))).toEqual([]);
  });

  it('calls only registered commands', () => {
    const unknown = calls.filter((c) => !names.has(c.command)).map((c) => `${c.file}:${c.line} ${c.command}`);
    expect(unknown).toEqual([]);
  });

  it('passes the arguments each command takes', () => {
    const problems: string[] = [];
    for (const call of calls) {
      const params = commands.get(call.command);
      if (!params || call.keys === null) continue;
      const known = new Set(params.map((p) => p.name));
      for (const key of call.keys) if (!known.has(key)) problems.push(`${call.file}:${call.line} ${call.command}: no argument "${key}"`);
      for (const p of params) if (p.required && !call.keys.includes(p.name)) problems.push(`${call.file}:${call.line} ${call.command}: "${p.name}" missing`);
    }
    expect(problems).toEqual([]);
  });
});

// Turns key presses into commands of the active keymap: single keys, two-stroke chords
// ("Ctrl+K Ctrl+C"), Double Shift, and Double Ctrl held with a key (Double Ctrl Up). In a code
// editor it listens before Monaco, so the keymap wins over Monaco's own keys; elsewhere after the
// focused element, so popups and fields keep the keys they handle themselves.

import { command } from './catalog';
import { focusedEditor, runCommand, type KeyEditor } from './commands';
import { formatStroke, isMac, strokeOf, type Stroke } from './keys';
import { commandsFor, startsChord } from './store';

/** Two taps of a modifier count as one gesture within this time. */
const DOUBLE_MS = 350;
/** The second half of a chord must follow within this time. */
const CHORD_MS = 3000;

/** Keys that open suggestion lists and parameter hints keep for themselves. */
const WIDGET_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Up', 'Down', 'PageUp', 'PageDown']);

const chordListeners = new Set<(first: string | null) => void>();

/** The status bar shows the first half of a chord while the second is awaited. */
export function onChord(fn: (first: string | null) => void): () => void {
  chordListeners.add(fn);
  return () => chordListeners.delete(fn);
}

export interface DispatchOptions {
  /** Keys typed in the terminal go to the shell (Settings ▸ Tools ▸ Terminal). */
  forShell: (e: KeyboardEvent) => boolean;
}

function editableTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Keys that type text or move in a field (no Ctrl/Alt/Meta, not a function key). */
function typingKey(s: Stroke): boolean {
  return !s.mods.has('Ctrl') && !s.mods.has('Alt') && !s.mods.has('Meta') && !/^F\d+$/.test(s.key);
}

/**
 * A key bound to a command that runs in the terminal too (Zoom, Settings, F6…): the terminal lets
 * it through to the dispatcher instead of sending it to the shell (which would also mark it handled).
 */
export function runsInTerminal(e: KeyboardEvent): boolean {
  const stroke = strokeOf(e);
  return !!stroke && commandsFor(formatStroke(stroke)).some((id) => command(id)?.always);
}

/** Installs the dispatcher on the window; returns its removal. */
export function installDispatcher({ forShell }: DispatchOptions): () => void {
  let chord: { first: string; at: number } | null = null;
  let chordTimer = 0;
  const setChord = (next: typeof chord) => {
    chord = next;
    window.clearTimeout(chordTimer);
    // Nothing followed: the chord is over (and the status bar says so).
    if (next) chordTimer = window.setTimeout(() => setChord(null), CHORD_MS);
    chordListeners.forEach((l) => l(next?.first ?? null));
  };
  // Double Shift / Double Ctrl: the last clean tap (pressed and released alone), and whether Ctrl is
  // held down after a tap.
  const ctrlKey = isMac ? 'Meta' : 'Control';
  let lastTap = { key: '', at: 0 };
  let alone = false;
  let doubleCtrlHeld = false;

  const tryRun = (ids: string[], e: KeyboardEvent, editor: KeyEditor | null, plain: boolean): boolean => {
    for (const id of ids) {
      const c = command(id);
      if (!c) continue;
      if (forShell(e) && !c.always) continue;
      // In a field (search boxes, dialogs) plain keys are typing.
      if (plain && !editor && editableTarget(e)) continue;
      if (runCommand(id, editor)) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
    }
    return false;
  };

  const handle = (e: KeyboardEvent, inEditorPhase: boolean) => {
    const editor = focusedEditor();
    const inEditor = !!editor?.hasTextFocus();
    // Each key press is handled once: before Monaco in an editor, after the target elsewhere.
    if (inEditor !== inEditorPhase) return;
    const stroke = strokeOf(e);
    if (!stroke) return;
    const s = formatStroke(stroke);
    const ed = inEditor ? editor : null;
    if (ed?.reserves(s)) return;

    if (chord) {
      const first = chord.first;
      const fresh = Date.now() - chord.at < CHORD_MS;
      setChord(null);
      if (fresh) {
        tryRun(commandsFor(`${first} ${s}`), e, ed, false);
        // A chord that leads nowhere still ends here (its second key doesn't also type).
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (ed?.widgetOpen() && WIDGET_KEYS.has(stroke.key)) return;
    if (doubleCtrlHeld && stroke.mods.has('Ctrl')) {
      const rest: Stroke = { key: stroke.key, mods: new Set([...stroke.mods].filter((m) => m !== 'Ctrl')) };
      if (tryRun(commandsFor(`Double Ctrl ${formatStroke(rest)}`), e, ed, false)) return;
    }
    const plain = typingKey(stroke);
    if (tryRun(commandsFor(s), e, ed, plain)) return;
    if (!plain && startsChord(s) && !forShell(e)) {
      setChord({ first: s, at: Date.now() });
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const capture = (e: KeyboardEvent) => {
    if (e.key === 'Shift' || e.key === ctrlKey) {
      if (e.repeat) return;
      alone = true;
      if (e.key === ctrlKey && lastTap.key === ctrlKey && Date.now() - lastTap.at < DOUBLE_MS) doubleCtrlHeld = true;
      return;
    }
    alone = false;
    handle(e, true);
  };
  const bubble = (e: KeyboardEvent) => {
    if (e.key === 'Shift' || e.key === ctrlKey || e.defaultPrevented) return;
    handle(e, false);
  };
  const up = (e: KeyboardEvent) => {
    if (e.key === ctrlKey) doubleCtrlHeld = false;
    if (e.key !== 'Shift' && e.key !== ctrlKey) return;
    const now = Date.now();
    if (!alone) {
      lastTap = { key: '', at: 0 };
      return;
    }
    alone = false;
    if (lastTap.key === e.key && now - lastTap.at < DOUBLE_MS) {
      lastTap = { key: '', at: 0 };
      if (e.key === 'Shift') {
        const editor = focusedEditor();
        tryRun(commandsFor('Double Shift'), e, editor?.hasTextFocus() ? editor : null, false);
      } else {
        tryRun(commandsFor('Double Ctrl'), e, null, false);
      }
    } else {
      lastTap = { key: e.key, at: now };
    }
  };
  const blur = () => {
    doubleCtrlHeld = false;
    lastTap = { key: '', at: 0 };
  };

  window.addEventListener('keydown', capture, true);
  // On the document: after the focused element's own handlers, before the window's (nativeFeel.ts
  // cancels browser shortcuts there, which isn't a field having handled the key).
  document.addEventListener('keydown', bubble);
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', blur);
  return () => {
    window.clearTimeout(chordTimer);
    window.removeEventListener('keydown', capture, true);
    document.removeEventListener('keydown', bubble);
    window.removeEventListener('keyup', up, true);
    window.removeEventListener('blur', blur);
  };
}

// A small W3C WebDriver client on Node's fetch: what the smoke tests need, nothing more.
// tauri-driver (https://v2.tauri.app/develop/tests/webdriver/) speaks this protocol and starts
// the app through the platform's driver (msedgedriver on Windows, WebKitWebDriver on Linux).

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

/** WebDriver key codes for the keys used in chords like "Ctrl+Shift+K". */
const KEYS = {
  ctrl: '',
  shift: '',
  alt: '',
  meta: '',
  enter: '',
  escape: '',
  tab: '',
  backspace: '',
  end: '',
  home: '',
  up: '',
  down: '',
  left: '',
  right: '',
  f12: '',
};
const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'meta']);

export class WebDriver {
  constructor(base) {
    this.base = base;
    this.session = null;
  }

  async cmd(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const v = json.value ?? {};
      const error = new Error(`${method} ${path}: ${v.error ?? res.status} ${v.message ?? ''}`.slice(0, 600));
      error.code = v.error;
      throw error;
    }
    return json.value;
  }

  s(path) {
    return `/session/${this.session}${path}`;
  }

  async start(capabilities) {
    const value = await this.cmd('POST', '/session', { capabilities: { alwaysMatch: capabilities } });
    this.session = value.sessionId;
  }

  async quit() {
    if (this.session) await this.cmd('DELETE', `/session/${this.session}`).catch(() => {});
    this.session = null;
  }

  /** Runs `body` (a function body; `arguments` holds `args`) in the page; promises are awaited. */
  exec(body, ...args) {
    return this.cmd('POST', this.s('/execute/sync'), { script: body, args });
  }

  /** The first element matching a CSS selector, or null. */
  async find(css) {
    try {
      const v = await this.cmd('POST', this.s('/element'), { using: 'css selector', value: css });
      return v[ELEMENT];
    } catch (e) {
      if (e.code === 'no such element') return null;
      throw e;
    }
  }

  /** An element returned by `exec` as a WebDriver reference. */
  static ref(value) {
    const id = value && typeof value === 'object' ? value[ELEMENT] : undefined;
    if (!id) throw new Error(`not an element: ${JSON.stringify(value)?.slice(0, 200)}`);
    return id;
  }

  click(id) {
    return this.cmd('POST', this.s(`/element/${id}/click`), {});
  }

  actions(actions) {
    return this.cmd('POST', this.s('/actions'), { actions }).finally(() => this.cmd('DELETE', this.s('/actions')).catch(() => {}));
  }

  /** Presses a chord such as "Ctrl+Shift+K", "Escape" or "a". */
  press(chord) {
    const parts = chord.split('+').map((p) => p.trim());
    const key = parts.pop();
    const mods = parts.map((m) => KEYS[m.toLowerCase()]);
    // A letter goes lowercase: an uppercase one makes the driver add Shift (Ctrl+N → Ctrl+Shift+N).
    const main = KEYS[key.toLowerCase()] ?? (key.length === 1 ? key.toLowerCase() : key);
    const down = [...mods, main].map((value) => ({ type: 'keyDown', value }));
    const up = [main, ...mods.reverse()].map((value) => ({ type: 'keyUp', value }));
    return this.actions([{ type: 'key', id: 'keyboard', actions: [...down, ...up] }]);
  }

  /** Shift pressed twice (Search Everywhere). */
  doubleShift() {
    const tap = [
      { type: 'keyDown', value: KEYS.shift },
      { type: 'keyUp', value: KEYS.shift },
    ];
    return this.actions([{ type: 'key', id: 'keyboard', actions: [...tap, { type: 'pause', duration: 80 }, ...tap] }]);
  }

  /** Types text into whatever has the focus. */
  type(text) {
    const actions = [];
    for (const ch of text) actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
    return this.actions([{ type: 'key', id: 'keyboard', actions }]);
  }

  /** A real mouse click on an element (its center, or `x`,`y` from its center). */
  pointerClick(id, x = 0, y = 0) {
    return this.actions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: { [ELEMENT]: id }, x, y, duration: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  }

  setWindowRect(rect) {
    return this.cmd('POST', this.s('/window/rect'), rect);
  }

  screenshot() {
    return this.cmd('GET', this.s('/screenshot'));
  }
}

export { KEYS, MODIFIERS };

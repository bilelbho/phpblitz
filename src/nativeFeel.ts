// Makes the window behave like a desktop app rather than a web page: no browser context menu
// (Back / Refresh / Save as / Print), no reload / print / find-in-page / history shortcuts, no
// spell-check squiggles or autofill in fields, no page zoom, rubber-band scrolling or autoscroll.
// The app's own handlers still receive these events: only the browser's default action is cancelled.

const isWindows = navigator.userAgent.includes('Windows');

/** Text fields where the browser's own Cut / Copy / Paste menu is still the right thing. */
function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest('.monaco-editor, .xterm')) return false; // they have their own menus
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type)) || el.isContentEditable;
}

/** Browser shortcuts that make no sense in an IDE (the app may still bind some of them itself). */
function isBrowserShortcut(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (k === 'f5' || k === 'f7' || k === 'browserback' || k === 'browserforward' || k === 'browserrefresh') return true;
  if (e.altKey && !ctrl && (k === 'arrowleft' || k === 'arrowright') && !isTextField(e.target)) return true; // back / forward
  if (!ctrl) return false;
  // Reload, print, save page, find in page, history, downloads, view source, page zoom.
  if (['r', 'p', 's', 'f', 'g', 'h', 'j', 'u', 'o', 'n', 't', 'w', '=', '+', '-', '0'].includes(k) && !e.altKey) return true;
  if (e.shiftKey && ['i', 'j', 'c', 'delete'].includes(k)) return true; // developer tools, clear data
  return false;
}

export function installNativeFeel() {
  // Inherited by every field: no red spell-check squiggles.
  document.documentElement.spellcheck = false;

  window.addEventListener(
    'contextmenu',
    (e) => {
      // Our menus call preventDefault themselves; this catches everywhere else.
      if (!isTextField(e.target)) e.preventDefault();
    },
    true,
  );

  // Bubble phase: the app's shortcut handlers run first, then the browser's action is cancelled.
  window.addEventListener('keydown', (e) => {
    if (isBrowserShortcut(e)) e.preventDefault();
  });

  // Enter in a popup (Go to Line, Search Everywhere, a list) that opens a place and focuses the
  // editor: the key's newline would follow the focus and land in the code. An Enter that started
  // outside an editor types nothing into one.
  let enterFromOutside = false;
  window.addEventListener(
    'keydown',
    (e) => {
      enterFromOutside = e.key === 'Enter' && !(e.target instanceof Element && e.target.closest('.monaco-editor'));
      if (enterFromOutside) window.setTimeout(() => (enterFromOutside = false));
    },
    true,
  );
  const swallowStrayEnter = (e: Event) => {
    if (enterFromOutside && e.target instanceof Element && e.target.closest('.monaco-editor')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('keypress', swallowStrayEnter, true);
  window.addEventListener('beforeinput', swallowStrayEnter, true);

  // No autofill suggestions popping up under the IDE's fields.
  window.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (el instanceof HTMLInputElement && !el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
    },
    true,
  );

  // Ctrl+wheel / pinch would zoom the whole page (UI zoom lives in Settings ▸ Appearance).
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );

  // Windows: middle click starts the browser's autoscroll. (Linux keeps it: it pastes the selection.)
  if (isWindows) {
    window.addEventListener(
      'mousedown',
      (e) => {
        if (e.button === 1 && !(e.target instanceof HTMLElement && e.target.closest('.xterm'))) e.preventDefault();
      },
      true,
    );
  }

  // Dropping a file anywhere would navigate the window to it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

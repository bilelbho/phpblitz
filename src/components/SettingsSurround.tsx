// Settings ▸ Editor ▸ Surround With: which built-in templates Surround With offers, and the user's own
// (the format is in editor/surround.ts).

import type { EditorSettings } from '../settings';
import { BUILTIN_SURROUND } from '../editor/surround';
import { Icon } from './Icon';
import { shortcut } from '../keymap/store';

type Value = Pick<EditorSettings, 'surroundTemplates' | 'surroundHidden'>;

const NEW_TEMPLATE = { label: '', body: 'if (!$CONDITION$) {\n    $SELECTION$\n}' };

export function SurroundPage({ value, onChange }: { value: Value; onChange: (patch: Partial<Value>) => void }) {
  const hidden = new Set(value.surroundHidden);
  const custom = value.surroundTemplates;
  const setCustom = (i: number, patch: Partial<Value['surroundTemplates'][number]>) => onChange({ surroundTemplates: custom.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <>
      <p className="muted settings-help surround-help">
        {shortcut('phpblitz.surroundWith') ? `${shortcut('phpblitz.surroundWith')} (Code ▸ Surround With)` : 'Code ▸ Surround With'} wraps the selected lines, or the caret line, in a template. In a template, <code>$SELECTION$</code> is the selected code, <code>$NAME$</code> or{' '}
        <code>$NAME:default$</code> a field to fill in (Tab goes to the next one; the same name twice is the same field), and <code>$END$</code> where the caret ends up. PHP variables like{' '}
        <code>$item</code> stay as they are. Indent with 4 spaces: it becomes the editor's indentation.
      </p>

      <h3 className="settings-section">Built-in templates</h3>
      <div className="surround-builtins">
        {BUILTIN_SURROUND.map((t) => (
          <label key={t.label} className="settings-check surround-builtin" title={t.body}>
            <input
              type="checkbox"
              className="checkbox"
              checked={!hidden.has(t.label)}
              onChange={(e) => onChange({ surroundHidden: e.target.checked ? value.surroundHidden.filter((l) => l !== t.label) : [...value.surroundHidden, t.label] })}
            />
            <span className="surround-label">{t.label}</span>
            <span className="muted mono surround-preview">{t.body.split('\n')[0]}</span>
          </label>
        ))}
      </div>

      <h3 className="settings-section">Your templates</h3>
      {!custom.length && <div className="muted">None yet. They come after the built-in ones in the popup.</div>}
      {custom.map((t, i) => (
        <div key={i} className="surround-custom">
          <div className="surround-custom-head">
            <div className="field">
              <input value={t.label} placeholder="Name in the popup" aria-label="Template name" spellCheck={false} onChange={(e) => setCustom(i, { label: e.target.value })} />
            </div>
            <button type="button" className="icon-btn small" aria-label={`Remove ${t.label || 'template'}`} title="Remove" onClick={() => onChange({ surroundTemplates: custom.filter((_, j) => j !== i) })}>
              <Icon name="close" size={10} />
            </button>
          </div>
          <textarea
            className="surround-body mono"
            value={t.body}
            rows={Math.max(3, t.body.split('\n').length)}
            spellCheck={false}
            aria-label="Template"
            onChange={(e) => setCustom(i, { body: e.target.value })}
            onKeyDown={(e) => {
              // Tab indents in the template instead of leaving the box.
              if (e.key !== 'Tab' || e.shiftKey) return;
              e.preventDefault();
              const el = e.currentTarget;
              const at = el.selectionStart;
              setCustom(i, { body: `${t.body.slice(0, at)}    ${t.body.slice(el.selectionEnd)}` });
              requestAnimationFrame(() => el.setSelectionRange(at + 4, at + 4));
            }}
          />
          {!t.body.includes('$SELECTION$') && <div className="error-text surround-warning">Needs $SELECTION$ somewhere: until then it isn't offered.</div>}
          {!t.label.trim() && t.body.includes('$SELECTION$') && <div className="error-text surround-warning">Needs a name to be offered.</div>}
        </div>
      ))}
      <button type="button" className="btn small surround-add" onClick={() => onChange({ surroundTemplates: [...custom, NEW_TEMPLATE] })}>
        Add Template
      </button>
    </>
  );
}

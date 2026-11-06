// Settings ▸ Editor ▸ Live Templates: the built-in PHP templates (on or off), the user's own,
// postfix completion and Emmet (the formats are in editor/templates.ts and editor/emmet.ts).

import type { EditorSettings } from '../settings';
import { BUILTIN_LIVE, BUILTIN_POSTFIX } from '../editor/templates';
import { Icon } from './Icon';

type Value = Pick<EditorSettings, 'liveTemplates' | 'liveHidden' | 'postfixTemplates' | 'emmet'>;

const NEW_TEMPLATE = { abbr: '', description: '', body: 'public function $NAME$(): $TYPE:void$\n{\n    $END$\n}' };

export function LiveTemplatesPage({ value, onChange }: { value: Value; onChange: (patch: Partial<Value>) => void }) {
  const hidden = new Set(value.liveHidden);
  const custom = value.liveTemplates;
  const setCustom = (i: number, patch: Partial<Value['liveTemplates'][number]>) => onChange({ liveTemplates: custom.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <>
      <p className="muted settings-help surround-help">
        In PHP code, type a template's abbreviation and press Tab (or pick it in the completion list). In a template, <code>$NAME$</code> or <code>$NAME:default$</code> is a field to fill in
        (Tab goes to the next one; the same name twice is the same field) and <code>$END$</code> is where the caret ends up. PHP variables are written <code>$$NAME$</code> for a field, or as they
        are (<code>$item</code>). Indent with 4 spaces: it becomes the editor's indentation.
      </p>

      <h3 className="settings-section">Built-in templates</h3>
      <div className="surround-builtins">
        {BUILTIN_LIVE.map((t) => (
          <label key={t.abbr} className="settings-check surround-builtin" title={t.body}>
            <input
              type="checkbox"
              className="checkbox"
              checked={!hidden.has(t.abbr)}
              onChange={(e) => onChange({ liveHidden: e.target.checked ? value.liveHidden.filter((a) => a !== t.abbr) : [...value.liveHidden, t.abbr] })}
            />
            <span className="surround-label mono">{t.abbr}</span>
            <span className="muted surround-preview">{t.description}</span>
          </label>
        ))}
      </div>

      <h3 className="settings-section">Your templates</h3>
      {!custom.length && <div className="muted">None yet. One with the abbreviation of a built-in template replaces it.</div>}
      {custom.map((t, i) => (
        <div key={i} className="surround-custom">
          <div className="surround-custom-head">
            <div className="field live-abbr">
              <input className="mono" value={t.abbr} placeholder="Abbreviation" aria-label="Abbreviation" spellCheck={false} onChange={(e) => setCustom(i, { abbr: e.target.value.trim() })} />
            </div>
            <div className="field">
              <input value={t.description} placeholder="Description" aria-label="Description" onChange={(e) => setCustom(i, { description: e.target.value })} />
            </div>
            <button type="button" className="icon-btn small" aria-label={`Remove ${t.abbr || 'template'}`} title="Remove" onClick={() => onChange({ liveTemplates: custom.filter((_, j) => j !== i) })}>
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
          {t.abbr && !/^[\w-]+$/.test(t.abbr) && <div className="error-text surround-warning">The abbreviation can only have letters, digits, _ and -.</div>}
          {!t.abbr && <div className="error-text surround-warning">Needs an abbreviation to be offered.</div>}
        </div>
      ))}
      <button type="button" className="btn small surround-add" onClick={() => onChange({ liveTemplates: [...custom, NEW_TEMPLATE] })}>
        Add Template
      </button>

      <h3 className="settings-section">Postfix completion</h3>
      <label className="settings-check">
        <input type="checkbox" className="checkbox" checked={value.postfixTemplates} onChange={(e) => onChange({ postfixTemplates: e.target.checked })} />
        <span>
          After an expression, <code>.key</code> and Tab turn it into code: <code>$items.fore</code> → <code>foreach ($items as $item)</code>
        </span>
      </label>
      <div className="muted live-postfix">{BUILTIN_POSTFIX.map((t) => `.${t.key}`).join('  ')}</div>

      <h3 className="settings-section">Emmet</h3>
      <label className="settings-check">
        <input type="checkbox" className="checkbox" checked={value.emmet} onChange={(e) => onChange({ emmet: e.target.checked })} />
        <span>
          In HTML, Blade, Twig and the HTML of PHP files, Tab expands abbreviations: <code>ul&gt;li.item*3</code>, <code>div.card&gt;h2{'{Title}'}+p</code>, <code>!</code> for a page
        </span>
      </label>
    </>
  );
}

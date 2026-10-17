// Settings pages: Appearance & Behavior ▸ Appearance, and Editor ▸ General ▸ Editor Tabs.

import type { ReactNode } from 'react';
import type { TabSettings, UiSettings, UiTheme } from '../settings';
import { MAX_ZOOM, MIN_ZOOM } from '../uiSettings';

// Our own names (the ids are kept so saved settings still match).
const THEMES: { id: UiTheme; label: string }[] = [
  { id: 'islands-dark', label: 'Blitz Dark' },
  { id: 'islands-light', label: 'Blitz Light' },
  { id: 'islands-darcula', label: 'Blitz Classic' },
  { id: 'high-contrast', label: 'High Contrast' },
];

function Check({ label, checked, onChange, help, disabled, hit }: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: ReactNode; disabled?: boolean; hit: (l: string) => string }) {
  return (
    <div className="settings-option">
      <label className={'settings-check' + hit(label)}>
        <input type="checkbox" className="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {help && <div className="muted settings-help">{help}</div>}
    </div>
  );
}

function Radio<T extends string>({ name, value, options, onChange, hit }: { name: string; value: T; options: { id: T; label: string; help?: string }[]; onChange: (v: T) => void; hit: (l: string) => string }) {
  return (
    <div className="settings-radios" role="radiogroup">
      {options.map((o) => (
        <div key={o.id} className="settings-option">
          <label className={'settings-radio' + hit(o.label)}>
            <input type="radio" name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
            {o.label}
          </label>
          {o.help && <div className="muted settings-help">{o.help}</div>}
        </div>
      ))}
    </div>
  );
}

function Select<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select id={id} className="settings-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const hitter = (highlight: string) => (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');

export function AppearancePage({ value: ui, onChange, highlight, onEditorScheme }: { value: UiSettings; onChange: (patch: Partial<UiSettings>) => void; highlight: string; onEditorScheme: () => void }) {
  const hit = hitter(highlight);
  return (
    <>
      <div className="settings-grid" style={{ marginTop: 10 }}>
        <label htmlFor="ui-theme" className={hit('Theme')}>
          Theme:
        </label>
        <div className="settings-row">
          <Select id="ui-theme" value={ui.theme} options={THEMES} onChange={(theme) => onChange({ theme })} />
          <label className={'settings-check' + hit('Sync with OS')} style={{ marginLeft: 14 }}>
            <input type="checkbox" className="checkbox" checked={ui.syncOs} onChange={(e) => onChange({ syncOs: e.target.checked })} />
            Sync with OS
          </label>
        </div>
        <span>Editor:</span>
        <span className="muted">
          Color scheme from the theme unless you pick one in{' '}
          <button type="button" className="link-btn" onClick={onEditorScheme}>
            Editor ▸ Color Scheme
          </button>
        </span>
      </div>

      <h3 className="settings-section">Accessibility</h3>
      <div className="settings-grid">
        <label htmlFor="ui-zoom" className={hit('Zoom')}>
          Zoom:
        </label>
        <div className="settings-row">
          <select id="ui-zoom" className="settings-select" value={ui.zoom} onChange={(e) => onChange({ zoom: Number(e.target.value) })}>
            {[50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]
              .concat(ui.zoom)
              .filter((z, i, a) => z >= MIN_ZOOM && z <= MAX_ZOOM && a.indexOf(z) === i)
              .sort((a, b) => a - b)
              .map((z) => (
                <option key={z} value={z}>
                  {z}%
                </option>
              ))}
          </select>
          <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>
            Alt+Shift+= / Alt+Shift+Minus, Alt+Shift+0 resets.
          </span>
          {ui.zoom !== 100 && (
            <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => onChange({ zoom: 100 })}>
              Reset to default
            </button>
          )}
        </div>
      </div>
      <div className="settings-row" style={{ margin: '8px 0' }}>
        <label className={'settings-check' + hit('Use custom font')}>
          <input type="checkbox" className="checkbox" checked={ui.customFont} onChange={(e) => onChange({ customFont: e.target.checked })} />
          Use custom font:
        </label>
        <div className="field" style={{ width: 200, marginLeft: 8 }}>
          <input aria-label="UI font" value={ui.fontFamily} disabled={!ui.customFont} spellCheck={false} onChange={(e) => onChange({ fontFamily: e.target.value })} />
        </div>
        <label htmlFor="ui-font-size" className="muted" style={{ marginLeft: 12 }}>
          Size:
        </label>
        <div className="field" style={{ width: 70, marginLeft: 6 }}>
          <input id="ui-font-size" type="number" min={10} max={20} value={ui.fontSize} disabled={!ui.customFont} onChange={(e) => onChange({ fontSize: Math.min(20, Math.max(10, Number(e.target.value) || 13)) })} />
        </div>
      </div>
      <Check label="Use contrast scrollbars" checked={ui.contrastScrollbars} onChange={(v) => onChange({ contrastScrollbars: v })} hit={hit} />

      <h3 className="settings-section">UI Options</h3>
      <div className="settings-columns">
        <div>
          <Check label="Compact mode" checked={ui.compact} onChange={(v) => onChange({ compact: v })} help="UI elements take up less screen space" hit={hit} />
          <Check label="Always show full path in window header" checked={ui.fullPathInTitle} onChange={(v) => onChange({ fullPathInTitle: v })} hit={hit} />
          <Check label="Use project colors in main toolbar" checked={ui.projectColors} onChange={(v) => onChange({ projectColors: v })} help="Distinguish projects with different toolbar colors at a glance." hit={hit} />
        </div>
        <div>
          <Check label="Smooth scrolling" checked={ui.smoothScrolling} onChange={(v) => onChange({ smoothScrolling: v })} hit={hit} />
          <Check label="Display icons in menu items" checked={ui.menuIcons} onChange={(v) => onChange({ menuIcons: v })} hit={hit} />
        </div>
      </div>

      <h3 className="settings-section">Tree Views</h3>
      <div className="settings-columns">
        <Check label="Show indent guides" checked={ui.indentGuides} onChange={(v) => onChange({ indentGuides: v })} hit={hit} />
        <Check label="Use smaller indents" checked={ui.smallerIndents} onChange={(v) => onChange({ smallerIndents: v })} hit={hit} />
      </div>

      <h3 className="settings-section">Tool Windows</h3>
      <div className="settings-columns">
        <Check label="Show tool window bars" checked={ui.toolWindowBars} onChange={(v) => onChange({ toolWindowBars: v })} help="The icon strips at the window's sides. Alt+1, Alt+9… still open tool windows." hit={hit} />
        <Check label="Show tool window names" checked={ui.toolWindowNames} disabled={!ui.toolWindowBars} onChange={(v) => onChange({ toolWindowNames: v })} hit={hit} />
      </div>
    </>
  );
}

export function EditorTabsPage({ value: t, onChange, highlight }: { value: TabSettings; onChange: (patch: Partial<TabSettings>) => void; highlight: string }) {
  const hit = hitter(highlight);
  return (
    <>
      <h3 className="settings-section">Appearance</h3>
      <div className="settings-grid">
        <label htmlFor="tab-placement" className={hit('Tab placement')}>
          Tab placement:
        </label>
        <Select
          id="tab-placement"
          value={t.placement}
          options={[
            { id: 'top', label: 'Top' },
            { id: 'bottom', label: 'Bottom' },
            { id: 'none', label: 'None' },
          ]}
          onChange={(placement) => onChange({ placement })}
        />
      </div>
      <div className={'settings-sub' + (t.placement === 'none' ? ' disabled' : '')}>
        <span className={hit('Show tabs in')}>Show tabs in:</span>
        <Radio
          name="tab-mode"
          value={t.mode === 'multiple' ? 'multiple' : 'one'}
          options={[
            { id: 'one', label: 'One row, and if tabs don’t fit:' },
            { id: 'multiple', label: 'Multiple rows' },
          ]}
          onChange={(v) => onChange({ mode: v === 'multiple' ? 'multiple' : 'scroll' })}
          hit={hit}
        />
        {t.mode !== 'multiple' && (
          <div className="settings-sub">
            <Radio
              name="tab-fit"
              value={t.mode === 'squeeze' ? 'squeeze' : 'scroll'}
              options={[
                { id: 'scroll', label: 'Scroll the tabs panel', help: 'Tabs keep their width; the ▾ list shows the ones out of view.' },
                { id: 'squeeze', label: 'Squeeze tabs' },
              ]}
              onChange={(mode) => onChange({ mode })}
              hit={hit}
            />
          </div>
        )}
      </div>
      <Check label="Show file icon" checked={t.showIcon} onChange={(v) => onChange({ showIcon: v })} hit={hit} />
      <Check label="Show file extension" checked={t.showExtension} onChange={(v) => onChange({ showExtension: v })} hit={hit} />
      <Check label="Show directory for non-unique file names" checked={t.showDirForDuplicates} onChange={(v) => onChange({ showDirForDuplicates: v })} hit={hit} />
      <Check label="Mark modified" checked={t.markModified} onChange={(v) => onChange({ markModified: v })} help="An asterisk after the name of unsaved files." hit={hit} />
      <Check label="Show full path on mouse hover" checked={t.pathOnHover} onChange={(v) => onChange({ pathOnHover: v })} hit={hit} />
      <div className="settings-grid" style={{ marginTop: 8 }}>
        <label htmlFor="tab-close" className={hit('Close button position')}>
          Close button position:
        </label>
        <Select
          id="tab-close"
          value={t.closeButton}
          options={[
            { id: 'right', label: 'Right' },
            { id: 'left', label: 'Left' },
            { id: 'none', label: 'None' },
          ]}
          onChange={(closeButton) => onChange({ closeButton })}
        />
      </div>

      <h3 className="settings-section">Tab Order</h3>
      <Check label="Sort tabs alphabetically" checked={t.sortAlphabetically} onChange={(v) => onChange({ sortAlphabetically: v })} hit={hit} />
      <Check label="Open new tabs at the end" checked={t.openAtEnd} disabled={t.sortAlphabetically} onChange={(v) => onChange({ openAtEnd: v })} help="Otherwise new tabs open next to the current one." hit={hit} />

      <h3 className="settings-section">Opening Policy</h3>
      <Check
        label="Enable preview tab"
        checked={t.previewTab}
        onChange={(v) => onChange({ previewTab: v })}
        help="The preview tab is reused to show files selected with a single click in the Project tool window (italic name; double-click or edit to keep it)."
        hit={hit}
      />

      <h3 className="settings-section">Closing Policy</h3>
      <div className="settings-grid">
        <label htmlFor="tab-limit" className={hit('Tab limit')}>
          Tab limit:
        </label>
        <div className="field" style={{ width: 70 }}>
          <input id="tab-limit" type="number" min={1} max={200} value={t.limit} onChange={(e) => onChange({ limit: Math.min(200, Math.max(1, Number(e.target.value) || 30)) })} />
        </div>
      </div>
      <div className="settings-sub">
        <span className={hit('When tabs exceed the limit')}>When tabs exceed the limit:</span>
        <Radio
          name="tab-over"
          value={t.overLimit}
          options={[
            { id: 'unchanged', label: 'Close unchanged' },
            { id: 'unused', label: 'Close unused' },
          ]}
          onChange={(overLimit) => onChange({ overLimit })}
          hit={hit}
        />
        <span className={hit('When the current tab is closed')}>When the current tab is closed, activate:</span>
        <Radio
          name="tab-activate"
          value={t.activateOnClose}
          options={[
            { id: 'left', label: 'The tab on the left' },
            { id: 'right', label: 'The tab on the right' },
            { id: 'recent', label: 'Most recently opened tab' },
          ]}
          onChange={(activateOnClose) => onChange({ activateOnClose })}
          hit={hit}
        />
      </div>
    </>
  );
}

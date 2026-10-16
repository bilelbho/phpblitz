// Settings (Ctrl+Alt+S), laid out like PhpStorm's: a searchable tree on the left, the page on the right.

import { useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Workspace } from '../useWorkspace';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type EditorSettings, type Settings, type TabSettings, type TerminalSettings, type UiSettings } from '../settings';
import { terminals, type ShellSpec } from '../terminal/manager';
import { isTauri } from '../platform';
import { Icon } from './Icon';
import { AppearancePage, EditorTabsPage } from './SettingsAppearance';
import { PhpPage } from './PhpSettings';
import { projectPhp, saveProjectPhp, type ProjectPhp } from '../interpreters';
import { SCHEMES, schemeOf, schemePreview, type SchemeId } from '../editor/themes';

interface Page {
  id: string;
  label: string;
  group: string;
  /** Words the search box matches besides the label (the page's options). */
  keywords: string;
  /** The part of the settings "Reset to defaults" resets (none: project settings). */
  section?: keyof Settings;
}

const PAGES: Page[] = [
  {
    id: 'php',
    label: 'PHP',
    group: 'PHP',
    keywords: 'language level cli interpreter php executable docker compose ssh xdebug debugger extension configuration options include path runtime extensions composer files',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'Appearance & Behavior',
    section: 'ui',
    keywords: 'theme islands dark light darcula high contrast sync os zoom font size scrollbars compact mode full path window header project colors toolbar smooth scrolling menu icons tree indent guides smaller indents tool window bars names',
  },
  {
    id: 'editor-tabs',
    label: 'Editor Tabs',
    group: 'Editor',
    section: 'tabs',
    keywords: 'tabs placement top bottom none one row scroll squeeze multiple rows file icon extension directory non-unique mark modified full path hover close button sort alphabetically open new tabs end preview tab limit close unchanged unused activate left right recent',
  },
  {
    id: 'color-scheme',
    label: 'Color Scheme',
    group: 'Editor',
    section: 'editor',
    keywords: 'theme colors dark light darcula high contrast monokai solarized one dark github islands',
  },
  {
    id: 'editor-font',
    label: 'Font',
    group: 'Editor',
    section: 'editor',
    keywords: 'font family size line height ligatures jetbrains mono',
  },
  {
    id: 'inlay-hints',
    label: 'Inlay Hints',
    group: 'Editor',
    section: 'editor',
    keywords: 'code vision usages parameter names hints lightbulb intention context actions render documentation comments reader mode phpdoc docblock',
  },
  {
    id: 'terminal',
    section: 'terminal',
    label: 'Terminal',
    group: 'Tools',
    keywords: 'shell path start directory environment variables font size line height tab name application title bell close session copy selection paste middle click shortcuts hyperlinks links cursor shape blink powershell bash cmd',
  },
];

export function SettingsDialog({ ws, page, onClose }: { ws: Workspace; page: string; onClose: () => void }) {
  const [draft, setDraft] = useState<Settings>(getSettings);
  const [saved, setSaved] = useState<Settings>(getSettings);
  const [current, setCurrent] = useState(page);
  const root = ws.backend.root;
  const [php, setPhp] = useState<ProjectPhp>(() => projectPhp(root));
  const [savedPhp, setSavedPhp] = useState<ProjectPhp>(() => projectPhp(root));
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? PAGES.filter((p) => `${p.group} ${p.label} ${p.keywords}`.toLowerCase().includes(q)) : PAGES;
  }, [query]);
  const groups = [...new Set(visible.map((p) => p.group))];
  const active = PAGES.find((p) => p.id === current) ?? PAGES[0];
  const modified = JSON.stringify(draft) !== JSON.stringify(saved) || JSON.stringify(php) !== JSON.stringify(savedPhp);

  const apply = () => {
    const t = draft.terminal;
    const ed = draft.editor;
    const next = {
      ui: draft.ui,
      tabs: draft.tabs,
      editor: { ...ed, fontSize: clamp(ed.fontSize, 6, 48, 13), lineHeight: clamp(ed.lineHeight, 1, 3, 1.6) },
      terminal: { ...t, fontSize: clamp(t.fontSize, 6, 48, 13), lineHeight: clamp(t.lineHeight, 0.8, 3, 1) },
    };
    saveSettings(next);
    saveProjectPhp(root, php);
    setSavedPhp(php);
    terminals.applySettings();
    setDraft(next);
    setSaved(next);
  };

  const setUi = (patch: Partial<UiSettings>) => setDraft((d) => ({ ...d, ui: { ...d.ui, ...patch } }));
  const setTabs = (patch: Partial<TabSettings>) => setDraft((d) => ({ ...d, tabs: { ...d.tabs, ...patch } }));
  const setEditor = (patch: Partial<EditorSettings>) => setDraft((d) => ({ ...d, editor: { ...d.editor, ...patch } }));
  const setTerminal = (patch: Partial<TerminalSettings>) => setDraft((d) => ({ ...d, terminal: { ...d.terminal, ...patch } }));

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="jb-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="settings-title">Settings</div>
        <div className="settings-main">
          <nav className="settings-nav" aria-label="Settings pages">
            <div className="field settings-search">
              <Icon name="search" size={14} />
              <input ref={searchRef} placeholder="Search settings" aria-label="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
            </div>
            <div className="settings-tree" role="tree">
              {groups.map((g) => (
                <div key={g} role="group" aria-label={g}>
                  <div className="settings-group">
                    <Icon name="chevronDown" size={11} strokeWidth={2.2} />
                    {g}
                  </div>
                  {visible
                    .filter((p) => p.group === g)
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="treeitem"
                        aria-selected={p.id === active.id}
                        className={'settings-node' + (p.id === active.id ? ' active' : '')}
                        onClick={() => setCurrent(p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                </div>
              ))}
              {!visible.length && <div className="muted settings-none">Nothing found</div>}
            </div>
          </nav>
          <div className="settings-page">
            <div className="settings-crumbs">
              {active.group !== active.label && (
                <>
                  {active.group} <Icon name="chevronRight" size={11} strokeWidth={2.2} />{' '}
                </>
              )}
              {active.label}
            </div>
            <div className="settings-content">
              {active.id === 'php' && <PhpPage ws={ws} draft={php} onChange={(patch) => setPhp((p) => ({ ...p, ...patch }))} />}
              {active.id === 'appearance' && <AppearancePage value={draft.ui} onChange={setUi} highlight={query.trim().toLowerCase()} onEditorScheme={() => setCurrent('color-scheme')} />}
              {active.id === 'editor-tabs' && <EditorTabsPage value={draft.tabs} onChange={setTabs} highlight={query.trim().toLowerCase()} />}
              {active.id === 'color-scheme' && <ColorSchemePage value={draft.editor} onChange={setEditor} />}
              {active.id === 'editor-font' && <EditorFontPage value={draft.editor} onChange={setEditor} highlight={query.trim().toLowerCase()} />}
              {active.id === 'inlay-hints' && <HintsPage value={draft.editor} onChange={setEditor} highlight={query.trim().toLowerCase()} />}
              {active.id === 'terminal' && <TerminalPage ws={ws} value={draft.terminal} onChange={setTerminal} highlight={query.trim().toLowerCase()} />}
            </div>
          </div>
        </div>
        <div className="jb-dialog-buttons settings-buttons">
          <button type="button" className="link-btn" style={{ marginRight: 'auto' }} disabled={!active.section} onClick={() => active.section && setDraft((d) => ({ ...d, [active.section!]: DEFAULT_SETTINGS[active.section!] }))}>
            Reset to defaults
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              apply();
              onClose();
            }}
          >
            OK
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!modified} onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function TerminalPage({ ws, value: t, onChange, highlight }: { ws: Workspace; value: TerminalSettings; onChange: (patch: Partial<TerminalSettings>) => void; highlight: string }) {
  const [shells, setShells] = useState<ShellSpec[]>([]);
  useEffect(() => {
    terminals.shells().then(setShells);
  }, []);
  const projectRoot = ws.backend.kind === 'disk' ? ws.backend.root : '';
  /** Marks options matching the search box, like PhpStorm's yellow highlight. */
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');

  const browse = async () => {
    if (!isTauri) return;
    const picked = await open({ directory: true, multiple: false, title: 'Start directory', defaultPath: t.startDir || projectRoot || undefined });
    if (typeof picked === 'string') onChange({ startDir: picked });
  };

  const check = (key: keyof TerminalSettings, label: string) => (
    <label className={'settings-check' + hit(label)}>
      <input type="checkbox" className="checkbox" checked={t[key] as boolean} onChange={(e) => onChange({ [key]: e.target.checked })} />
      {label}
    </label>
  );

  return (
    <>
      <h3 className="settings-section">Project Settings</h3>
      <div className="settings-grid">
        <label htmlFor="term-start" className={hit('Start directory')}>Start directory:</label>
        <div className="settings-row">
          <div className="field grow">
            <input id="term-start" value={t.startDir} placeholder={projectRoot || 'Project root'} spellCheck={false} onChange={(e) => onChange({ startDir: e.target.value })} />
          </div>
          <button type="button" className="icon-btn" aria-label="Browse for start directory" title="Browse…" disabled={!isTauri} onClick={browse}>
            <Icon name="folderOpen" size={15} />
          </button>
        </div>
        <label htmlFor="term-env" className={hit('Environment variables')}>Environment variables:</label>
        <div className="field">
          <input id="term-env" value={t.env} placeholder="KEY=value; OTHER=value" spellCheck={false} onChange={(e) => onChange({ env: e.target.value })} />
        </div>
      </div>

      <h3 className="settings-section">Application Settings</h3>
      <div className="settings-grid">
        <label htmlFor="term-shell" className={hit('Shell path')}>Shell path:</label>
        <div className="field">
          <input id="term-shell" list="term-shells" value={t.shellPath} placeholder={shells[0]?.path ?? 'Default shell'} spellCheck={false} onChange={(e) => onChange({ shellPath: e.target.value })} />
          <datalist id="term-shells">
            {shells.map((s) => (
              <option key={s.path} value={s.path}>
                {s.name}
              </option>
            ))}
          </datalist>
        </div>
        <span />
        <div className="settings-row wrap">
          {shells.map((s) => (
            <button key={s.path} type="button" className={'chip-btn' + (t.shellPath.toLowerCase() === s.path.toLowerCase() || (!t.shellPath && s === shells[0]) ? ' on' : '')} onClick={() => onChange({ shellPath: s === shells[0] ? '' : s.path })}>
              {s.name}
            </button>
          ))}
        </div>
        <label htmlFor="term-tabname" className={hit('Default tab name')}>Default tab name:</label>
        <div className="field" style={{ width: 200 }}>
          <input id="term-tabname" value={t.defaultTabName} spellCheck={false} onChange={(e) => onChange({ defaultTabName: e.target.value })} />
        </div>
      </div>
      <div className="settings-checks">
        {check('useAppTitle', 'Show application title')}
        {check('audibleBell', 'Audible bell')}
        {check('closeOnExit', 'Close session when it ends')}
        {check('copyOnSelect', 'Copy to clipboard on selection')}
        {check('pasteOnMiddleClick', 'Paste on middle mouse button click')}
        {check('overrideIdeShortcuts', 'Override IDE shortcuts')}
        {check('highlightLinks', 'Highlight hyperlinks (applies to new tabs)')}
      </div>
      <div className="settings-grid">
        <span className={hit('Cursor shape')}>Cursor shape:</span>
        <div className="settings-row" role="radiogroup" aria-label="Cursor shape">
          {(['block', 'underline', 'bar'] as const).map((shape) => (
            <label key={shape} className="settings-radio">
              <input type="radio" name="cursor-shape" checked={t.cursorShape === shape} onChange={() => onChange({ cursorShape: shape })} />
              {shape === 'bar' ? 'Vertical' : shape[0].toUpperCase() + shape.slice(1)}
            </label>
          ))}
          <label className={'settings-check' + hit('Blinking cursor')} style={{ marginLeft: 12 }}>
            <input type="checkbox" className="checkbox" checked={t.cursorBlink} onChange={(e) => onChange({ cursorBlink: e.target.checked })} />
            Blinking
          </label>
        </div>
      </div>

      <h3 className="settings-section">Font</h3>
      <div className="settings-grid">
        <label htmlFor="term-font" className={hit('Font')}>Font:</label>
        <div className="field" style={{ width: 240 }}>
          <input id="term-font" value={t.fontFamily} spellCheck={false} onChange={(e) => onChange({ fontFamily: e.target.value })} />
        </div>
        <label htmlFor="term-size" className={hit('Size')}>Size:</label>
        <div className="settings-row">
          <div className="field" style={{ width: 80 }}>
            <input id="term-size" type="number" min={6} max={48} value={t.fontSize} onChange={(e) => onChange({ fontSize: Number(e.target.value) })} onBlur={() => onChange({ fontSize: clamp(t.fontSize, 6, 48, 13) })} />
          </div>
          <label htmlFor="term-line" className={hit('Line height')} style={{ marginLeft: 16 }}>
            Line height:
          </label>
          <div className="field" style={{ width: 80 }}>
            <input id="term-line" type="number" min={0.8} max={3} step={0.1} value={t.lineHeight} onChange={(e) => onChange({ lineHeight: Number(e.target.value) })} onBlur={() => onChange({ lineHeight: clamp(t.lineHeight, 0.8, 3, 1) })} />
          </div>
        </div>
      </div>
      <div className="settings-preview" style={{ fontFamily: `'${t.fontFamily}', 'JetBrains Mono', monospace`, fontSize: t.fontSize, lineHeight: t.lineHeight }}>
        <span style={{ color: '#5c962c' }}>PS</span> {projectRoot || 'C:\\project'}&gt; composer test
        <br />
        <span className="muted">OK (42 tests, 97 assertions)</span>
      </div>
      {!isTauri && <p className="muted settings-note">The interactive terminal runs in the desktop app; this browser preview uses a simple command runner.</p>}
    </>
  );
}

export function clamp(n: number, min: number, max: number, fallback: number) {
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
}

const SAMPLE = `<?php
namespace App\\Controller;

/** @return Response */
#[Route('/upload', name: 'upload')]
public function upload(Request $request): Response
{
    $file = $request->files->get('photo');
    if (!$file) {
        return new Response('No file', status: 400);
    }
    // Saved for later
    return $this->json(['ok' => true, 'size' => 1024]);
}`;

function ColorSchemePage({ value, onChange }: { value: EditorSettings; onChange: (patch: Partial<EditorSettings>) => void }) {
  return (
    <>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        The editor's colors. <b>Theme default</b> follows the UI theme (Appearance & Behavior ▸ Appearance).
      </p>
      <div className="scheme-grid" role="radiogroup" aria-label="Color scheme">
        <button type="button" role="radio" aria-checked={value.scheme === 'theme'} className={'scheme-card' + (value.scheme === 'theme' ? ' on' : '')} onClick={() => onChange({ scheme: 'theme' })}>
          <pre className="scheme-preview" style={{ background: schemeOf('theme').bg, color: schemeOf('theme').fg }} dangerouslySetInnerHTML={{ __html: schemePreview('theme', SAMPLE) }} />
          <span className="scheme-name">
            {value.scheme === 'theme' && <Icon name="check" size={12} strokeWidth={2.6} />}
            Theme default
          </span>
        </button>
        {(Object.keys(SCHEMES) as SchemeId[]).map((id) => {
          const p = SCHEMES[id];
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={value.scheme === id}
              className={'scheme-card' + (value.scheme === id ? ' on' : '')}
              onClick={() => onChange({ scheme: id })}
            >
              <pre className="scheme-preview" style={{ background: p.bg, color: p.fg }} dangerouslySetInnerHTML={{ __html: schemePreview(id, SAMPLE) }} />
              <span className="scheme-name">
                {value.scheme === id && <Icon name="check" size={12} strokeWidth={2.6} />}
                {p.name}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function EditorFontPage({ value: e, onChange, highlight }: { value: EditorSettings; onChange: (patch: Partial<EditorSettings>) => void; highlight: string }) {
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');
  return (
    <>
      <div className="settings-grid" style={{ marginTop: 12 }}>
        <label htmlFor="ed-font" className={hit('Font')}>Font:</label>
        <div className="field" style={{ width: 240 }}>
          <input id="ed-font" value={e.fontFamily} spellCheck={false} onChange={(ev) => onChange({ fontFamily: ev.target.value })} />
        </div>
        <label htmlFor="ed-size" className={hit('Size')}>Size:</label>
        <div className="settings-row">
          <div className="field" style={{ width: 80 }}>
            <input id="ed-size" type="number" min={6} max={48} value={e.fontSize} onChange={(ev) => onChange({ fontSize: Number(ev.target.value) })} onBlur={() => onChange({ fontSize: clamp(e.fontSize, 6, 48, 13) })} />
          </div>
          <label htmlFor="ed-line" className={hit('Line height')} style={{ marginLeft: 16 }}>
            Line height:
          </label>
          <div className="field" style={{ width: 80 }}>
            <input id="ed-line" type="number" min={1} max={3} step={0.1} value={e.lineHeight} onChange={(ev) => onChange({ lineHeight: Number(ev.target.value) })} onBlur={() => onChange({ lineHeight: clamp(e.lineHeight, 1, 3, 1.6) })} />
          </div>
        </div>
      </div>
      <label className={'settings-check' + hit('Enable ligatures')} style={{ margin: '10px 0' }}>
        <input type="checkbox" className="checkbox" checked={e.ligatures} onChange={(ev) => onChange({ ligatures: ev.target.checked })} />
        Enable ligatures
      </label>
      <pre
        className="scheme-preview large"
        style={{ background: schemeOf(e.scheme).bg, fontFamily: `'${e.fontFamily}', 'JetBrains Mono', monospace`, fontSize: e.fontSize, lineHeight: e.lineHeight, fontVariantLigatures: e.ligatures ? 'normal' : 'none' }}
        dangerouslySetInnerHTML={{ __html: schemePreview(e.scheme, SAMPLE + '\n// -> => != === <= >=') }}
      />
    </>
  );
}

function HintsPage({ value: e, onChange, highlight }: { value: EditorSettings; onChange: (patch: Partial<EditorSettings>) => void; highlight: string }) {
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');
  const check = (key: 'codeVision' | 'inlayHints' | 'lightbulb' | 'renderDocs', label: string, help: string) => (
    <div>
      <label className={'settings-check' + hit(label)}>
        <input type="checkbox" className="checkbox" checked={e[key]} onChange={(ev) => onChange({ [key]: ev.target.checked })} />
        {label}
      </label>
      <div className="muted settings-help">{help}</div>
    </div>
  );
  return (
    <div className="settings-checks" style={{ marginTop: 14, gap: 14 }}>
      {check('codeVision', 'Code vision: usages', '"N usages" above classes, methods and properties. Click it to find them.')}
      {check('inlayHints', 'Parameter names and types', 'Hints from the language server, such as content: and status: before arguments.')}
      {check('lightbulb', 'Show lightbulb for context actions', 'A bulb on the caret line when Alt+Enter has something to offer.')}
      {check('renderDocs', 'Render documentation comments', 'Show /** */ comments formatted. Click the pencil in the gutter or press Ctrl+Alt+Q to edit one.')}
    </div>
  );
}

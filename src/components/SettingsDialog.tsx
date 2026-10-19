// Settings (Ctrl+Alt+S), laid out: a searchable tree on the left, the page on the right.

import { useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Workspace } from '../useWorkspace';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type AiSettings, type DebugSettings, type EditorSettings, type Settings, type TabSettings, type TerminalSettings, type UiSettings } from '../settings';
import { terminals, type ShellSpec } from '../terminal/manager';
import { isTauri } from '../platform';
import { installedMonoFonts } from '../fonts';
import { Icon } from './Icon';
import { AppearancePage, EditorTabsPage } from './SettingsAppearance';
import { PhpPage } from './PhpSettings';
import { projectPhp, saveProjectPhp, type ProjectPhp } from '../interpreters';
import { SCHEMES, schemeOf, schemePreview, type SchemeId } from '../editor/themes';
import { AiAgentsPage } from './SettingsAi';

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
    id: 'debug',
    label: 'Debug',
    group: 'PHP',
    section: 'debug',
    keywords: 'xdebug debug port 9003 break at first line exceptions max children inline values listen connections',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'Appearance & Behavior',
    section: 'ui',
    keywords: 'theme blitz dark light classic high contrast sync os zoom font size scrollbars compact mode full path window header project colors toolbar smooth scrolling menu icons tree indent guides smaller indents tool window bars names updates check automatically new version main menu bar hamburger merge toolbar',
  },
  {
    id: 'editor-general',
    label: 'General',
    group: 'Editor',
    section: 'editor',
    keywords: 'soft wraps soft-wrap these files md txt appearance line numbers code folding outline indent guides whitespaces',
  },
  {
    id: 'gutter-icons',
    label: 'Gutter Icons',
    group: 'Editor',
    section: 'editor',
    keywords: 'gutter icons bookmarks run markdown code blocks documentation comments vcs changes markers breakpoints',
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
    keywords: 'theme colors blitz dark light classic daylight high contrast monokai solarized one dark',
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
  {
    id: 'ai-agents',
    section: 'ai',
    label: 'AI',
    group: 'Tools',
    keywords: 'ai assistant chat anthropic claude api key model sonnet haiku opus ghost text inline completion commit message edit with ai agents mcp model context protocol server claude code codex gemini copilot token port',
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
      debug: { ...draft.debug, port: clamp(draft.debug.port, 1, 65535, 9003), maxChildren: clamp(draft.debug.maxChildren, 10, 1000, 100) },
      ai: { ...draft.ai, mcpPort: clamp(draft.ai.mcpPort, 1024, 65535, 7465) },
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
  const setDebug = (patch: Partial<DebugSettings>) => setDraft((d) => ({ ...d, debug: { ...d.debug, ...patch } }));
  const setAi = (patch: Partial<AiSettings>) => setDraft((d) => ({ ...d, ai: { ...d.ai, ...patch } }));

  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-dialog settings-dialog"
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
                    <Icon name="chevronDown" size={11} />
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
                  {active.group} <Icon name="chevronRight" size={11} />{' '}
                </>
              )}
              {active.label}
            </div>
            <div className="settings-content">
              {active.id === 'debug' && <DebugPage value={draft.debug} onChange={setDebug} highlight={query.trim().toLowerCase()} />}
              {active.id === 'php' && <PhpPage ws={ws} draft={php} onChange={(patch) => setPhp((p) => ({ ...p, ...patch }))} />}
              {active.id === 'appearance' && <AppearancePage value={draft.ui} onChange={setUi} highlight={query.trim().toLowerCase()} onEditorScheme={() => setCurrent('color-scheme')} />}
              {active.id === 'editor-tabs' && <EditorTabsPage value={draft.tabs} onChange={setTabs} highlight={query.trim().toLowerCase()} />}
              {active.id === 'color-scheme' && <ColorSchemePage value={draft.editor} onChange={setEditor} />}
              {active.id === 'editor-font' && <EditorFontPage value={draft.editor} onChange={setEditor} highlight={query.trim().toLowerCase()} />}
              {active.id === 'inlay-hints' && <HintsPage value={draft.editor} onChange={setEditor} highlight={query.trim().toLowerCase()} />}
              {active.id === 'editor-general' && <EditorGeneralPage value={draft.editor} onChange={setEditor} highlight={query.trim().toLowerCase()} />}
              {active.id === 'gutter-icons' && <GutterIconsPage value={draft.editor} onChange={setEditor} highlight={query.trim().toLowerCase()} />}
              {active.id === 'terminal' && <TerminalPage ws={ws} value={draft.terminal} onChange={setTerminal} highlight={query.trim().toLowerCase()} />}
              {active.id === 'ai-agents' && <AiAgentsPage value={draft.ai} saved={saved.ai} onChange={setAi} highlight={query.trim().toLowerCase()} />}
            </div>
          </div>
        </div>
        <div className="pb-dialog-buttons settings-buttons">
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
  /** Marks options matching the search box, with a yellow highlight. */
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
        <FontPicker id="term-font" value={t.fontFamily} onChange={(fontFamily) => onChange({ fontFamily })} />
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
            {value.scheme === 'theme' && <Icon name="check" size={12} />}
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
                {value.scheme === id && <Icon name="check" size={12} />}
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
        <FontPicker id="ed-font" value={e.fontFamily} onChange={(fontFamily) => onChange({ fontFamily })} />
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
  const check = (key: 'codeVision' | 'inlayHints' | 'lightbulb' | 'renderDocs' | 'spellCheck', label: string, help: string) => (
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
      {check('codeVision', 'Code vision: usages', '"N usages" above classes, methods and functions. Click it to find them.')}
      {check('spellCheck', 'Spelling: typos', "Misspelled words in names, comments and strings get a green wavy underline. Alt+Enter: Rename to… or Save to dictionary (the project's, in .blitz/project.json).")}
      {check('inlayHints', 'Parameter names and types', 'Hints from the language server, such as content: and status: before arguments.')}
      {check('lightbulb', 'Show lightbulb for context actions', 'A bulb on the caret line when Alt+Enter has something to offer.')}
      {check('renderDocs', 'Render documentation comments', 'Show /** */ comments formatted. Click the pencil in the gutter or press Ctrl+Alt+Q to edit one.')}
    </div>
  );
}

type EditorFlag = { [K in keyof EditorSettings]: EditorSettings[K] extends boolean ? K : never }[keyof EditorSettings];

function EditorCheck({ e, k, label, help, onChange, hit, disabled }: { e: EditorSettings; k: EditorFlag; label: string; help?: string; onChange: (patch: Partial<EditorSettings>) => void; hit: (label: string) => string; disabled?: boolean }) {
  return (
    <div>
      <label className={'settings-check' + hit(label)}>
        <input type="checkbox" className="checkbox" checked={e[k]} disabled={disabled} onChange={(ev) => onChange({ [k]: ev.target.checked })} />
        {label}
      </label>
      {help && <div className="muted settings-help">{help}</div>}
    </div>
  );
}

/** Editor ▸ General: soft wraps and what the editor shows. */
function EditorGeneralPage({ value: e, onChange, highlight }: { value: EditorSettings; onChange: (patch: Partial<EditorSettings>) => void; highlight: string }) {
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');
  const props = { e, onChange, hit };
  return (
    <>
      <h3 className="settings-section">Soft Wraps</h3>
      <div className="settings-grid">
        <label htmlFor="soft-wrap-files" className={hit('Soft-wrap these files')}>
          Soft-wrap these files:
        </label>
        <div className="settings-row">
          <div className="field" style={{ width: 260 }}>
            <input id="soft-wrap-files" value={e.softWrapFiles} spellCheck={false} onChange={(ev) => onChange({ softWrapFiles: ev.target.value })} />
          </div>
          <span className="muted">Separate patterns with ";". Alt+Z wraps or unwraps one editor.</span>
        </div>
      </div>
      <h3 className="settings-section">Appearance</h3>
      <div className="settings-checks" style={{ gap: 10 }}>
        <EditorCheck {...props} k="lineNumbers" label="Show line numbers" />
        <EditorCheck {...props} k="foldingOutline" label="Show code folding outline" />
        <EditorCheck {...props} k="indentGuides" label="Show indent guides" />
        <EditorCheck {...props} k="whitespaces" label="Show whitespaces" />
      </div>
    </>
  );
}

/** Editor ▸ General ▸ Gutter Icons. */
function GutterIconsPage({ value: e, onChange, highlight }: { value: EditorSettings; onChange: (patch: Partial<EditorSettings>) => void; highlight: string }) {
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');
  const props = { e, onChange, hit, disabled: !e.gutterIcons };
  return (
    <div className="settings-checks" style={{ marginTop: 14, gap: 12 }}>
      <EditorCheck e={e} onChange={onChange} hit={hit} k="gutterIcons" label="Show gutter icons" help="Breakpoints always show." />
      <div className="settings-checks" style={{ paddingLeft: 22, gap: 12 }}>
        <EditorCheck {...props} k="gutterBookmarks" label="Bookmarks" help="F11 adds one, Ctrl+F11 one with a mnemonic, Shift+F11 lists them." />
        <EditorCheck {...props} k="gutterRun" label="Run code blocks (Markdown)" help="▷ beside shell code blocks in .md files." />
        <EditorCheck {...props} k="gutterDocs" label="Rendered documentation comments" help="The pencil that switches a /** */ comment between rendered and raw." />
        <EditorCheck e={e} onChange={onChange} hit={hit} k="gutterChanges" label="VCS changes (added, modified, deleted lines)" help="The colored bars next to the line numbers. Click one to see what changed." />
      </div>
    </div>
  );
}

/** PHP ▸ Debug: Xdebug's port and when to stop. */
function DebugPage({ value: d, onChange, highlight }: { value: DebugSettings; onChange: (patch: Partial<DebugSettings>) => void; highlight: string }) {
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');
  const check = (key: 'breakAtFirstLine' | 'breakOnExceptions' | 'inlineValues', label: string, help: string) => (
    <div>
      <label className={'settings-check' + hit(label)}>
        <input type="checkbox" className="checkbox" checked={d[key]} onChange={(e) => onChange({ [key]: e.target.checked })} />
        {label}
      </label>
      <div className="muted settings-help">{help}</div>
    </div>
  );
  return (
    <>
      <h3 className="settings-section">Xdebug</h3>
      <div className="settings-grid">
        <label htmlFor="debug-port" className={hit('Debug port')}>
          Debug port:
        </label>
        <div className="settings-row">
          <div className="field" style={{ width: 90 }}>
            <input id="debug-port" value={d.port} onChange={(e) => onChange({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </div>
          <span className="muted">Xdebug 3 connects to 9003 by default (xdebug.client_port).</span>
        </div>
        <label htmlFor="debug-children" className={hit('Max children')}>
          Max array items shown:
        </label>
        <div className="field" style={{ width: 90 }}>
          <input id="debug-children" value={d.maxChildren} onChange={(e) => onChange({ maxChildren: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
        </div>
      </div>
      <div className="settings-checks" style={{ gap: 14 }}>
        {check('breakAtFirstLine', 'Break at first line in PHP scripts', 'Stop on the first line even without breakpoints.')}
        {check('breakOnExceptions', 'Break on exceptions', 'Stop where an exception is thrown (all exception classes).')}
        {check('inlineValues', 'Show values inline', 'While stopped, show variable values at the end of the lines that use them.')}
      </div>
      <div className="muted settings-help" style={{ marginTop: 12 }}>
        For web requests, start listening (the phone icon in the toolbar) and trigger Xdebug with a browser extension, a XDEBUG_SESSION cookie, or xdebug.start_with_request=yes.
      </div>
    </>
  );
}

/** The monospaced fonts found on this computer, each shown in itself; Other… types any name. */
function FontPicker({ id, value, onChange }: { id: string; value: string; onChange: (font: string) => void }) {
  const fonts = useMemo(installedMonoFonts, []);
  const [typing, setTyping] = useState(() => !fonts.includes(value));
  if (typing)
    return (
      <div className="settings-row">
        <div className="field" style={{ width: 240 }}>
          <input id={id} value={value} spellCheck={false} placeholder="Font name" onChange={(ev) => onChange(ev.target.value)} />
        </div>
        {fonts.length > 0 && (
          <button type="button" className="link-btn" onClick={() => setTyping(false)}>
            Choose from list
          </button>
        )}
      </div>
    );
  return (
    <select
      id={id}
      className="settings-select"
      style={{ width: 240, fontFamily: `'${value}', monospace` }}
      value={value}
      onChange={(ev) => (ev.target.value === '__other__' ? setTyping(true) : onChange(ev.target.value))}
    >
      {fonts.map((f) => (
        <option key={f} value={f} style={{ fontFamily: `'${f}', monospace` }}>
          {f}
        </option>
      ))}
      <option value={'__other__'}>Other…</option>
    </select>
  );
}

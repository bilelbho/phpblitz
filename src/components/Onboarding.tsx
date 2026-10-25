// The onboarding screen: theme, layout, keymap, AI agents, Vim mode, trust and
// updates, each saved as it's picked. Shown on the first launch, and from Help ▸ Onboarding or the
// welcome screen's Customize. Finish Setup (Ctrl+Enter) closes it.

import { useEffect, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getSettings, saveSettings, useSettings, type Settings, type UiTheme } from '../settings';
import { KEYMAPS } from '../keymap/keymaps';
import { AGENTS, detectAgents, useAgents } from '../agents';
import { isTauri } from '../platform';
import { Logo } from './Icon';
import { WindowControls } from './WindowControls';

const update = (patch: (s: Settings) => Settings) => saveSettings(patch(getSettings()));

// ── Themes ──────────────────────────────────────────────────────

type Family = 'islands' | 'flat' | 'classic' | 'contrast';
type Look = 'light' | 'dark' | 'system';

const FAMILIES: { id: Family; label: string; dark: UiTheme; light?: UiTheme }[] = [
  { id: 'islands', label: 'Blitz', dark: 'blitz-dark', light: 'blitz-light' },
  { id: 'flat', label: 'Flat', dark: 'flat-dark', light: 'flat-light' },
  { id: 'classic', label: 'Classic', dark: 'flat-classic' },
  { id: 'contrast', label: 'High Contrast', dark: 'high-contrast' },
];

const familyOf = (t: UiTheme): Family => (t === 'high-contrast' ? 'contrast' : t.endsWith('classic') ? 'classic' : t.startsWith('flat-') ? 'flat' : 'islands');
const isLight = (t: UiTheme) => t.endsWith('-light');

/** Colors for the small previews: frame, panel, line, text, then keyword, string, function. */
const SWATCH: Record<'dark' | 'light' | 'classic' | 'contrast', string[]> = {
  dark: ['#131416', '#1e1f22', '#2b2d30', '#6f737a', '#cf8e6d', '#6aab73', '#56a8f5'],
  light: ['#e8e9ed', '#ffffff', '#ebecf0', '#a8adbd', '#0033b3', '#067d17', '#00627a'],
  classic: ['#1f1f1f', '#2b2b2b', '#323232', '#606366', '#cc7832', '#6a8759', '#ffc66d'],
  contrast: ['#000000', '#000000', '#6f6f6f', '#ffffff', '#ff9900', '#3dd13d', '#5ac8ff'],
};

/** A tiny editor drawn in a theme's colors: rounded panels on a frame (islands) or edge to edge. */
function ThemePreview({ colors, rounded }: { colors: string[]; rounded: boolean }) {
  const [frame, panel, line, text, kw, str, fn] = colors;
  const gap = rounded ? 3 : 0;
  const code = [
    [kw, 10, text, 18],
    [text, 6, fn, 14, text, 6],
    [str, 22],
    [kw, 8, text, 12, str, 10],
    [text, 14, fn, 10],
    [kw, 6, str, 16],
  ];
  return (
    <svg viewBox="0 0 120 64" className="ob-preview" aria-hidden="true">
      <rect width="120" height="64" fill={frame} />
      <rect x={gap} y={gap} width={30 - gap} height={64 - gap * 2} rx={rounded ? 3 : 0} fill={panel} />
      <rect x={30 + gap} y={gap} width={90 - gap * 2} height={64 - gap * 2} rx={rounded ? 3 : 0} fill={panel} />
      {!rounded && <rect x="30" width="0.6" height="64" fill={line} />}
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x={6} y={8 + i * 8} width={i % 2 ? 14 : 18} height="2.5" rx="1" fill={text} opacity="0.7" />
      ))}
      {code.map((row, r) => {
        let x = 38;
        const parts: ReactNode[] = [];
        for (let i = 0; i < row.length; i += 2) {
          parts.push(<rect key={i} x={x} y={8 + r * 8} width={row[i + 1] as number} height="2.5" rx="1" fill={row[i] as string} />);
          x += (row[i + 1] as number) + 3;
        }
        return <g key={r}>{parts}</g>;
      })}
    </svg>
  );
}

function ThemeSection() {
  const ui = useSettings().ui;
  const family = familyOf(ui.theme);
  const look: Look = ui.syncOs ? 'system' : isLight(ui.theme) ? 'light' : 'dark';
  const pick = (f: Family, l: Look) => {
    const fam = FAMILIES.find((x) => x.id === f)!;
    // Classic and High Contrast are dark only: light picks Blitz Light.
    const theme = l === 'light' ? (fam.light ?? 'blitz-light') : fam.dark;
    update((s) => ({ ...s, ui: { ...s.ui, theme, syncOs: l === 'system' } }));
  };
  return (
    <Section
      title="Theme"
      side={
        <Segmented
          label="Light or dark"
          value={look}
          options={[
            ['light', 'Light'],
            ['dark', 'Dark'],
            ['system', 'System'],
          ]}
          onChange={(l) => pick(l === 'light' && !FAMILIES.find((f) => f.id === family)?.light ? 'islands' : family, l)}
        />
      }
    >
      <div className="ob-themes" role="radiogroup" aria-label="Theme">
        {FAMILIES.map((f) => {
          const light = look === 'light';
          const disabled = light && !f.light;
          const colors = f.id === 'classic' ? SWATCH.classic : f.id === 'contrast' ? SWATCH.contrast : light ? SWATCH.light : SWATCH.dark;
          return (
            <button key={f.id} type="button" role="radio" aria-checked={family === f.id} disabled={disabled} className={'ob-card' + (family === f.id ? ' on' : '')} onClick={() => pick(f.id, look)} title={disabled ? 'Dark only' : undefined}>
              <ThemePreview colors={colors} rounded={f.id === 'islands'} />
              <span>{f.label}</span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ── Layout ──────────────────────────────────────────────────────

function LayoutPreview({ focus }: { focus: boolean }) {
  const [frame, panel, line, text, kw] = SWATCH.dark;
  return (
    <svg viewBox="0 0 120 64" className="ob-preview" aria-hidden="true">
      <rect width="120" height="64" fill={frame} />
      {focus ? (
        <>
          <rect x="0" y="0" width="120" height="7" fill={panel} />
          <rect x="22" y="2" width="14" height="3" rx="1" fill={kw} />
          <rect x="39" y="2" width="12" height="3" rx="1" fill={text} />
          <rect x="2" y="9" width="24" height="53" rx="2" fill={panel} />
          <rect x="28" y="9" width="62" height="34" rx="2" fill={panel} />
          <rect x="28" y="45" width="62" height="17" rx="2" fill={panel} />
          <rect x="92" y="9" width="26" height="53" rx="2" fill={panel} />
        </>
      ) : (
        <>
          <rect x="0" y="0" width="120" height="7" fill={panel} />
          <rect x="0" y="7" width="6" height="57" fill={panel} />
          <rect x="114" y="7" width="6" height="57" fill={panel} />
          <rect x="8" y="9" width="26" height="36" rx="2" fill={panel} />
          <rect x="36" y="9" width="76" height="36" rx="2" fill={panel} />
          <rect x="8" y="47" width="104" height="15" rx="2" fill={panel} />
          <rect x="36" y="11" width="16" height="3" rx="1" fill={kw} />
        </>
      )}
      <rect x="0" y="7" width="120" height="0.5" fill={line} />
    </svg>
  );
}

function LayoutSection() {
  const ui = useSettings().ui;
  const choices = [
    ['classic', 'Classic', 'Tool window bars on the sides and a bottom panel.'],
    ['focus', 'Focus', 'Tabs in the top bar, panels in columns you drag anywhere.'],
  ] as const;
  return (
    <Section title="Layout">
      <div className="ob-layouts" role="radiogroup" aria-label="Layout">
        {choices.map(([id, label, help]) => (
          <button key={id} type="button" role="radio" aria-checked={ui.layout === id} className={'ob-card wide' + (ui.layout === id ? ' on' : '')} onClick={() => update((s) => ({ ...s, ui: { ...s.ui, layout: id } }))}>
            <LayoutPreview focus={id === 'focus'} />
            <span className="ob-card-text">
              <b>{label}</b>
              <span>{help}</span>
            </span>
          </button>
        ))}
      </div>
    </Section>
  );
}

// ── The rest ────────────────────────────────────────────────────

function KeymapSection() {
  const preset = useSettings().keymap.preset;
  return (
    <Section title="Base Keymap" help="The shortcuts you already know. Change any key later in Settings ▸ Keymap.">
      <div className="ob-keymaps" role="radiogroup" aria-label="Base keymap">
        {KEYMAPS.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={preset === k.id} className={'ob-key' + (preset === k.id ? ' on' : '')} onClick={() => update((s) => ({ ...s, keymap: { preset: k.id, overrides: {} } }))}>
            {k.label}
          </button>
        ))}
      </div>
    </Section>
  );
}

function AgentsSection() {
  const { found } = useAgents();
  const ai = useSettings().ai;
  useEffect(() => {
    if (isTauri) void detectAgents();
  }, []);
  return (
    <Section title="AI Agents" help="Agents run in a terminal tab, under your own account. PHPBlitz finds the ones installed.">
      <div className="ob-agents">
        {AGENTS.map((a) => {
          const path = found[a.id];
          return (
            <div key={a.id} className="ob-agent">
              <b>{a.name}</b>
              {path ? (
                <span className="ob-found">Installed</span>
              ) : (
                <button type="button" className="link-btn" onClick={() => void invoke('open_external', { url: a.install }).catch(() => {})}>
                  How to install
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Toggle
        label="Let agents ask PHPBlitz about the project"
        help="A local MCP server, read only, for this computer: agents can look up classes, usages and problems."
        checked={ai.mcpServer}
        onChange={(mcpServer) => update((s) => ({ ...s, ai: { ...s.ai, mcpServer } }))}
      />
    </Section>
  );
}

// ── Building blocks ─────────────────────────────────────────────

function Section({ title, help, side, children }: { title: string; help?: string; side?: ReactNode; children?: ReactNode }) {
  return (
    <section className="ob-section">
      <div className="ob-section-head">
        <div>
          <h2>{title}</h2>
          {help && <p>{help}</p>}
        </div>
        {side}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="ob-segmented" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="ob-toggle">
      <span>
        <span className="ob-toggle-label">{label}</span>
        {help && <span className="ob-toggle-help">{help}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ob-switch" aria-hidden="true" />
    </label>
  );
}

export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const s = useSettings();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onFinish();
      }
    };
    // In the capture phase, on the window: the keymap dispatcher (also there) stops it going further.
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onFinish]);

  return (
    <div className="app onboarding-app">
      <header className="topbar" data-tauri-drag-region>
        <span className="tw-title" data-tauri-drag-region style={{ paddingLeft: 12 }}>
          Onboarding
        </span>
        <div className="drag" data-tauri-drag-region />
        <WindowControls />
      </header>
      <main className="onboarding island">
        <div className="ob-page">
          <header className="ob-head">
            <Logo size={40} />
            <div>
              <h1>Welcome to PHPBlitz</h1>
              <p>A fast, open source PHP IDE. Set it up your way; everything here can change later in Settings.</p>
            </div>
            <button type="button" className="btn primary ob-finish" onClick={onFinish}>
              Finish Setup <kbd>Ctrl+Enter</kbd>
            </button>
          </header>

          <ThemeSection />
          <LayoutSection />
          <KeymapSection />
          <AgentsSection />

          <section className="ob-section">
            <Toggle
              label="Vim Mode"
              help="Vim's keys in the editor: modes, motions, operators, registers, macros and : commands."
              checked={s.editor.vimMode}
              onChange={(vimMode) => update((x) => ({ ...x, editor: { ...x.editor, vimMode } }))}
            />
          </section>
          <section className="ob-section">
            <Toggle
              label="Trust All Projects by Default"
              help="Off, a project you haven't trusted opens in Restricted Mode: no Git, PHP, Composer, tests or language servers run in it until you trust it."
              checked={!s.security.restrictedMode}
              onChange={(trustAll) => update((x) => ({ ...x, security: { restrictedMode: !trustAll } }))}
            />
          </section>

          <section className="ob-section ob-last">
            <Toggle label="Check for updates automatically" checked={s.ui.checkUpdates} onChange={(checkUpdates) => update((x) => ({ ...x, ui: { ...x.ui, checkUpdates } }))} />
            <p className="ob-note">PHPBlitz has no telemetry: it sends no usage data and no crash reports.</p>
          </section>
        </div>
      </main>
    </div>
  );
}

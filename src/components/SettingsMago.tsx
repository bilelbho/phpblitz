// Settings ▸ PHP ▸ Mago: how loud Mago's lint rules are in the editor, for projects without their
// own mago.toml (with one, its levels apply, the same as for the mago CLI). By category (all of
// Maintainability's design hints, say) and rule by rule, which wins over its category.

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from '../useWorkspace';
import type { MagoLevel, MagoSettings } from '../settings';
import { isTauri } from '../platform';
import { Icon } from './Icon';

interface Rule {
  code: string;
  name: string;
  category: string;
  description: string;
}

const CATEGORIES: [string, string, string][] = [
  ['correctness', 'Correctness', 'Code that is likely wrong'],
  ['safety', 'Safety', 'Code that can fail at run time'],
  ['security', 'Security', 'Possible security problems'],
  ['deprecation', 'Deprecation', 'Features on their way out'],
  ['best-practices', 'Best Practices', 'Better ways to write the same thing'],
  ['maintainability', 'Maintainability', 'Design hints: complexity, too many methods or properties…'],
  ['clarity', 'Clarity', 'Code that is harder to read than it needs to be'],
  ['consistency', 'Consistency', 'One way of writing the same thing'],
  ['redundancy', 'Redundancy', 'Code that does nothing'],
];

const LEVELS: [MagoLevel | '', string][] = [
  ['', 'As Mago sets it'],
  ['error', 'Error'],
  ['warning', 'Warning'],
  ['weak', 'Weak warning'],
  ['off', 'Off'],
];

function LevelSelect({ value, onChange, label }: { value: MagoLevel | undefined; onChange: (v: MagoLevel | undefined) => void; label: string }) {
  return (
    <select className="settings-select" aria-label={label} value={value ?? ''} onChange={(e) => onChange((e.target.value || undefined) as MagoLevel | undefined)}>
      {LEVELS.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

export function MagoPage({ ws, value, onChange }: { ws: Workspace; value: MagoSettings; onChange: (next: MagoSettings) => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [adding, setAdding] = useState('');
  useEffect(() => {
    if (isTauri) invoke<Rule[]>('mago_rules').then(setRules, () => {});
  }, []);
  const byCode = useMemo(() => new Map(rules.map((r) => [r.code, r])), [rules]);
  const configFile = ws.magoStatus.summary?.configFile;

  const setCategory = (key: string, level: MagoLevel | undefined) => {
    const categories = { ...value.categories };
    if (level) categories[key] = level;
    else delete categories[key];
    onChange({ ...value, categories });
  };
  const setRule = (code: string, level: MagoLevel | undefined) => {
    const next = { ...value.rules };
    if (level) next[code] = level;
    else delete next[code];
    onChange({ ...value, rules: next });
  };
  const add = () => {
    const code = adding.trim();
    if (!code || !byCode.has(code) || code in value.rules) return;
    setRule(code, 'weak');
    setAdding('');
  };

  return (
    <>
      {configFile ? (
        <div className="problems-banner mago-config-note">
          <Icon name="info" size={14} />
          <span className="grow">This project has its own mago.toml: its rule levels apply here, the same as for the mago command. The levels below are for projects without one.</span>
          <button type="button" className="btn small" onClick={() => ws.openFile(configFile)}>
            Open mago.toml
          </button>
        </div>
      ) : (
        <p className="muted settings-help">
          For projects without a mago.toml. A project's own mago.toml always wins, so a team can agree on levels in it.
        </p>
      )}

      <h3 className="settings-section">By category</h3>
      <div className="mago-grid">
        {CATEGORIES.map(([key, label, help]) => (
          <div key={key} className="mago-row" title={help}>
            <span>
              {label}
              <span className="muted mago-help"> · {help}</span>
            </span>
            <LevelSelect label={`${label} level`} value={value.categories[key]} onChange={(l) => setCategory(key, l)} />
          </div>
        ))}
      </div>

      <h3 className="settings-section">Rules</h3>
      <p className="muted settings-help">A rule's own level wins over its category.</p>
      <div className="mago-rules">
        {Object.keys(value.rules).length === 0 && <div className="muted">No rule has its own level.</div>}
        {Object.entries(value.rules)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, level]) => {
            const r = byCode.get(code);
            return (
              <div key={code} className="mago-row" title={r?.description}>
                <span>
                  <span className="mono">{code}</span>
                  {r && <span className="muted mago-help"> · {CATEGORIES.find(([k]) => k === r.category)?.[1] ?? r.category}</span>}
                </span>
                <LevelSelect label={`${code} level`} value={level} onChange={(l) => setRule(code, l)} />
                <button type="button" className="icon-btn small" aria-label={`Remove ${code}`} title="Back to its category's level" onClick={() => setRule(code, undefined)}>
                  <Icon name="close" size={10} />
                </button>
              </div>
            );
          })}
      </div>
      <div className="settings-row mago-add">
        <div className="field" style={{ width: 280 }}>
          <input list="mago-rule-codes" value={adding} placeholder="Add a rule: its code, e.g. no-empty" aria-label="Rule code" spellCheck={false} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <datalist id="mago-rule-codes">
            {rules
              .filter((r) => !(r.code in value.rules))
              .map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}
                </option>
              ))}
          </datalist>
        </div>
        <button type="button" className="btn small" disabled={!byCode.has(adding.trim()) || adding.trim() in value.rules} onClick={add}>
          Add
        </button>
      </div>
    </>
  );
}

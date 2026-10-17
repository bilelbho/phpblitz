// Help ▸ About PHPBlitz and Help ▸ Open Source Licenses: who made it, its license, and every open
// source package it is built on (with their full license texts, which must ship with the app).

import { useEffect, useMemo, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../platform';
import { Logo } from './Icon';
import packages from '../thirdParty.json';

const REPO = 'https://github.com/bilelbho/phpblitz';

interface Package {
  ecosystem: string;
  name: string;
  version: string;
  license: string;
  repository: string;
  author: string;
}

function openLink(url: string) {
  if (isTauri) void invoke('open_external', { url }).catch(() => {});
  else window.open(url, '_blank', 'noopener');
}

export function AboutDialog({ view: initial, onClose }: { view: 'about' | 'licenses'; onClose: () => void }) {
  const [view, setView] = useState(initial);
  const [version, setVersion] = useState('');
  useEffect(() => {
    if (isTauri) getVersion().then(setVersion, () => {});
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="jb-dialog about-dialog" role="dialog" aria-modal="true" aria-label={view === 'about' ? 'About PHPBlitz' : 'Open Source Licenses'} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        {view === 'about' ? (
          <div className="about-body">
            <Logo size={48} />
            <div className="about-name">PHPBlitz</div>
            <div className="muted">{version ? `Version ${version}` : 'A fast, open source PHP IDE'}</div>
            <p>
              Copyright © 2026 The PHPBlitz Authors.
              <br />
              Open source under the{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), openLink('https://www.apache.org/licenses/LICENSE-2.0'))}>
                Apache License 2.0
              </a>
              : free to use, change and share, commercially too, as long as the NOTICE with the author's name is kept.
            </p>
            <p>
              Built on {(packages as Package[]).length} open source packages, among them Tauri, Monaco Editor, Mago, xterm.js and React. Thank you to their authors and
              contributors.
            </p>
            <p className="muted about-small">
              PHPBlitz is an independent project, not affiliated with, endorsed or sponsored by JetBrains s.r.o. PhpStorm, IntelliJ IDEA and JetBrains are trademarks of
              JetBrains s.r.o.
            </p>
          </div>
        ) : (
          <Licenses />
        )}
        <div className="jb-dialog-buttons">
          <button type="button" className="link-btn" style={{ marginRight: 'auto' }} onClick={() => openLink(REPO)}>
            Source code on GitHub
          </button>
          <button type="button" className="btn" onClick={() => setView(view === 'about' ? 'licenses' : 'about')}>
            {view === 'about' ? 'Open Source Licenses' : 'About'}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Licenses() {
  const [query, setQuery] = useState('');
  const [texts, setTexts] = useState<string | null>(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (packages as Package[]).filter((p) => !q || `${p.name} ${p.license} ${p.author}`.toLowerCase().includes(q));
  }, [query]);
  const byLicense = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of packages as Package[]) counts[p.license] = (counts[p.license] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, []);

  const showTexts = async () => {
    // The full notices (about 1 MB of text): loaded only when asked for.
    const mod = await import('../../THIRD_PARTY_NOTICES.md?raw');
    setTexts(mod.default);
  };

  if (texts !== null) {
    return (
      <div className="licenses-body">
        <button type="button" className="link-btn" onClick={() => setTexts(null)}>
          ← Back to the list
        </button>
        <pre className="licenses-text">{texts}</pre>
      </div>
    );
  }
  return (
    <div className="licenses-body">
      <div className="muted">
        PHPBlitz includes {(packages as Package[]).length} open source packages. Each is used under its own license:{' '}
        {byLicense
          .slice(0, 6)
          .map(([l, n]) => `${l} (${n})`)
          .join(', ')}
        …
      </div>
      <div className="field">
        <input placeholder="Search packages or licenses" value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} autoFocus />
      </div>
      <div className="licenses-list" role="list">
        {list.map((p) => (
          <div key={`${p.ecosystem}:${p.name}@${p.version}`} className="licenses-row" role="listitem">
            <span className="licenses-name">
              {p.name} <span className="muted">{p.version}</span>
            </span>
            <span className="muted licenses-kind">{p.ecosystem === 'npm' ? 'npm' : 'crate'}</span>
            <span className="licenses-license">{p.license}</span>
            {p.repository ? (
              <a href="#" onClick={(e) => (e.preventDefault(), openLink(p.repository))} title={p.repository}>
                source
              </a>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void showTexts()}>
        Show full license texts
      </button>
    </div>
  );
}

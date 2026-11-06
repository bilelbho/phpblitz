// Settings ▸ Version Control ▸ Issue Navigation: patterns in commit messages that link to issues.

import { useEffect, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { linkify, remoteIssueLink, type IssueLink } from '../git/issueLinks';
import { Icon } from './Icon';

const EXAMPLE = 'Fix #12 and SHOP-7';

export function IssueNavigationPage({ ws, value, onChange }: { ws: Workspace; value: IssueLink[]; onChange: (links: IssueLink[]) => void }) {
  const [origin, setOrigin] = useState<IssueLink | null>(null);
  const [sample, setSample] = useState(EXAMPLE);
  useEffect(() => {
    void ws.gitRepo.remoteUrl().then((url) => setOrigin(url ? remoteIssueLink(url) : null));
  }, [ws.gitRepo]);
  const set = (i: number, patch: Partial<IssueLink>) => onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const invalid = (pattern: string) => {
    try {
      new RegExp(pattern);
      return false;
    } catch {
      return true;
    }
  };

  return (
    <>
      <p className="muted settings-help">
        Matches of these regular expressions in commit messages (Git log) become links. In the link, <code>$0</code> is the whole match and <code>$1</code>, <code>$2</code>… its groups.
      </p>
      {origin && (
        <p className="muted settings-help">
          <code>#123</code> already links to the issues of this project's origin (<span className="mono">{origin.url.replace('$1', '123')}</span>).
        </p>
      )}

      <div className="issue-links">
        <div className="issue-links-head muted">
          <span>Issue pattern</span>
          <span>Link</span>
          <span />
        </div>
        {value.map((l, i) => (
          <div key={i} className="issue-links-row">
            <div className={'field' + (invalid(l.pattern) ? ' invalid' : '')}>
              <input className="mono" value={l.pattern} placeholder="[A-Z][A-Z0-9]+-\d+" aria-label="Issue pattern" spellCheck={false} onChange={(e) => set(i, { pattern: e.target.value })} />
            </div>
            <div className={'field' + (l.url && !/^https?:\/\//i.test(l.url) ? ' invalid' : '')}>
              <input className="mono" value={l.url} placeholder="https://tracker.example.com/browse/$0" aria-label="Link" spellCheck={false} onChange={(e) => set(i, { url: e.target.value })} />
            </div>
            <button type="button" className="icon-btn small" aria-label="Remove pattern" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
        {!value.length && <div className="muted">No patterns of your own.</div>}
      </div>
      <button type="button" className="btn" onClick={() => onChange([...value, { pattern: '', url: '' }])}>
        Add Pattern
      </button>

      <h3 className="settings-section">Try it</h3>
      <div className="field">
        <input value={sample} aria-label="Sample commit message" spellCheck={false} onChange={(e) => setSample(e.target.value)} />
      </div>
      <div className="issue-links-preview">
        {linkify(sample, [...value, ...(origin ? [origin] : [])]).map((p, i) =>
          typeof p === 'string' ? (
            <span key={i}>{p}</span>
          ) : (
            <a key={i} className="issue-link" title={p.url}>
              {p.text}
            </a>
          ),
        )}
      </div>
    </>
  );
}

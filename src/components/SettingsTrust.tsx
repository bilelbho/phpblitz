// Settings ▸ Trusted Projects: whether projects not trusted yet open in Restricted Mode, and the
// folders trusted so far (each with every project in it).

import { trustFolder, untrustFolder, useTrustedFolders } from '../trust';
import { pickFolder } from '../platform';
import { Icon } from './Icon';

export function TrustPage({ restrictedMode, onChange, highlight }: { restrictedMode: boolean; onChange: (restrictedMode: boolean) => void; highlight: string }) {
  const folders = useTrustedFolders();
  const hit = (label: string) => (highlight && label.toLowerCase().includes(highlight) ? ' hit' : '');
  const label = 'Ask before trusting a project (Restricted Mode)';
  return (
    <>
      <div className="settings-checks" style={{ gap: 14 }}>
        <div>
          <label className={'settings-check' + hit(label)}>
            <input type="checkbox" className="checkbox" checked={restrictedMode} onChange={(e) => onChange(e.target.checked)} />
            {label}
          </label>
          <div className="muted settings-help">
            A project you haven't trusted opens in Restricted Mode: PHPBlitz reads and analyzes its code, but runs no program in it (Git, PHP, Composer, tests, language
            servers) until you trust it. Code you download can configure those tools to run commands. The terminal still works: it runs only what you type. Turned off,
            every project is trusted.
          </div>
        </div>
      </div>

      <h3 className="settings-section">Trusted folders</h3>
      <div className="muted settings-help" style={{ marginBottom: 8 }}>
        Each folder is trusted with every project inside it.
      </div>
      <div className="trust-list" role="list" aria-label="Trusted folders">
        {folders.length === 0 && <div className="muted trust-empty">No trusted folders yet.</div>}
        {folders.map((f) => (
          <div key={f} className="trust-row" role="listitem">
            <Icon name="folder" size={14} />
            <span className="trust-path" title={f}>
              {f}
            </span>
            <button type="button" className="icon-btn small" aria-label={`Stop trusting ${f}`} title="Stop trusting" onClick={() => untrustFolder(f)}>
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn"
        style={{ marginTop: 10 }}
        onClick={async () => {
          const path = await pickFolder();
          if (path) trustFolder(path);
        }}
      >
        Add Folder…
      </button>
      <div className="muted settings-help" style={{ marginTop: 12 }}>
        A folder you stop trusting takes effect the next time its projects open.
      </div>
    </>
  );
}

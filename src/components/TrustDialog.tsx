// "Do you trust this project?": asked before a project you haven't trusted opens (App.tsx), and
// from Restricted Mode in the status bar. Trusting it, or the folder it's in, lets PHPBlitz run
// programs in it (trust.ts).

import { useEffect, useRef, useState } from 'react';
import { trustFolder } from '../trust';

/** The path with the home folder as ~ and the OS's separators. */
function shown(path: string): string {
  const win = /^[a-z]:/i.test(path);
  const p = path.replace(/^([a-z]:)?\/users\/[^/]+/i, '~').replace(/^\/home\/[^/]+/, '~');
  return win ? p.replace(/\//g, '\\') : p;
}

export function TrustDialog({ root, onTrust, onRestricted }: { root: string; onTrust: () => void; onRestricted: () => void }) {
  const parent = root.replace(/\\/g, '/').replace(/\/[^/]+\/?$/, '');
  const [all, setAll] = useState(false);
  const trustBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => trustBtn.current?.focus(), []);

  const trust = () => {
    trustFolder(all && parent ? parent : root);
    onTrust();
  };

  return (
    <div className="modal-backdrop">
      <div
        className="pb-dialog trust-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="trust-title"
        aria-describedby="trust-why"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onRestricted();
          else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') trust();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="trust-head">
          <svg className="trust-warn" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 2 14.5 13.5h-13z" />
            <path d="M8 6.5v3.2M8 11.6h.01" strokeLinecap="round" />
          </svg>
          <div>
            <div id="trust-title" className="trust-title">
              Do you trust this project?
            </div>
            <div className="trust-path" title={root}>
              {shown(root)}
            </div>
          </div>
        </div>
        <div className="pb-dialog-body trust-body">
          <p id="trust-why">
            Projects you haven't trusted open in Restricted Mode to protect your computer: a project can set up Git, PHP, Composer or its tests to run commands of its own.
          </p>
          <div className="muted">Restricted Mode prevents:</div>
          <ul>
            <li>Git, PHP, Composer and test runs from starting</li>
            <li>Language servers from running</li>
          </ul>
          <div className="muted">Reading, editing, search and Mago's analysis work as usual, and so does the terminal.</div>
          {parent && (
            <label className="trust-all">
              <input type="checkbox" className="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              Trust all projects in <span className="trust-folder">{shown(parent)}</span>
            </label>
          )}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={onRestricted}>
            Stay in Restricted Mode
          </button>
          <button ref={trustBtn} type="button" className="btn primary" onClick={trust}>
            Trust and Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// Help ▸ Diagnostic Tools ▸ Error Log: panels that crashed and background work that failed, newest
// first, with Copy All for a bug report.

import { useState } from 'react';
import { clearErrors, errorReport, systemLine, useErrorLog } from '../errorLog';
import { Icon } from './Icon';

export function ErrorLogDialog({ onClose }: { onClose: () => void }) {
  const entries = useErrorLog();
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const show = (result: 'yes' | 'failed') => {
    setCopied(result);
    window.setTimeout(() => setCopied(null), 1500);
  };
  const copy = () =>
    navigator.clipboard.writeText(errorReport()).then(
      () => show('yes'),
      () => show('failed'),
    );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pb-dialog error-log" role="dialog" aria-modal="true" aria-label="Error Log" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="ai-dialog-title">
          <Icon name="warning" size={14} />
          Error Log
          <span className="muted ai-dialog-sub">{systemLine()}</span>
        </div>
        <div className="error-log-list">
          {!entries.length && <div className="muted error-log-empty">No errors in this session.</div>}
          {[...entries].reverse().map((e) => (
            <div key={e.id} className="error-log-item">
              <button type="button" className="error-log-head" onClick={() => setOpen((o) => (o === e.id ? null : e.id))} aria-expanded={open === e.id}>
                <Icon name={open === e.id ? 'chevronDown' : 'chevronRight'} size={12} />
                <span className="muted mono">{e.time.toLocaleTimeString()}</span>
                <span className="error-log-where">{e.where}</span>
                <span className="error-log-message">{e.message}</span>
              </button>
              {open === e.id && e.stack && <pre className="error-log-stack">{e.stack}</pre>}
            </div>
          ))}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="link-btn" style={{ marginRight: 'auto' }} disabled={!entries.length} onClick={clearErrors}>
            Clear
          </button>
          <button type="button" className="btn primary" disabled={!entries.length} onClick={copy}>
            {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy All'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

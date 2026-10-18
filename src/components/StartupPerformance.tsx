// Help ▸ Startup Performance: the stages of opening this project as a waterfall, with what each
// one handled, and a plain-text copy to send when a project opens slowly.

import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { isTauri } from '../platform';
import { perf, usePerf, windowReadyMs, type Span } from '../perf';

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${n} ms`);

export function StartupPerformance({ onClose }: { onClose: () => void }) {
  const p = usePerf();
  const [version, setVersion] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (isTauri) getVersion().then(setVersion, () => {});
  }, []);

  const spans = [...p.spans].sort((a, b) => a.start - b.start);
  const now = Math.max(1, ...spans.map((s) => s.end ?? s.start));
  const running = spans.some((s) => s.end === null);
  const ready = windowReadyMs();

  const report = () =>
    [
      `PHPBlitz ${version || '(browser)'} · ${navigator.userAgent.includes('Windows') ? 'Windows' : navigator.userAgent.includes('Mac') ? 'macOS' : 'Linux'} · ${navigator.hardwareConcurrency} cores`,
      `Project: ${p.project}`,
      ready !== null ? `Window ready ${ms(ready)} after launch` : '',
      '',
      'Start      Took      Stage',
      ...spans.map((s) => `${`+${ms(s.start)}`.padEnd(10)} ${(s.end === null ? 'running' : s.end === s.start ? '·' : ms(s.end - s.start)).padEnd(9)} ${s.name}${s.detail ? ` (${s.detail})` : ''}`),
    ]
      .filter((l, i) => l || i > 2)
      .join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The text is on screen to select by hand.
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pb-dialog perf-dialog" role="dialog" aria-modal="true" aria-labelledby="perf-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="pb-dialog-title" id="perf-title">
          Startup Performance
        </div>
        <div className="pb-dialog-body perf-body">
          <div className="muted">
            Opening <b>{p.project || 'this project'}</b>
            {ready !== null && <> · the window was ready {ms(ready)} after launch</>}
            {running ? ' · still working…' : ` · all done in ${ms(now)}`}
          </div>
          <div className="perf-table" role="table">
            <div className="perf-row perf-head" role="row">
              <span>Stage</span>
              <span>Start</span>
              <span>Took</span>
              <span />
            </div>
            {spans.map((s, i) => (
              <Row key={i} s={s} total={now} />
            ))}
            {!spans.length && <div className="empty">Nothing measured yet: open a project folder.</div>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Stages run in parallel where they can. If a project opens slowly, copy this report and send it with the project's size.
          </div>
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy Report'}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ s, total }: { s: Span; total: number }) {
  const end = s.end ?? total;
  const took = end - s.start;
  return (
    <div className="perf-row" role="row" title={s.detail}>
      <span className="perf-name">
        {s.name}
        {s.detail && <span className="muted"> · {s.detail}</span>}
      </span>
      <span className="muted">+{ms(s.start)}</span>
      <span className={took >= 2000 ? 'perf-slow' : ''}>{s.end === null ? 'running…' : s.end === s.start ? '·' : ms(took)}</span>
      <span className="perf-track">
        <span className={'perf-bar' + (s.end === null ? ' running' : '') + (s.end === s.start ? ' instant' : '')} style={{ left: `${(s.start / total) * 100}%`, width: s.end === s.start ? undefined : `${Math.max(0.5, (took / total) * 100)}%` }} />
      </span>
    </div>
  );
}

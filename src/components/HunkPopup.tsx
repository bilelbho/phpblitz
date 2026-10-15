// Click on a change marker in the gutter: what the lines were in HEAD, with Rollback and Show Diff.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Hunk } from '../git/diff';
import { colorizeCode } from '../editor/markdown';
import { Icon } from './Icon';

interface Props {
  x: number;
  y: number;
  hunk: Hunk;
  index: number;
  total: number;
  language: string;
  onMove: (dir: 1 | -1) => void;
  onRollback: () => void;
  onDiff: () => void;
  onClose: () => void;
}

const LANG_FENCE: Record<string, string> = { php: 'php', javascript: 'js', typescript: 'ts', json: 'json', css: 'css', html: 'html', markdown: 'md', yaml: 'yaml', sql: 'sql', shell: 'bash', ini: 'ini', xml: 'xml' };

export function HunkPopup({ x, y, hunk, index, total, language, onMove, onRollback, onDiff, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    if (!hunk.oldLines.length) return;
    let live = true;
    colorizeCode(hunk.oldLines.join('\n'), LANG_FENCE[language] ?? '').then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [hunk, language]);

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height - 8) : y });
  }, [x, y, html]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', outside, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', outside, true);
    };
  }, [onClose]);

  const what = hunk.kind === 'added' ? `${hunk.count} added line${hunk.count === 1 ? '' : 's'}` : hunk.kind === 'deleted' ? `${hunk.oldLines.length} deleted line${hunk.oldLines.length === 1 ? '' : 's'}` : `${hunk.oldLines.length} → ${hunk.count} changed lines`;

  return (
    <div ref={box} className="hunk-popup" style={pos} role="dialog" aria-label="Change">
      <div className="hunk-bar">
        <button type="button" className="icon-btn small" title="Previous Change" aria-label="Previous change" disabled={total < 2} onClick={() => onMove(-1)}>
          <Icon name="chevronUp" size={13} strokeWidth={2.4} />
        </button>
        <button type="button" className="icon-btn small" title="Next Change" aria-label="Next change" disabled={total < 2} onClick={() => onMove(1)}>
          <Icon name="chevronDown" size={13} strokeWidth={2.4} />
        </button>
        <button type="button" className="icon-btn small" title="Rollback" aria-label="Rollback" onClick={onRollback}>
          <Icon name="rollback" size={13} />
        </button>
        <button type="button" className="icon-btn small" title="Show Diff" aria-label="Show diff" onClick={onDiff}>
          <Icon name="columns" size={13} />
        </button>
        {hunk.oldLines.length > 0 && (
          <button type="button" className="icon-btn small" title="Copy Old Text" aria-label="Copy old text" onClick={() => navigator.clipboard.writeText(hunk.oldLines.join('\n')).catch(() => {})}>
            <Icon name="copy" size={13} />
          </button>
        )}
        <span className="grow" />
        <span className="muted hunk-what">
          {what} · {index + 1} of {total}
        </span>
      </div>
      {hunk.oldLines.length > 0 ? (
        <pre className="hunk-old">
          {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : hunk.oldLines.join('\n')}
        </pre>
      ) : (
        <div className="muted hunk-none">New lines: nothing here in HEAD.</div>
      )}
    </div>
  );
}

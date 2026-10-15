import { useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { paramTypes, type PhpSymbol } from '../php';
import { Icon, Sym, Visibility } from './Icon';

// Letters and colors of JetBrains' structure icons.
export const SYMBOL_KIND: Record<PhpSymbol['kind'], [string, string]> = {
  class: ['c', '#548af7'],
  interface: ['i', '#5fb865'],
  trait: ['t', '#d5b778'],
  enum: ['e', '#548af7'],
  method: ['m', '#e55765'],
  function: ['ƒ', '#e55765'],
  property: ['f', '#e5a33d'],
  const: ['c', '#2aacb8'],
  use: ['t', '#d5b778'],
};

export function symbolLabel(s: PhpSymbol): string {
  const type = s.detail ? `: ${s.detail.split('\\').pop()}` : '';
  switch (s.kind) {
    case 'method':
    case 'function':
      return `${s.name}(${paramTypes(s.params)})${s.name === '__construct' ? '' : type}`;
    case 'property':
      return `${s.name}${type}`;
    case 'use':
      return s.name.split('\\').pop() ?? s.name;
    default:
      return s.name;
  }
}

export function StructurePanel({ ws }: { ws: Workspace }) {
  const [collapsed, setCollapsed] = useState(false);
  const path = ws.activePath;
  if (!path) return <div className="empty">Open a file to see its structure.</div>;
  if (!path.endsWith('.php')) return <div className="empty">Structure is available for PHP files.</div>;
  if (!ws.structure.length) return <div className="empty">No classes or functions found in this file.</div>;

  // The member the caret is in.
  const current = [...ws.structure].reverse().find((s) => s.line <= ws.cursor.line && s.depth > 0);
  const go = (s: PhpSymbol) => ws.setGoto({ path, line: s.line, nonce: Date.now() });

  return (
    <div className="panel-body tree" role="tree" aria-label="File structure">
      {ws.structure.map((s) => {
        if (s.depth > 0 && collapsed) return null;
        const [letter, color] = SYMBOL_KIND[s.kind];
        const isClass = s.depth === 0 && s.kind !== 'function';
        return (
          <div
            key={`${s.kind}:${s.line}`}
            className={'row' + (current === s ? ' selected' : '')}
            style={{ paddingLeft: 4 + s.depth * 22 }}
            title={`${s.visibility} ${s.kind} · line ${s.line}`}
          >
            {isClass ? (
              <button type="button" className={'chev' + (collapsed ? '' : ' open')} aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed((c) => !c)}>
                <Icon name="chevronRight" size={12} strokeWidth={2.5} />
              </button>
            ) : (
              <span style={{ width: 12, flex: 'none' }} />
            )}
            <button type="button" style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }} onClick={() => go(s)}>
              <Sym letter={letter} color={color} />
              <Visibility value={s.visibility} />
              <span className="name" style={{ marginLeft: 2 }}>
                {symbolLabel(s)}
              </span>
              {s.kind === 'class' && s.detail && <span className="detail">{s.detail}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

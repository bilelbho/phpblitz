// "+" ▸ New File / PHP Class / Directory dialogs.

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { relativePath } from '../backend/types';
import { fileNameProblem } from '../fileNames';

export type NewKind = 'file' | 'class' | 'dir';
type ClassKind = 'class' | 'interface' | 'trait' | 'enum';

const TITLES: Record<NewKind, string> = { file: 'New File', class: 'New PHP Class', dir: 'New Directory' };
const PHP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Namespace for a folder from composer.json's PSR-4 autoload maps ("App\\" => "app/"). */
async function namespaceFor(ws: Workspace, dir: string): Promise<string> {
  try {
    const json = JSON.parse(await ws.backend.readFile(`${ws.backend.root}/composer.json`));
    const rel = dir === ws.backend.root ? '' : relativePath(ws.backend, dir);
    let best: { prefix: string; base: string } | null = null;
    for (const section of ['autoload', 'autoload-dev']) {
      for (const [prefix, dirs] of Object.entries<string | string[]>(json[section]?.['psr-4'] ?? {})) {
        for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
          const base = d.replace(/\/+$/, '');
          const inside = base === '' || rel === base || rel.startsWith(base + '/');
          if (inside && (!best || base.length > best.base.length)) best = { prefix, base };
        }
      }
    }
    if (!best) return '';
    const rest = rel.slice(best.base.length).replace(/^\//, '');
    return [best.prefix.replace(/\\+$/, ''), ...rest.split('/').filter(Boolean)].filter(Boolean).join('\\');
  } catch {
    return '';
  }
}

function classTemplate(kind: ClassKind, name: string, namespace: string) {
  return `<?php\n\ndeclare(strict_types=1);\n\n${namespace ? `namespace ${namespace};\n\n` : ''}${kind === 'class' ? 'final class' : kind} ${name}\n{\n}\n`;
}

export function NewItemDialog({ ws, kind, dir, onClose, onCreated }: { ws: Workspace; kind: NewKind; dir: string; onClose: () => void; onCreated: (path: string) => void }) {
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('');
  const [classKind, setClassKind] = useState<ClassKind>('class');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    if (kind === 'class') namespaceFor(ws, dir).then(setNamespace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const where = dir === ws.backend.root ? ws.backend.name : relativePath(ws.backend, dir);

  const create = async () => {
    const trimmed = name.trim().replace(/\\/g, '/');
    if (!trimmed) return setError('Enter a name.');
    const problem = trimmed
      .split('/')
      .map(fileNameProblem)
      .find((p) => p);
    if (problem) return setError(problem);
    if (kind === 'class') {
      const className = trimmed.replace(/\.php$/, '');
      if (!PHP_NAME.test(className)) return setError('A class name must be a valid PHP identifier.');
      if (namespace && !namespace.split('\\').every((p) => PHP_NAME.test(p))) return setError('Invalid namespace.');
    }
    setBusy(true);
    setError('');
    try {
      if (kind === 'dir') {
        const path = `${dir}/${trimmed}`;
        await ws.backend.createDir(path);
        onCreated(path);
      } else {
        const fileName = kind === 'class' ? `${trimmed.replace(/\.php$/, '')}.php` : trimmed;
        const path = `${dir}/${fileName}`;
        const content = kind === 'class' ? classTemplate(classKind, trimmed.replace(/\.php$/, ''), namespace) : '';
        await ws.backend.createFile(path, content);
        onCreated(path);
      }
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="pb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-item-title"
        style={{ width: kind === 'class' ? 420 : 360 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter') create();
        }}
      >
        <div className="pb-dialog-title" id="new-item-title">
          {TITLES[kind]}
        </div>
        <div className="pb-dialog-body">
          <span className="muted" style={{ fontSize: 12 }}>
            In {where}
          </span>
          <label htmlFor="new-item-name">Name:</label>
          <div className={'field' + (error ? ' invalid' : '')}>
            <input
              id="new-item-name"
              ref={input}
              value={name}
              spellCheck={false}
              placeholder={kind === 'class' ? 'UserService' : kind === 'dir' ? 'Services' : 'routes/api.php'}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
            />
          </div>
          {kind === 'class' && (
            <>
              <label htmlFor="new-item-namespace">Namespace:</label>
              <div className="field">
                <input id="new-item-namespace" value={namespace} spellCheck={false} onChange={(e) => setNamespace(e.target.value)} />
              </div>
              <label htmlFor="new-item-kind">Template:</label>
              <select id="new-item-kind" className="field select" value={classKind} onChange={(e) => setClassKind(e.target.value as ClassKind)}>
                <option value="class">Class</option>
                <option value="interface">Interface</option>
                <option value="trait">Trait</option>
                <option value="enum">Enum</option>
              </select>
            </>
          )}
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="pb-dialog-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={create} disabled={busy}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

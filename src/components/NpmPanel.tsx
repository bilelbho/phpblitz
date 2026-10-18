// The npm tool window: every package.json in the project (the PHP project's own
// front end and the JS projects inside it) with its scripts. Running a script opens a terminal tab
// in that folder and runs it with the project's package manager.

import { useEffect, useMemo, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { findJsProjects } from '../jsProjects';
import { relativePath } from '../backend/types';
import { terminals } from '../terminal/manager';
import { isTauri } from '../platform';
import { Icon } from './Icon';

interface NpmProject {
  root: string;
  manifest: string;
  name: string;
  scripts: [string, string][];
  /** npm, yarn, pnpm or bun, from the lock file. */
  manager: string;
  installed: boolean;
}

const LOCK_FILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

export function NpmPanel({ ws }: { ws: Workspace }) {
  const manifests = useMemo(() => findJsProjects(ws.files).filter((p) => p.manifest), [ws.files]);
  const [projects, setProjects] = useState<NpmProject[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    const files = new Set(ws.files);
    void Promise.all(
      manifests.map(async (p): Promise<NpmProject | null> => {
        const json = await ws.backend
          .readFile(p.manifest!)
          .then((t) => JSON.parse(t) as { name?: string; scripts?: Record<string, string> })
          .catch(() => null);
        if (!json) return null;
        // A workspace package uses the lock file of the folders above it.
        const lock = LOCK_FILES.find(([file]) => [...ancestors(p.root, ws.backend.root)].some((dir) => files.has(`${dir}/${file}`)));
        const entries = await ws.backend.listDir(p.root).catch(() => []);
        return {
          root: p.root,
          manifest: p.manifest!,
          name: json.name || (p.root === ws.backend.root ? ws.backend.name : relativePath(ws.backend, p.root)),
          scripts: Object.entries(json.scripts ?? {}),
          manager: lock?.[1] ?? 'npm',
          installed: entries.some((e) => e.isDir && e.name === 'node_modules'),
        };
      }),
    ).then((list) => live && setProjects(list.filter((p): p is NpmProject => !!p)));
    return () => {
      live = false;
    };
  }, [manifests, ws.backend, ws.files]);

  const run = async (p: NpmProject, command: string) => {
    if (!isTauri || ws.backend.kind !== 'disk') {
      ws.setStatus(`Running ${command} needs the desktop app.`);
      return;
    }
    ws.showBottom('terminal');
    // A tab of its own in the package's folder, named after the script.
    await terminals.create({ cwd: p.root });
    await terminals.run(command, p.root);
  };
  const runScript = (p: NpmProject, script: string) => run(p, p.manager === 'npm' ? `npm run ${script}` : `${p.manager} ${p.manager === 'bun' ? 'run ' : ''}${script}`);

  if (!manifests.length) return <div className="empty">This project has no package.json.</div>;
  if (!projects) return <div className="empty">Reading package.json files…</div>;
  return (
    <div className="panel-body list npm-panel">
      {projects.map((p) => {
        const open = !collapsed.has(p.root);
        const where = p.root === ws.backend.root ? '' : relativePath(ws.backend, p.root);
        return (
          <div key={p.root} className="npm-project">
            <div
              className="list-item npm-head"
              onDoubleClick={() => ws.openFile(p.manifest)}
              onClick={() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(p.root)) next.delete(p.root);
                  else next.add(p.root);
                  return next;
                })
              }
            >
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
              <Icon name="npm" />
              <span className="npm-name" title={where || 'project root'}>
                {p.name}
                {where && where !== p.name && <span className="muted npm-where"> {where}</span>}
              </span>
              <button type="button" className="icon-btn small npm-open" title="Open package.json (or double-click)" onClick={(e) => (e.stopPropagation(), ws.openFile(p.manifest))}>
                <Icon name="goTo" size={14} />
              </button>
            </div>
            {open && !p.installed && (
              <div className="list-item npm-script npm-missing">
                <span className="muted npm-command">node_modules is missing</span>
                <button
                  type="button"
                  className="btn small primary npm-install"
                  title={`Run ${p.manager} install: completion for the packages needs them`}
                  onClick={() => void run(p, `${p.manager} install`)}
                >
                  Install
                </button>
              </div>
            )}
            {open &&
              (p.scripts.length ? (
                p.scripts.map(([name, command]) => (
                  <div key={name} className="list-item npm-script" title={`${command}\nDouble-click to run`} onDoubleClick={() => void runScript(p, name)}>
                    <span className="npm-script-name">{name}</span>
                    <span className="mono muted npm-command">{command}</span>
                    <button type="button" className="icon-btn small" title={`Run ${name}`} onClick={() => void runScript(p, name)}>
                      <Icon name="run" size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="list-item npm-script muted">No scripts</div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** `dir` and its parents up to the project root. */
function* ancestors(dir: string, root: string) {
  for (let d = dir; d.length >= root.length; d = d.slice(0, d.lastIndexOf('/'))) {
    yield d;
    if (!d.includes('/')) return;
  }
}

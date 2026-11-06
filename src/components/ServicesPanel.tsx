// Services tool window: Docker. The project's Compose services (up, down, each one started,
// stopped, restarted), every container and image, and for the selected one its log as it's
// written, or what `docker inspect` says about it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from '../useWorkspace';
import { runJob } from '../jobs';
import { confirmDialog, isTauri } from '../platform';
import { COMPOSE_FILES, docker, dockerError, loadDocker, type Container, type DockerState, type Image } from '../docker/docker';
import { HideToolButton, useHideTool } from './toolHide';
import { CodeView } from './CodeView';
import { Icon, type IconName } from './Icon';

type Selection = { kind: 'compose' } | { kind: 'service'; name: string } | { kind: 'container'; id: string } | { kind: 'image'; id: string } | null;
type Tab = 'log' | 'inspect' | 'output';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const MAX_LOG = 5000;
/** Refresh while the window is open. */
const POLL_MS = 5000;

const stateClass = (c: Container | null) => (!c ? 'none' : c.state === 'running' ? 'running' : c.state === 'paused' || c.state === 'restarting' ? 'paused' : 'stopped');

export function ServicesPanel({ ws }: { ws: Workspace }) {
  const hide = useHideTool(() => ws.setBottomOpen(false));
  const root = ws.backend.root;
  const [state, setState] = useState<DockerState | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Selection>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['images']));
  const [tab, setTab] = useState<Tab>('log');
  const [busy, setBusy] = useState<string | null>(null);
  /** The last action's output (compose up pulls images: worth seeing). */
  const [output, setOutput] = useState<string[]>([]);
  const composeFile = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri || ws.backend.kind !== 'disk') {
      setState({ error: 'Docker is used from the desktop app, for a project on this computer.', containers: [], images: [], compose: null });
      return;
    }
    setLoading(true);
    try {
      if (composeFile.current === null) {
        const names = new Set((await ws.backend.listDir(root).catch(() => [])).map((e) => e.name));
        composeFile.current = COMPOSE_FILES.find((f) => names.has(f)) ?? '';
      }
      setState(await loadDocker(root, composeFile.current || null));
    } finally {
      setLoading(false);
    }
  }, [root, ws.backend]);

  useEffect(() => {
    composeFile.current = null;
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (state?.error) return;
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh, state?.error]);

  /** Runs docker with these arguments, its output in the Output tab, then refreshes. */
  const act = async (label: string, args: string[]) => {
    setBusy(label);
    setOutput([`> docker ${args.join(' ')}`]);
    try {
      const id = Date.now() % 1_000_000_000;
      const lines: string[] = [];
      const code = await runJob('job_exec', { id, cwd: root, program: 'docker', args }, (line) => {
        lines.push(line.replace(ANSI, '').replace(/\r?\n$/, ''));
        setOutput([`> docker ${args.join(' ')}`, ...lines.slice(-MAX_LOG)]);
      });
      if (code !== 0) {
        setTab('output');
        ws.setStatus(`${label} failed: ${dockerError({ code, stdout: '', stderr: lines.join('\n') })}`);
      } else ws.setStatus(`${label}: done`);
    } catch (e) {
      setTab('output');
      ws.setStatus(`${label} failed: ${dockerError(e)}`);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const compose = state?.compose ?? null;
  const composeArgs = compose ? ['compose', '-f', compose.file] : [];
  const container: Container | null =
    selected?.kind === 'container'
      ? (state?.containers.find((c) => c.id === selected.id) ?? null)
      : selected?.kind === 'service'
        ? (compose?.services.find((s) => s.name === selected.name)?.container ?? null)
        : null;
  const image: Image | null = selected?.kind === 'image' ? (state?.images.find((i) => i.id === selected.id) ?? null) : null;

  const toggle = (key: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const isSel = (s: Selection) => JSON.stringify(s) === JSON.stringify(selected);
  const others = state?.containers.filter((c) => !compose?.services.some((s) => s.container?.id === c.id)) ?? [];

  const group = (key: string, label: string, icon: IconName, count: number | null, children: React.ReactNode, onSelect?: () => void, selectedNow = false) => (
    <>
      <div className={'svc-row svc-group' + (selectedNow ? ' selected' : '')} role="treeitem" aria-expanded={!collapsed.has(key)} onClick={() => (onSelect ? onSelect() : toggle(key))}>
        <span
          className="svc-twisty"
          onClick={(e) => {
            e.stopPropagation();
            toggle(key);
          }}
        >
          <Icon name={collapsed.has(key) ? 'chevronRight' : 'chevronDown'} size={12} />
        </span>
        <Icon name={icon} size={14} />
        <span className="svc-name">{label}</span>
        {count !== null && <span className="muted svc-count">{count}</span>}
      </div>
      {!collapsed.has(key) && children}
    </>
  );

  const containerRow = (c: Container | null, name: string, sel: Selection, sub: string) => (
    <div key={name} className={'svc-row svc-leaf' + (isSel(sel) ? ' selected' : '')} role="treeitem" aria-selected={isSel(sel)} onClick={() => setSelected(sel)} title={c ? `${c.name} · ${c.image}\n${c.status}` : 'Not created yet: Up starts it'}>
      <span className={'svc-dot ' + stateClass(c)} />
      <span className="svc-name">{name}</span>
      <span className="muted svc-sub">{sub}</span>
    </div>
  );

  return (
    <>
      <div className="tw-head">
        <span className="tw-title">Services</span>
        <span className="grow" />
        {(busy || loading) && <span className="muted svc-busy">{busy ? `${busy}…` : 'Refreshing…'}</span>}
        {compose && (
          <>
            <button type="button" className="icon-btn" aria-label="Compose Up" title={`Up: start the ${compose.file} services (docker compose up -d)`} disabled={!!busy || !!state?.error} onClick={() => void act('Compose up', [...composeArgs, 'up', '-d'])}>
              <Icon name="run" size={14} />
            </button>
            <button type="button" className="icon-btn" aria-label="Compose Down" title="Down: stop and remove the services' containers (docker compose down)" disabled={!!busy || !!state?.error} onClick={() => void act('Compose down', [...composeArgs, 'down'])}>
              <Icon name="stopSquare" size={14} />
            </button>
          </>
        )}
        <button type="button" className="icon-btn" aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void refresh()}>
          <Icon name="refresh" size={14} />
        </button>
        <HideToolButton onHide={hide} />
      </div>
      <div className="svc-wrap">
        <div className="svc-panel">
          <div className="svc-tree" role="tree" aria-label="Docker">
            {state?.error && (
              <div className="svc-error">
                <Icon name="warning" size={13} /> {state.error}
                <button type="button" className="btn small ghost" onClick={() => void refresh()}>
                  Retry
                </button>
              </div>
            )}
            {compose &&
              group(
                'compose',
                `Docker Compose: ${compose.project}`,
                'docker',
                null,
                <>
                  {compose.error && <div className="muted svc-note">{compose.error}</div>}
                  {compose.services.map((s) => containerRow(s.container, s.name, { kind: 'service', name: s.name }, s.container ? s.container.status : 'not created'))}
                </>,
                () => setSelected({ kind: 'compose' }),
                isSel({ kind: 'compose' }),
              )}
            {state &&
              !state.error &&
              group(
                'containers',
                compose ? 'Other Containers' : 'Containers',
                'box',
                others.length,
                others.length ? others.map((c) => containerRow(c, c.name, { kind: 'container', id: c.id }, `${c.image} · ${c.status}`)) : <div className="muted svc-note">None</div>,
              )}
            {state &&
              !state.error &&
              group(
                'images',
                'Images',
                'layers',
                state.images.length,
                state.images.map((i) => (
                  <div key={i.id + i.repository + i.tag} className={'svc-row svc-leaf' + (isSel({ kind: 'image', id: i.id }) ? ' selected' : '')} role="treeitem" onClick={() => setSelected({ kind: 'image', id: i.id })}>
                    <span className="svc-dot image" />
                    <span className="svc-name">{i.repository === '<none>' ? i.id : `${i.repository}:${i.tag}`}</span>
                    <span className="muted svc-sub">
                      {i.size} · {i.created}
                    </span>
                  </div>
                )),
              )}
            {!state && <div className="muted svc-note">Asking Docker…</div>}
          </div>
          <div className="svc-details">
            {selected?.kind === 'compose' && compose ? (
              <>
                <div className="svc-summary">
                  <b>{compose.file}</b>
                  <span className="muted">
                    {compose.services.filter((s) => s.container?.state === 'running').length} of {compose.services.length} running
                  </span>
                  <span className="grow" />
                  <ActionButton icon="run" label="Up" disabled={!!busy || !!state?.error} onClick={() => void act('Compose up', [...composeArgs, 'up', '-d'])} />
                  <ActionButton icon="refresh" label="Restart" disabled={!!busy || !!state?.error} onClick={() => void act('Compose restart', [...composeArgs, 'restart'])} />
                  <ActionButton icon="stopSquare" label="Down" disabled={!!busy || !!state?.error} onClick={() => void act('Compose down', [...composeArgs, 'down'])} />
                </div>
                <Details
                  tab={tab}
                  setTab={setTab}
                  logArgs={state?.error ? null : [...composeArgs, 'logs', '-f', '--tail', '200', '--no-color']}
                  inspect={null}
                  output={output}
                  root={root}
                  logKey={`compose:${compose.file}`}
                />
              </>
            ) : selected?.kind === 'service' && !container ? (
              <>
                <div className="svc-summary">
                  <span className="svc-dot none" />
                  <b>{selected.name}</b>
                  <span className="muted">Not created yet</span>
                  <span className="grow" />
                  <ActionButton icon="run" label="Up" disabled={!!busy || !!state?.error} onClick={() => void act(`Up ${selected.name}`, [...composeArgs, 'up', '-d', selected.name])} />
                </div>
                <Details tab={tab === 'log' ? 'output' : tab} setTab={setTab} logArgs={null} inspect={null} output={output} root={root} logKey="" />
              </>
            ) : container ? (
              <>
                <div className="svc-summary">
                  <span className={'svc-dot ' + stateClass(container)} />
                  <b>{selected?.kind === 'service' ? selected.name : container.name}</b>
                  <span className="muted" title={container.ports}>
                    {container.image} · {container.status}
                    {container.ports ? ` · ${container.ports}` : ''}
                  </span>
                  <span className="grow" />
                  {container.state === 'running' ? (
                    <>
                      <ActionButton icon="stopSquare" label="Stop" disabled={!!busy} onClick={() => void act(`Stop ${container.name}`, ['stop', container.id])} />
                      <ActionButton icon="refresh" label="Restart" disabled={!!busy} onClick={() => void act(`Restart ${container.name}`, ['restart', container.id])} />
                      <ActionButton icon="copy" label="Copy exec" title="Copy a command that opens a shell in it" disabled={false} onClick={() => void navigator.clipboard?.writeText(`docker exec -it ${container.name} sh`).then(() => ws.setStatus('Copied: paste it in the Terminal'))} />
                    </>
                  ) : (
                    <ActionButton icon="run" label="Start" disabled={!!busy} onClick={() => void act(`Start ${container.name}`, ['start', container.id])} />
                  )}
                  <ActionButton
                    icon="trash"
                    label="Remove"
                    disabled={!!busy}
                    onClick={async () => {
                      if (await confirmDialog(`Remove the container ${container.name}?${container.state === 'running' ? ' It is running: it will be stopped first.' : ''} Its own files go with it (volumes stay).`))
                        void act(`Remove ${container.name}`, ['rm', '-f', container.id]);
                    }}
                  />
                </div>
                <Details tab={tab} setTab={setTab} logArgs={['logs', '-f', '--tail', '500', container.id]} inspect={['inspect', container.id]} output={output} root={root} logKey={container.id} />
              </>
            ) : image ? (
              <>
                <div className="svc-summary">
                  <span className="svc-dot image" />
                  <b>{image.repository === '<none>' ? image.id : `${image.repository}:${image.tag}`}</b>
                  <span className="muted">
                    {image.id} · {image.size} · {image.created}
                  </span>
                  <span className="grow" />
                  <ActionButton
                    icon="trash"
                    label="Remove"
                    disabled={!!busy}
                    onClick={async () => {
                      if (await confirmDialog(`Remove the image ${image.repository}:${image.tag}? Docker refuses while a container uses it.`)) void act(`Remove image ${image.repository}:${image.tag}`, ['rmi', image.id]);
                    }}
                  />
                </div>
                <Details tab={tab === 'log' ? 'inspect' : tab} setTab={setTab} logArgs={null} inspect={['image', 'inspect', image.id]} output={output} root={root} logKey="" />
              </>
            ) : (
              <div className="empty">
                {state?.error ? 'Docker isn’t available' : 'Select a service, container or image'}
                {output.length > 1 && <pre className="svc-log svc-output">{output.join('\n')}</pre>}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function ActionButton({ icon, label, title, disabled, onClick }: { icon: IconName; label: string; title?: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn small ghost" title={title ?? label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={12} /> {label}
    </button>
  );
}

/** Log (followed while shown), Inspect, and the last action's Output. */
function Details({ tab, setTab, logArgs, inspect, output, root, logKey }: { tab: Tab; setTab: (t: Tab) => void; logArgs: string[] | null; inspect: string[] | null; output: string[]; root: string; logKey: string }) {
  const tabs: Tab[] = [...(logArgs ? (['log'] as const) : []), ...(inspect ? (['inspect'] as const) : []), 'output'];
  const shown = tabs.includes(tab) ? tab : tabs[0];
  return (
    <>
      <div className="http-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={shown === t} className={'tw-tab' + (shown === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t === 'log' ? 'Log' : t === 'inspect' ? 'Inspect' : 'Output'}
          </button>
        ))}
      </div>
      <div className="svc-tab-body">
        {shown === 'log' && logArgs && <FollowLog key={logKey} root={root} args={logArgs} />}
        {shown === 'inspect' && inspect && <Inspect key={inspect.join(' ')} root={root} args={inspect} />}
        {shown === 'output' && (output.length ? <pre className="svc-log svc-output">{output.join('\n')}</pre> : <div className="muted gl-pad">Nothing run yet.</div>)}
      </div>
    </>
  );
}

/** `docker logs -f`: the last lines, then new ones as they come, until another one is shown. */
function FollowLog({ root, args }: { root: string; args: string[] }) {
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const id = (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1000);
    let alive = true;
    let pending: string[] = [];
    let timer = 0;
    const flush = () => {
      timer = 0;
      const add = pending;
      pending = [];
      setLines((l) => [...l, ...add].slice(-MAX_LOG));
    };
    runJob('job_exec', { id, cwd: root, program: 'docker', args }, (line) => {
      if (!alive) return;
      pending.push(line.replace(ANSI, '').replace(/\r?\n$/, ''));
      if (!timer) timer = window.setTimeout(flush, 100);
    }).then(
      (code) => alive && setEnded(code === 0 ? 'The log ended (the container stopped).' : `docker logs exited with code ${code}.`),
      (e) => alive && setEnded(dockerError(e)),
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
      void invoke('job_kill', { id }).catch(() => {});
    };
  }, [root, args.join('\u0000')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={box}
      className="svc-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      }}
    >
      {lines.join('\n') || (ended ? '' : 'Waiting for the log…')}
      {ended && <span className="muted">{`${lines.length ? '\n' : ''}— ${ended}`}</span>}
    </pre>
  );
}

function Inspect({ root, args }: { root: string; args: string[] }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    docker(root, args).then(
      (r) => alive && setText(r.code === 0 ? r.stdout : dockerError(r)),
      (e) => alive && setText(dockerError(e)),
    );
    return () => {
      alive = false;
    };
  }, [root, args.join('\u0000')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (text === null) return <div className="muted gl-pad">Inspecting…</div>;
  return <CodeView text={text} language={text.trimStart().startsWith('[') ? 'json' : 'plaintext'} />;
}

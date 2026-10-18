// The Debug tool window: one tab per session, the stepping toolbar, then
// Threads & Variables (frames on the left; watches, variables and other contexts on the right)
// and the Console (the script's output).

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { useDebug, type DebugSession } from '../debug/manager';
import { displayValue, type Property } from '../debug/dbgp';
import { relativePath } from '../backend/types';
import { copyText } from '../editorMenu';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import { VarNode } from './VarNode';
import { useHideTool } from './toolHide';
import { getCursor } from '../cursorStore';

export function DebugPanel({ ws }: { ws: Workspace }) {
  const hide = useHideTool(() => ws.setBottomOpen(false));
  const debug = useDebug();
  const s = debug.active;
  const [view, setView] = useState<'variables' | 'console'>('variables');

  return (
    <div className="debug-window">
      <div className="tw-head">
        <span className="tw-title">Debug</span>
        {debug.sessions.map((x) => (
          <span key={x.id} role="tab" aria-selected={x.id === debug.activeId} className={'tw-tab debug-session-tab' + (x.id === debug.activeId ? ' active' : '')} onClick={() => debug.selectSession(x.id)}>
            <span className={'debug-dot ' + x.status} />
            {x.label}
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${x.label}`}
              onClick={(e) => {
                e.stopPropagation();
                debug.closeSession(x.id);
              }}
            >
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Hide tool window" title="Hide" onClick={hide}>
          <Icon name="minus" size={14} />
        </button>
      </div>

      <div className="debug-toolbar" role="toolbar" aria-label="Debugger">
        <ToolButton icon="resume" label="Resume Program" keys="F9" color="#5fb865" disabled={s?.status !== 'break'} onClick={debug.resume} />
        <ToolButton icon="pause" label="Pause Program (not supported by Xdebug)" disabled onClick={() => {}} />
        <ToolButton icon="stopSquare" label="Stop" keys="Ctrl+F2" color="#e55765" disabled={!s || s.status === 'stopped'} onClick={() => void debug.stop()} />
        <span className="strip-sep" />
        <ToolButton icon="stepOver" label="Step Over" keys="F8" disabled={s?.status !== 'break'} onClick={debug.stepOver} />
        <ToolButton icon="stepInto" label="Step Into" keys="F7" disabled={s?.status !== 'break'} onClick={debug.stepInto} />
        <ToolButton icon="stepOut" label="Step Out" keys="Shift+F8" disabled={s?.status !== 'break'} onClick={debug.stepOut} />
        <ToolButton
          icon="runToCursor"
          label="Run to Cursor"
          keys="Alt+F9"
          disabled={s?.status !== 'break' || !ws.activePath}
          onClick={() => ws.activePath && void debug.runToCursor(ws.activePath, getCursor().line)}
        />
        <span className="strip-sep" />
        <ToolButton icon="mute" label={debug.muted ? 'Unmute Breakpoints' : 'Mute Breakpoints'} pressed={debug.muted} onClick={() => debug.setMuted(!debug.muted)} />
        <span className="strip-sep" />
        <button type="button" className={'tw-tab' + (view === 'variables' ? ' active' : '')} onClick={() => setView('variables')}>
          Threads &amp; Variables
        </button>
        <button type="button" className={'tw-tab' + (view === 'console' ? ' active' : '')} onClick={() => setView('console')}>
          Console {s?.output ? <span className="count">●</span> : null}
        </button>
        <span className="grow" />
        <ListenButton />
      </div>

      {!s ? (
        <EmptyState ws={ws} />
      ) : view === 'console' ? (
        <Console session={s} />
      ) : (
        <Variables ws={ws} session={s} />
      )}
    </div>
  );
}

function ToolButton({ icon, label, keys, color, disabled, pressed, onClick }: { icon: IconName; label: string; keys?: string; color?: string; disabled?: boolean; pressed?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={'icon-btn small debug-tool' + (pressed ? ' pressed' : '')}
      aria-label={label}
      aria-pressed={pressed}
      title={keys ? `${label} (${keys})` : label}
      disabled={disabled}
      style={{ color: disabled ? undefined : color }}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

function ListenButton() {
  const debug = useDebug();
  return (
    <button
      type="button"
      className={'btn small ghost debug-listen' + (debug.listening ? ' on' : '')}
      title={debug.listening ? `Listening on port ${debug.port}. Click to stop.` : 'Start Listening for PHP Debug Connections'}
      onClick={() => (debug.listening ? void debug.stopListening() : void debug.startListening())}
    >
      <Icon name="listen" size={13} />
      {debug.listening ? `Listening on :${debug.port}` : 'Start Listening'}
    </button>
  );
}

function EmptyState({ ws }: { ws: Workspace }) {
  const debug = useDebug();
  const php = ws.activePath?.endsWith('.php') ? ws.activePath : null;
  return (
    <div className="debug-empty">
      <div className="debug-empty-title">Not debugging</div>
      <div className="muted">
        {debug.listening
          ? `Waiting for Xdebug on port ${debug.port}. Start a request or script with Xdebug on (browser extension, XDEBUG_SESSION cookie, or xdebug.start_with_request=yes).`
          : 'Listen for incoming connections from Xdebug, or debug a script with the project interpreter.'}
      </div>
      <div className="debug-empty-actions">
        {!debug.listening && (
          <button type="button" className="btn" onClick={() => void debug.startListening()}>
            <Icon name="listen" size={13} /> Start Listening
          </button>
        )}
        {php && (
          <button type="button" className="btn primary" onClick={() => void debug.debugScript(php)}>
            <Icon name="bug" size={13} /> Debug {relativePath(ws.backend, php)}
          </button>
        )}
      </div>
      {debug.listenError && <div className="error-text">{debug.listenError}</div>}
    </div>
  );
}

function Console({ session }: { session: DebugSession }) {
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [session.output]);
  return (
    <pre ref={box} className="debug-console">
      {session.output || <span className="muted">No output yet.</span>}
    </pre>
  );
}

function Variables({ ws, session: s }: { ws: Workspace; session: DebugSession }) {
  const debug = useDebug();
  const [expr, setExpr] = useState('');
  const [evaluated, setEvaluated] = useState<{ expression: string; result?: Property; error?: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const stopped = s.status === 'break';

  const evaluate = async (watch: boolean) => {
    const e = expr.trim();
    if (!e) return;
    if (watch) {
      debug.addWatch(e);
      setExpr('');
      return;
    }
    setEvaluated({ expression: e, ...(await debug.evaluate(e)) });
  };

  const rowMenu = (e: React.MouseEvent, p: Property) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copy Value', run: () => copyText(ws, p.value ?? displayValue(p), 'value') },
        { label: 'Copy Name', run: () => copyText(ws, p.fullname || p.name, 'name') },
        { label: 'Add to Watches', disabled: !p.fullname, run: () => debug.addWatch(p.fullname) },
      ],
    });
  };

  return (
    <div className="debug-body">
      <div className="debug-frames" role="listbox" aria-label="Frames">
        {s.status === 'running' || s.status === 'starting' || s.status === 'connecting' ? (
          <div className="muted debug-note">{s.status === 'connecting' ? 'Connecting…' : 'Running…'}</div>
        ) : s.status === 'stopped' || s.status === 'stopping' ? (
          <div className="muted debug-note">The session has ended.</div>
        ) : (
          s.frames.map((f, i) => {
            const local = debug.toLocal(f.fileUri);
            const inProject = local.startsWith(ws.backend.root + '/');
            return (
              <div
                key={i}
                role="option"
                aria-selected={i === s.frame}
                className={'debug-frame' + (i === s.frame ? ' active' : '') + (inProject ? '' : ' library')}
                onClick={() => void debug.selectFrame(i)}
                title={`${local}:${f.line}`}
              >
                <span className="debug-frame-where">{f.where}</span>
                <span className="muted">
                  {local.split('/').pop()}:{f.line}
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="debug-vars">
        {s.exception && (
          <div className="debug-exception">
            <Icon name="error" size={13} /> {s.exception}
          </div>
        )}
        {s.warning && (
          <div className="debug-warning">
            <Icon name="warning" size={13} /> {s.warning}
          </div>
        )}
        <div className="field debug-eval">
          <input
            value={expr}
            disabled={!stopped}
            placeholder={stopped ? 'Evaluate expression (Enter) or add a watch (Ctrl+Shift+Enter)' : 'Evaluate when stopped at a breakpoint'}
            spellCheck={false}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void evaluate(e.ctrlKey && e.shiftKey);
              }
            }}
          />
          <button type="button" className="icon-btn small" title="Add to Watches" aria-label="Add to Watches" disabled={!expr.trim()} onClick={() => void evaluate(true)}>
            <Icon name="eye" size={14} />
          </button>
        </div>
        <div className="debug-tree" role="tree">
          {evaluated && (
            <div className="debug-evaluated">
              {evaluated.result ? (
                <VarNode p={evaluated.result} context={0} depth={0} onMenu={rowMenu} result />
              ) : (
                <div className="var-row error-text" style={{ paddingLeft: 22 }}>
                  {evaluated.expression}: {evaluated.error}
                </div>
              )}
            </div>
          )}
          {debug.watches.map((w) => (
            <div key={w.expression} className="debug-watch">
              {w.result && stopped ? (
                <VarNode p={w.result} context={0} depth={0} onMenu={rowMenu} watch onRemove={() => debug.removeWatch(w.expression)} />
              ) : (
                <div className="var-row" style={{ paddingLeft: 22 }}>
                  <Icon name="eye" size={12} />
                  <span className="var-name">{w.expression}</span>
                  <span className={w.error ? 'error-text' : 'muted'}>{stopped ? ` = ${w.error ?? '…'}` : ''}</span>
                  <button type="button" className="icon-btn small var-remove" aria-label="Remove watch" onClick={() => debug.removeWatch(w.expression)}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              )}
            </div>
          ))}
          {stopped && s.variables?.map((p) => <VarNode key={p.fullname || p.name} p={p} context={0} depth={0} onMenu={rowMenu} />)}
          {stopped && s.variables?.length === 0 && <div className="muted var-row" style={{ paddingLeft: 22 }}>No variables</div>}
          {stopped && s.contexts.filter((c) => c.id !== 0).map((c) => <ContextNode key={c.id} name={c.name} id={c.id} onMenu={rowMenu} />)}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Superglobals, User defined constants: loaded when expanded. */
function ContextNode({ name, id, onMenu }: { name: string; id: number; onMenu: (e: React.MouseEvent, p: Property) => void }) {
  const debug = useDebug();
  const [open, setOpen] = useState(false);
  const [vars, setVars] = useState<Property[] | null>(null);
  return (
    <>
      <div
        className="var-row"
        role="treeitem"
        aria-expanded={open}
        onClick={async () => {
          setOpen(!open);
          if (!open && !vars) setVars(await debug.contextVariables(id));
        }}
      >
        <span className={'chev' + (open ? ' open' : '')}>
          <Icon name="chevronRight" size={11} />
        </span>
        <Icon name="structure" size={12} />
        <span className="var-name context">{name}</span>
      </div>
      {open && vars?.map((p) => <VarNode key={p.fullname || p.name} p={p} context={id} depth={1} onMenu={onMenu} />)}
      {open && vars === null && <div className="muted var-row" style={{ paddingLeft: 40 }}>Loading…</div>}
    </>
  );
}


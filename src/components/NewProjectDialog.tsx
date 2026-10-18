// File ▸ New Project: project types on the left (PHP, frameworks, JavaScript
// generators), their options on the right. Creating runs the type's steps (src/projectGenerators.ts)
// and shows the tools' output as it comes; when it's done the new project opens.

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { runJob } from '../jobs';
import { homeDir } from '@tauri-apps/api/path';
import { isTauri, pickFolder } from '../platform';
import { GENERATORS, defaultValues, validate, type Generator, type Option, type Step, type Tool, type Values } from '../projectGenerators';
import { Icon, type IconName } from './Icon';

interface Props {
  /** A recent project: new projects go next to it. */
  near?: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}

const toNative = (path: string) => (/^[A-Za-z]:\//.test(path) ? path.replace(/\//g, '\\') : path);
const toSlash = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const TOOL_HINTS: Record<Tool, string> = {
  composer: 'Composer was not found on PATH. Install Composer (getcomposer.org) and PHP, then reopen this dialog.',
  node: 'Node.js was not found on PATH. Install Node.js (nodejs.org), then reopen this dialog.',
};

type Status = 'pending' | 'running' | 'done' | 'failed';
interface Run {
  steps: { step: Step; status: Status }[];
  log: string[];
  state: 'running' | 'failed' | 'cancelled';
  error?: string;
  path: string;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`, 'g');

/** Output as lines without colors; a carriage return (a progress bar) keeps the last state. */
function cleanLine(text: string): string {
  const line = text.replace(ANSI, '').replace(/\r?\n$/, '');
  return line.slice(line.lastIndexOf('\r') + 1);
}

let nextJob = 1;

export function NewProjectDialog({ near, onClose, onCreated }: Props) {
  const [generator, setGenerator] = useState<Generator>(GENERATORS[0]);
  const [valuesById, setValuesById] = useState<Record<string, Values>>({});
  const values = valuesById[generator.id] ?? defaultValues(generator);
  const setValue = (id: string, value: string | boolean) => setValuesById((all) => ({ ...all, [generator.id]: { ...values, [id]: value } }));
  const [location, setLocation] = useState('');
  const [tools, setTools] = useState<Partial<Record<Tool, boolean>>>({});
  const [run, setRun] = useState<Run | null>(null);
  const job = useRef(0);
  const cancelled = useRef(false);
  const logBox = useRef<HTMLDivElement>(null);

  // Default location: next to the recent project, or in the home folder, as an unused "untitled".
  useEffect(() => {
    let live = true;
    (async () => {
      const parent = near ? parentOf(near) : isTauri ? toSlash(await homeDir().catch(() => '')) : '/projects';
      let name = 'untitled';
      if (isTauri) {
        const taken = new Set((await invoke<{ name: string }[]>('list_dir', { path: parent }).catch(() => [])).map((e) => e.name.toLowerCase()));
        for (let i = 1; taken.has(name); i++) name = `untitled${i}`;
      }
      if (live) setLocation((cur) => cur || toNative(`${parent}/${name}`));
    })();
    return () => {
      live = false;
    };
  }, [near]);

  // Which generator tools are installed.
  useEffect(() => {
    if (!isTauri) return;
    void Promise.all([invoke<string | null>('find_executable', { names: ['composer'] }), invoke<string | null>('find_executable', { names: ['php'] }), invoke<string | null>('find_executable', { names: ['npx'] })]).then(([composer, php, npx]) =>
      setTools({ composer: !!composer && !!php, node: !!npx }),
    );
  }, []);

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [run?.log.length]);

  const path = toSlash(location);
  const name = nameOf(path);
  const problem = validate(generator, name, values);
  const missingTool = generator.tool && isTauri && tools[generator.tool] === false ? TOOL_HINTS[generator.tool] : '';
  const desktopOnly = !isTauri ? 'Projects are created in the desktop app.' : '';
  const note = missingTool || desktopOnly || (location.trim() ? problem : '');
  const canCreate = !note && !!location.trim() && !run;
  const disabled = generator.disabled?.(values) ?? {};

  const groups = useMemo(() => {
    const out: { title: string; items: Generator[] }[] = [];
    for (const g of GENERATORS) {
      const last = out[out.length - 1];
      if (last && last.title === g.group) last.items.push(g);
      else out.push({ title: g.group, items: [g] });
    }
    return out;
  }, []);

  const runLine = async (line: string, cwd: string, append: (text: string) => void): Promise<number> => {
    const id = nextJob++;
    job.current = id;
    try {
      return await runJob('job_run', { id, cwd, line }, append);
    } finally {
      job.current = 0;
    }
  };

  const create = async () => {
    if (!canCreate) return;
    const parent = parentOf(path);
    const steps = generator.steps(name, values);
    cancelled.current = false;
    const state: Run = { steps: steps.map((step) => ({ step, status: 'pending' })), log: [], state: 'running', path };
    const update = () => setRun({ ...state, steps: [...state.steps], log: state.log });
    const append = (text: string) => {
      state.log = [...state.log, cleanLine(text)].slice(-3000);
      update();
    };
    update();
    try {
      // The project folder must be new or empty; its parent is created when missing.
      const existing = await invoke<{ name: string }[]>('list_dir', { path }).catch(() => null);
      if (existing && existing.length) throw new Error(`${toNative(path)} already exists and isn't empty.`);
      if (!existing) await invoke('create_dir', { path: parent }).catch(() => {});
      for (const entry of state.steps) {
        if (cancelled.current) throw new Error('Cancelled.');
        entry.status = 'running';
        update();
        const { step } = entry;
        if (step.kind === 'files') {
          await invoke('create_dir', { path }).catch(() => {});
          for (const [rel, content] of Object.entries(step.files)) {
            if (rel.endsWith('/.gitkeep')) await invoke('create_dir', { path: `${path}/${parentOf(rel)}` }).catch(() => {});
            else await invoke('create_file', { path: `${path}/${rel}`, content });
          }
        } else {
          append(`> ${step.line}`);
          const code = await runLine(step.line, step.where === 'parent' ? parent : path, append);
          if (cancelled.current) throw new Error('Cancelled.');
          if (code !== 0) throw new Error(`${step.title} failed: the command exited with code ${code}.`);
        }
        entry.status = 'done';
        update();
      }
      onClose();
      onCreated(path);
    } catch (e) {
      const current = state.steps.find((s) => s.status === 'running');
      if (current) current.status = 'failed';
      state.state = cancelled.current ? 'cancelled' : 'failed';
      state.error = e instanceof Error ? e.message : String(e);
      update();
    }
  };

  const cancel = () => {
    cancelled.current = true;
    if (job.current) void invoke('job_kill', { id: job.current });
  };

  /** After a failure: whether the folder was made, so it can be opened anyway. */
  const [madeFolder, setMadeFolder] = useState(false);
  const runState = run?.state;
  const runPath = run?.path;
  useEffect(() => {
    if (runPath && runState !== 'running') invoke<unknown[]>('list_dir', { path: runPath }).then((l) => setMadeFolder(l.length > 0), () => setMadeFolder(false));
  }, [runState, runPath]);

  const running = run?.state === 'running';

  return (
    <div className="modal-backdrop np-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !run && onClose()}>
      <form
        className="pb-dialog np-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New Project"
        onKeyDown={(e) => e.key === 'Escape' && !running && (run ? setRun(null) : onClose())}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="pb-dialog-title">New Project</div>
        <div className="np-main">
          <nav className="np-types" aria-label="Project type">
            {groups.map((group) => (
              <div key={group.title || 'general'} role="group" aria-label={group.title || 'General'}>
                {group.title && <div className="np-group">{group.title}</div>}
                {group.items.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={'np-type' + (g.id === generator.id ? ' selected' : '')}
                    aria-current={g.id === generator.id}
                    disabled={!!run}
                    onClick={() => setGenerator(g)}
                  >
                    <span className="np-type-icon" style={g.color ? { color: g.color } : undefined}>
                      <Icon name={g.icon as IconName} />
                    </span>
                    {g.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="np-body">
            {run ? (
              <Progress run={run} logBox={logBox} />
            ) : (
              <>
                <div className="np-heading">{generator.label}</div>
                <div className="np-row">
                  <label htmlFor="np-location">
                    <u>L</u>ocation:
                  </label>
                  <div className="welcome-folder">
                    <div className={'field' + (location.trim() && problem && !missingTool ? ' invalid' : '')}>
                      <input id="np-location" value={location} autoFocus spellCheck={false} accessKey="l" onChange={(e) => setLocation(e.target.value)} />
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Browse…"
                      onClick={async () => {
                        const picked = await pickFolder();
                        if (picked) setLocation(toNative(`${toSlash(picked)}/${name || 'untitled'}`));
                      }}
                    >
                      <Icon name="folder" />
                    </button>
                  </div>
                </div>
                <Options generator={generator} values={values} disabled={disabled} onChange={setValue} />
              </>
            )}
          </div>
        </div>
        <div className="np-footer">
          <div className="np-note">
            {run?.error ? (
              <span className="error-text">{run.error}</span>
            ) : running ? (
              <span className="muted">Creating {name}…</span>
            ) : note ? (
              <>
                <span className="np-bolt">⚡</span>
                {note}
              </>
            ) : null}
          </div>
          {running ? (
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
          ) : run ? (
            <>
              {madeFolder && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onClose();
                    onCreated(run.path);
                  }}
                >
                  Open Anyway
                </button>
              )}
              <button type="button" className="btn" onClick={() => setRun(null)}>
                Back
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </>
          ) : (
            <>
              <button type="submit" className="btn primary" disabled={!canCreate}>
                Create
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

function Options({ generator, values, disabled, onChange }: { generator: Generator; values: Values; disabled: Record<string, boolean>; onChange: (id: string, v: string | boolean) => void }) {
  // Checkboxes with a section are shown under its heading, in two columns when asked.
  const blocks: { section?: string; columns?: boolean; options: Option[] }[] = [];
  for (const o of generator.options) {
    const section = o.kind === 'check' ? o.section : undefined;
    const columns = o.kind === 'check' && !!o.columns;
    const last = blocks[blocks.length - 1];
    if (last && section && last.section === section) last.options.push(o);
    else blocks.push({ section, columns, options: [o] });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.section ? (
          <fieldset key={b.section} className="np-section">
            <legend>{b.section}</legend>
            <div className={b.columns ? 'np-columns' : 'np-stack'}>
              {b.options.map((o) => (
                <OptionField key={o.id} option={o} value={values[o.id]} disabled={!!disabled[o.id]} onChange={onChange} />
              ))}
            </div>
          </fieldset>
        ) : (
          b.options.map((o) => <OptionField key={o.id + i} option={o} value={values[o.id]} disabled={!!disabled[o.id]} onChange={onChange} />)
        ),
      )}
    </>
  );
}

function OptionField({ option: o, value, disabled, onChange }: { option: Option; value: string | boolean | undefined; disabled: boolean; onChange: (id: string, v: string | boolean) => void }) {
  const id = `np-${o.id}`;
  if (o.kind === 'check') {
    return (
      <label className="settings-check np-check" title={o.help}>
        <input type="checkbox" className="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(o.id, e.target.checked)} />
        {o.label}
        {o.help && (
          <span className="np-help" aria-label={o.help}>
            ?
          </span>
        )}
      </label>
    );
  }
  return (
    <div className="np-row">
      <label htmlFor={id}>{o.label}:</label>
      {o.kind === 'select' ? (
        <select id={id} className="settings-select np-select" value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(o.id, e.target.value)}>
          {o.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : o.kind === 'segmented' ? (
        <div className="segmented np-segmented" role="radiogroup" aria-label={o.label}>
          {o.choices.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={value === c.value} className={'segment' + (value === c.value ? ' on' : '')} disabled={disabled} onClick={() => onChange(o.id, c.value)}>
              {c.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="np-text">
          <div className="field">
            <input id={id} value={String(value ?? '')} placeholder={o.placeholder} spellCheck={false} disabled={disabled} onChange={(e) => onChange(o.id, e.target.value)} />
          </div>
          {o.help && <span className="muted np-hint">{o.help}</span>}
        </div>
      )}
    </div>
  );
}

function Progress({ run, logBox }: { run: Run; logBox: React.RefObject<HTMLDivElement> }) {
  const marks: Record<Status, string> = { pending: '○', running: '◌', done: '✓', failed: '✕' };
  return (
    <div className="np-progress">
      <ol className="np-steps">
        {run.steps.map(({ step, status }, i) => (
          <li key={i} className={`np-step ${status}`}>
            <span className={'np-mark' + (status === 'running' ? ' spin' : '')}>{marks[status]}</span>
            {step.title}
          </li>
        ))}
      </ol>
      <div className="np-log mono" ref={logBox} role="log" aria-label="Output">
        {run.log.length ? run.log.map((l, i) => <div key={i}>{l || ' '}</div>) : <div className="muted">Starting…</div>}
      </div>
    </div>
  );
}

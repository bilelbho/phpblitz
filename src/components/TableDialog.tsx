// Modify Table / Create Table, like PhpStorm's: the table's structure on the left (columns, keys,
// foreign keys, indexes, checks), the selected element's properties on the right, and a live
// preview of the SQL at the bottom. OK runs it (atomically on Postgres).

import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { Workspace } from '../useWorkspace';
import { db } from '../db/store';
import { isRelation, type Driver } from '../db/types';
import { FK_RULES, alterStatements, createStatements, emptyModel, modelOf, newId, script, type ColumnModel, type FkRule, type TableModel } from '../db/alter';
import { tableCommentSql } from '../db/dialect';
import { useSettings } from '../settings';
import { themeId } from '../editor/themes';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';

type Section = 'columns' | 'keys' | 'foreignKeys' | 'indexes' | 'checks';
type Selection = { kind: 'table' } | { kind: Section; id: string };

const SECTIONS: { id: Section; label: string; icon: IconName; cls?: string }[] = [
  { id: 'columns', label: 'columns', icon: 'dbColumn' },
  { id: 'keys', label: 'keys', icon: 'dbKey', cls: 'db-pk' },
  { id: 'foreignKeys', label: 'foreign keys', icon: 'dbKey', cls: 'db-fk' },
  { id: 'indexes', label: 'indexes', icon: 'dbIndex' },
  { id: 'checks', label: 'checks', icon: 'check' },
];

const TYPES: Record<Driver, string[]> = {
  postgres: ['bigint', 'integer', 'smallint', 'bigserial', 'serial', 'numeric(10,2)', 'real', 'double precision', 'boolean', 'varchar(255)', 'text', 'char(1)', 'uuid', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'bytea', 'inet'],
  mysql: ['bigint', 'int', 'smallint', 'tinyint(1)', 'decimal(10,2)', 'float', 'double', 'varchar(255)', 'text', 'longtext', 'char(1)', 'date', 'datetime', 'timestamp', 'time', 'json', 'blob', 'enum(\'a\',\'b\')'],
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'],
  sample: ['bigint', 'int', 'varchar(255)', 'text', 'datetime'],
};

export interface TableDialogRequest {
  source: string;
  schema: string;
  /** Existing table to modify; absent: create a new one. */
  table?: string;
  /** Open with this column selected (Modify Column…). */
  column?: string;
}

export function TableDialog({ ws, request, onClose }: { ws: Workspace; request: TableDialogRequest; onClose: () => void }) {
  const ds = db.get(request.source)!;
  const driver = ds.driver;
  const editorSettings = useSettings().editor;
  const [before, setBefore] = useState<TableModel | null>(request.table ? null : emptyModel());
  const [model, setModel] = useState<TableModel | null>(() => {
    if (request.table) return null;
    const m = emptyModel();
    const id = newId();
    return { ...m, columns: [{ id, name: 'id', type: driver === 'sqlite' ? 'INTEGER' : 'bigint', nullable: false, default: '', comment: '' }], keys: [{ id: newId(), name: driver === 'mysql' ? 'PRIMARY' : 'new_table_pk', primary: true, columns: ['id'] }] };
  });
  const [selection, setSelection] = useState<Selection>({ kind: 'table' });
  const [open, setOpen] = useState<Set<Section>>(new Set(['columns', 'keys', 'foreignKeys', 'indexes', 'checks']));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);

  // Load the table as it is now.
  useEffect(() => {
    if (!request.table) return;
    let live = true;
    (async () => {
      const [columns, details] = await Promise.all([db.columns(request.source, request.schema, request.table!, true), db.details(request.source, request.schema, request.table!, true)]);
      const commentSql = tableCommentSql(driver, request.schema, request.table!);
      const comment = commentSql ? (await db.query(request.source, commentSql).catch(() => null))?.rows[0]?.[0] ?? '' : '';
      const m = modelOf(request.table!, comment, columns, details);
      if (!live) return;
      setBefore(m);
      setModel(structuredClone(m));
      const col = request.column ? m.columns.find((c) => c.name === request.column) : undefined;
      if (col) setSelection({ kind: 'columns', id: col.id });
    })().catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [request, driver]);

  const statements = useMemo(() => {
    if (!model || !before) return [];
    try {
      return request.table ? alterStatements(driver, request.schema, before, model) : createStatements(driver, request.schema, model);
    } catch (e) {
      return [`-- ${String(e)}`];
    }
  }, [model, before, driver, request]);
  const sql = script(statements);
  const runnable = statements.filter((s) => !s.startsWith('--'));

  // Table names for foreign key targets.
  const tables = useMemo(() => {
    const st = db.state[request.source];
    return Object.entries(st?.tables ?? {}).flatMap(([schema, list]) => (list ?? []).filter((t) => isRelation(t.kind)).map((t) => (schema === request.schema ? t.name : `${schema}.${t.name}`)));
  }, [request]);

  if (!model) {
    return (
      <Shell title="Modify" onClose={onClose}>
        <div className="td-loading">{error || 'Loading the table…'}</div>
      </Shell>
    );
  }

  const update = (fn: (m: TableModel) => void) =>
    setModel((m) => {
      const next = structuredClone(m!);
      fn(next);
      return next;
    });

  const add = (section: Section) => {
    const id = newId();
    const firstCol = model.columns[0]?.name ? [model.columns[0].name] : [];
    update((m) => {
      if (section === 'columns') m.columns.push({ id, name: uniqueName(m.columns.map((c) => c.name), 'column'), type: TYPES[driver][0], nullable: true, default: '', comment: '' });
      if (section === 'keys') m.keys.push({ id, name: uniqueName(m.keys.map((k) => k.name), `${m.name}_key`), primary: !m.keys.some((k) => k.primary), columns: firstCol });
      if (section === 'foreignKeys') m.foreignKeys.push({ id, name: uniqueName(m.foreignKeys.map((f) => f.name), `${m.name}_fk`), columns: firstCol, refTable: '', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
      if (section === 'indexes') m.indexes.push({ id, name: uniqueName(m.indexes.map((i) => i.name), `${m.name}_idx`), unique: false, columns: firstCol });
      if (section === 'checks') m.checks.push({ id, name: uniqueName(m.checks.map((c) => c.name), `${m.name}_check`), expression: 'true' });
    });
    setOpen((o) => new Set([...o, section]));
    setSelection({ kind: section, id });
  };

  const remove = () => {
    if (selection.kind === 'table') return;
    const { kind, id } = selection;
    update((m) => {
      (m[kind] as { id: string }[]).splice((m[kind] as { id: string }[]).findIndex((x) => x.id === id), 1);
    });
    setSelection({ kind: 'table' });
  };

  const moveColumn = (dir: -1 | 1) => {
    if (selection.kind !== 'columns') return;
    const id = selection.id;
    update((m) => {
      const i = m.columns.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= m.columns.length) return;
      [m.columns[i], m.columns[j]] = [m.columns[j], m.columns[i]];
    });
  };

  const execute = async () => {
    if (!runnable.length) return onClose();
    setBusy(true);
    setError('');
    try {
      // Postgres runs the whole script as one implicit transaction: all or nothing.
      if (driver === 'postgres') await db.query(request.source, script(runnable));
      else for (const s of runnable) await db.query(request.source, s);
      await db.tables(request.source, request.schema, true);
      const name = model.name;
      await Promise.all([db.columns(request.source, request.schema, name, true), db.details(request.source, request.schema, name, true)]).catch(() => {});
      ws.notify({ title: request.table ? `Modified ${name}` : `Created ${name}`, body: `${runnable.length} statement${runnable.length === 1 ? '' : 's'} run on ${ds.name}.`, tone: 'success' });
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  const openInConsole = () => {
    ws.openConsole(request.source, db.newConsole(request.source), sql + '\n');
    onClose();
  };

  const item = (kind: Section, id: string) => (model[kind] as { id: string }[]).find((x) => x.id === id);
  const columnNames = model.columns.map((c) => c.name);

  return (
    <Shell title={request.table ? 'Modify' : 'Create Table'} onClose={onClose} wide>
      <div className="td-main">
        <div className="td-tree">
          <div className="td-tools">
            <button
              type="button"
              className="icon-btn small"
              title="Add"
              aria-label="Add"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 2, items: SECTIONS.map((s) => ({ label: s.label.replace(/s$/, '').replace(/^./, (c) => c.toUpperCase()), icon: s.icon, run: () => add(s.id) })) });
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button type="button" className="icon-btn small" title="Remove (Delete)" aria-label="Remove" disabled={selection.kind === 'table'} onClick={remove}>
              <Icon name="minus" size={14} />
            </button>
            <button type="button" className="icon-btn small" title="Move Up" aria-label="Move up" disabled={selection.kind !== 'columns'} onClick={() => moveColumn(-1)}>
              <Icon name="chevronUp" size={13} />
            </button>
            <button type="button" className="icon-btn small" title="Move Down" aria-label="Move down" disabled={selection.kind !== 'columns'} onClick={() => moveColumn(1)}>
              <Icon name="chevronDown" size={13} />
            </button>
          </div>
          <div className="td-list" role="tree" tabIndex={0} onKeyDown={(e) => e.key === 'Delete' && selection.kind !== 'table' && remove()}>
            <div className={'row' + (selection.kind === 'table' ? ' selected' : '')} onClick={() => setSelection({ kind: 'table' })}>
              <Icon name="dbTable" size={15} className="db-ic" />
              <span className="name">{model.name}</span>
              <span className="detail">
                {request.schema} [{ds.name}]
              </span>
            </div>
            {SECTIONS.map((s) => {
              const list = model[s.id] as { id: string; name: string }[];
              if (!list.length && s.id !== 'columns') return null;
              const isOpen = open.has(s.id);
              return (
                <div key={s.id}>
                  <div className="row" style={{ paddingLeft: 18 }} onClick={() => setOpen((o) => (o.has(s.id) ? new Set([...o].filter((x) => x !== s.id)) : new Set([...o, s.id])))}>
                    <span className={'chev' + (isOpen ? ' open' : '')}>
                      <Icon name="chevronRight" size={11} />
                    </span>
                    <Icon name="folder" size={15} className="db-ic db-folder" />
                    <span className="name">{s.label}</span>
                    <span className="detail">{list.length}</span>
                  </div>
                  {isOpen &&
                    list.map((x) => (
                      <div key={x.id} className={'row' + (selection.kind === s.id && selection.id === x.id ? ' selected' : '')} style={{ paddingLeft: 48 }} onClick={() => setSelection({ kind: s.id, id: x.id })}>
                        <Icon name={s.id === 'columns' && model.keys.some((k) => k.primary && k.columns.includes(x.name)) ? 'dbKey' : s.icon} size={14} className={'db-ic ' + (s.id === 'columns' && model.keys.some((k) => k.primary && k.columns.includes(x.name)) ? 'db-pk' : s.cls ?? '')} />
                        <span className="name">{x.name || '(unnamed)'}</span>
                        <span className="detail">{detailOf(s.id, x)}</span>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="td-props">
          {selection.kind === 'table' && (
            <Grid>
              <Field
                label="Name"
                value={model.name}
                autoFocus={!request.table}
                onChange={(v) =>
                  update((m) => {
                    // New table: generated names (new_table_pk, new_table_fk…) follow the table name.
                    if (!request.table) {
                      const prefix = `${m.name}_`;
                      for (const x of [...m.keys, ...m.foreignKeys, ...m.indexes, ...m.checks]) if (x.name.startsWith(prefix)) x.name = `${v}_${x.name.slice(prefix.length)}`;
                    }
                    m.name = v;
                  })
                }
              />
              {driver !== 'sqlite' && <Field label="Comment" value={model.comment} onChange={(v) => update((m) => (m.comment = v))} />}
            </Grid>
          )}
          {selection.kind === 'columns' && (() => {
            const c = item('columns', selection.id) as ColumnModel | undefined;
            if (!c) return null;
            const set = (patch: Partial<ColumnModel>) => update((m) => Object.assign(m.columns.find((x) => x.id === c.id)!, patch));
            return (
              <Grid>
                <Field label="Name" value={c.name} onChange={(v) => set({ name: v })} autoFocus />
                <Field label="Type" value={c.type} onChange={(v) => set({ type: v })} list={`td-types-${driver}`} mono />
                <datalist id={`td-types-${driver}`}>
                  {TYPES[driver].map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <Field label="Default" value={c.default} onChange={(v) => set({ default: v })} mono placeholder="expression, e.g. 0, 'text', now()" />
                <span />
                <label className="settings-check">
                  <input type="checkbox" className="checkbox" checked={!c.nullable} onChange={(e) => set({ nullable: !e.target.checked })} />
                  Not null
                </label>
                {driver !== 'sqlite' && <Field label="Comment" value={c.comment} onChange={(v) => set({ comment: v })} />}
              </Grid>
            );
          })()}
          {selection.kind === 'keys' && (() => {
            const k = model.keys.find((x) => x.id === selection.id);
            if (!k) return null;
            const set = (patch: Partial<typeof k>) => update((m) => Object.assign(m.keys.find((x) => x.id === k.id)!, patch));
            return (
              <Grid>
                <Field label="Name" value={k.name} onChange={(v) => set({ name: v })} autoFocus />
                <span />
                <label className="settings-check">
                  <input type="checkbox" className="checkbox" checked={k.primary} onChange={(e) => set({ primary: e.target.checked })} />
                  Primary key
                </label>
                <ColumnPicker label="Columns" all={columnNames} value={k.columns} onChange={(v) => set({ columns: v })} />
              </Grid>
            );
          })()}
          {selection.kind === 'foreignKeys' && (() => {
            const f = model.foreignKeys.find((x) => x.id === selection.id);
            if (!f) return null;
            const set = (patch: Partial<typeof f>) => update((m) => Object.assign(m.foreignKeys.find((x) => x.id === f.id)!, patch));
            return (
              <Grid>
                <Field label="Name" value={f.name} onChange={(v) => set({ name: v })} autoFocus />
                <ColumnPicker label="Columns" all={columnNames} value={f.columns} onChange={(v) => set({ columns: v })} />
                <Field label="Target table" value={f.refTable} onChange={(v) => set({ refTable: v })} list="td-tables" mono />
                <datalist id="td-tables">
                  {tables.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <Field label="Target columns" value={f.refColumns.join(', ')} onChange={(v) => set({ refColumns: v.split(/,\s*/).filter(Boolean) })} mono />
                <RuleSelect label="On delete" value={f.onDelete} onChange={(v) => set({ onDelete: v })} />
                <RuleSelect label="On update" value={f.onUpdate} onChange={(v) => set({ onUpdate: v })} />
              </Grid>
            );
          })()}
          {selection.kind === 'indexes' && (() => {
            const i = model.indexes.find((x) => x.id === selection.id);
            if (!i) return null;
            const set = (patch: Partial<typeof i>) => update((m) => Object.assign(m.indexes.find((x) => x.id === i.id)!, patch));
            return (
              <Grid>
                <Field label="Name" value={i.name} onChange={(v) => set({ name: v })} autoFocus />
                <span />
                <label className="settings-check">
                  <input type="checkbox" className="checkbox" checked={i.unique} onChange={(e) => set({ unique: e.target.checked })} />
                  Unique
                </label>
                <ColumnPicker label="Columns" all={columnNames} value={i.columns} onChange={(v) => set({ columns: v })} />
              </Grid>
            );
          })()}
          {selection.kind === 'checks' && (() => {
            const c = model.checks.find((x) => x.id === selection.id);
            if (!c) return null;
            const set = (patch: Partial<typeof c>) => update((m) => Object.assign(m.checks.find((x) => x.id === c.id)!, patch));
            return (
              <Grid>
                <Field label="Name" value={c.name} onChange={(v) => set({ name: v })} autoFocus />
                <Field label="Expression" value={c.expression} onChange={(v) => set({ expression: v })} mono />
              </Grid>
            );
          })()}
        </div>
      </div>

      <div className="td-preview-head">
        <button type="button" className="link-btn td-preview-toggle" onClick={() => setPreviewOpen(!previewOpen)}>
          <Icon name={previewOpen ? 'chevronDown' : 'chevronRight'} size={11} /> Preview
        </button>
        <span className="muted">{runnable.length ? `${runnable.length} statement${runnable.length === 1 ? '' : 's'}${driver === 'postgres' ? ', run in one transaction' : ''}` : 'No changes'}</span>
        <span className="grow" />
        <button type="button" className="link-btn" disabled={!runnable.length} onClick={openInConsole}>
          Open in Console
        </button>
      </div>
      {previewOpen && (
        <div className="td-preview">
          <Editor
            height="100%"
            language="sql"
            theme={themeId(editorSettings.scheme)}
            value={sql || '-- No changes'}
            options={{ readOnly: true, minimap: { enabled: false }, lineNumbers: 'off', folding: false, scrollBeyondLastLine: false, fontFamily: editorSettings.fontFamily, fontSize: editorSettings.fontSize - 1, renderLineHighlight: 'none', wordWrap: 'on', glyphMargin: false, lineDecorationsWidth: 8 }}
          />
        </div>
      )}
      {error && <div className="td-error">{error}</div>}
      <div className="jb-dialog-buttons">
        <button type="button" className="btn primary" disabled={busy || !model.name.trim() || (!request.table && !model.columns.length)} onClick={() => void execute()}>
          {busy ? 'Running…' : 'OK'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </Shell>
  );
}

function detailOf(section: Section, x: unknown): string {
  const v = x as Record<string, unknown>;
  if (section === 'columns') return `${v.type}${v.default ? ` = ${v.default}` : ''}${v.nullable ? '' : ' not null'}`;
  if (section === 'keys' || section === 'indexes') return `(${(v.columns as string[]).join(', ')})${v.primary ? ' PRIMARY' : v.unique ? ' UNIQUE' : ''}`;
  if (section === 'foreignKeys') return `(${(v.columns as string[]).join(', ')}) → ${v.refTable}(${(v.refColumns as string[]).join(', ')})`;
  return String(v.expression ?? '');
}

function uniqueName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 1; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

function Shell({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={'jb-dialog td-dialog' + (wide ? ' wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="settings-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

const Grid = ({ children }: { children: React.ReactNode }) => <div className="settings-grid td-grid">{children}</div>;

function Field({ label, value, onChange, autoFocus, list, mono, placeholder }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; list?: string; mono?: boolean; placeholder?: string }) {
  const id = `td-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="field">
        <input id={id} value={value} list={list} spellCheck={false} autoFocus={autoFocus} placeholder={placeholder} className={mono ? 'mono' : undefined} onChange={(e) => onChange(e.target.value)} />
      </div>
    </>
  );
}

function ColumnPicker({ label, all, value, onChange }: { label: string; all: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <>
      <span>{label}</span>
      <div className="td-columns">
        {/* Picked columns keep their order; the others follow. */}
        {[...value.filter((c) => all.includes(c)), ...all.filter((c) => !value.includes(c))].map((c) => (
          <label key={c} className="settings-check">
            <input type="checkbox" className="checkbox" checked={value.includes(c)} onChange={(e) => onChange(e.target.checked ? [...value, c] : value.filter((x) => x !== c))} />
            <span className="mono">{c}</span>
          </label>
        ))}
        {!all.length && <span className="muted">Add columns first.</span>}
      </div>
    </>
  );
}

function RuleSelect({ label, value, onChange }: { label: string; value: FkRule; onChange: (v: FkRule) => void }) {
  return (
    <>
      <label>{label}</label>
      <select className="settings-select" value={value} onChange={(e) => onChange(e.target.value as FkRule)}>
        {FK_RULES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </>
  );
}

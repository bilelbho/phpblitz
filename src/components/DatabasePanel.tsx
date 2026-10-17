// Database tool window, like PhpStorm's: data source → database → schemas → tables / views /
// sequences / routines → columns, keys, foreign keys, indexes, checks; Server Objects → roles.
// Loaded as you expand; the eye button changes how it is grouped.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Workspace } from '../useWorkspace';
import { db, useDb } from '../db/store';
import { dropSql, qualified, quoteIdent, renameSql } from '../db/dialect';
import { driverName, isRelation, type Column, type DataSource, type ObjectKind, type TableInfo } from '../db/types';
import { Icon, type IconName } from './Icon';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { DataSourceDialog } from './DataSourceDialog';
import { TableDialog, type TableDialogRequest } from './TableDialog';
import { copyText } from '../editorMenu';
import { confirmDialog } from '../platform';

// ── View options (the eye button) ─────────────────────────────

interface ViewOptions {
  /** tables / views / sequences… folders under a schema. */
  schemaObjects: boolean;
  /** columns / keys / indexes… folders under a table. */
  objectElements: boolean;
  /** Server Objects (roles) under a data source. */
  serverObjects: boolean;
  /** System schemas: pg_catalog, information_schema… */
  allNamespaces: boolean;
  emptyGroups: boolean;
  /** Column type and default after the name. */
  columnDetails: boolean;
}

const VIEW_KEY = 'phpblitz.dbTreeView';
const DEFAULT_VIEW: ViewOptions = { schemaObjects: true, objectElements: true, serverObjects: true, allNamespaces: false, emptyGroups: false, columnDetails: true };

function loadView(): ViewOptions {
  try {
    return { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') };
  } catch {
    return DEFAULT_VIEW;
  }
}

// ── Tree nodes ────────────────────────────────────────────────

type NodeKind = 'source' | 'database' | 'schema' | 'group' | 'object' | 'elements' | 'column' | 'key' | 'fk' | 'index' | 'check' | 'server' | 'roles' | 'role';

interface TreeNode {
  key: string;
  depth: number;
  kind: NodeKind;
  label: string;
  icon: ReactNode;
  detail?: string;
  /** "1 of 3": shown of available. */
  pill?: string;
  leaf?: boolean;
  open?: boolean;
  /** Folders open by default (tables). */
  defaultOpen?: boolean;
  source: string;
  schema?: string;
  object?: TableInfo;
  load?: () => Promise<unknown>;
  muted?: boolean;
}

const GROUPS: { kinds: ObjectKind[]; label: string }[] = [
  { kinds: ['table'], label: 'tables' },
  { kinds: ['view'], label: 'views' },
  { kinds: ['matview'], label: 'materialized views' },
  { kinds: ['foreign'], label: 'foreign tables' },
  { kinds: ['sequence'], label: 'sequences' },
  { kinds: ['function', 'procedure'], label: 'routines' },
];

const OBJECT_ICON: Record<ObjectKind, IconName> = {
  table: 'dbTable',
  foreign: 'dbTable',
  view: 'dbView',
  matview: 'dbView',
  sequence: 'dbSequence',
  function: 'dbRoutine',
  procedure: 'dbRoutine',
};

const ic = (name: IconName, cls = '') => <Icon name={name} size={15} className={'db-ic ' + cls} />;

export function DatabasePanel({ ws }: { ws: Workspace }) {
  const { sources, state } = useDb();
  /** Expanded nodes; for folders open by default, "key!" marks them closed. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setViewState] = useState<ViewOptions>(loadView);
  const [dialog, setDialog] = useState<{ source: DataSource | null } | null>(null);
  const [tableDialog, setTableDialog] = useState<TableDialogRequest | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; label: string; value: string; preview: (v: string) => string; run: (v: string) => Promise<void> } | null>(null);
  const tree = useRef<HTMLDivElement>(null);

  const setView = (patch: Partial<ViewOptions>) => {
    const next = { ...view, ...patch };
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      // This session only.
    }
  };

  const fail = (e: unknown) => ws.notify({ title: 'Database', body: String(e instanceof Error ? e.message : e), tone: 'error' });
  const isOpen = (key: string, byDefault = false) => (byDefault ? !open.has(key + '!') : open.has(key));
  const setNodeOpen = (n: TreeNode, value: boolean) => {
    setOpen((s) => {
      const next = new Set(s);
      if (n.defaultOpen) value ? next.delete(n.key + '!') : next.add(n.key + '!');
      else value ? next.add(n.key) : next.delete(n.key);
      return next;
    });
    if (value) n.load?.().catch(fail);
  };
  const toggleNode = (n: TreeNode) => !n.leaf && setNodeOpen(n, !n.open);

  // The sample project opens with its database expanded, to show something right away.
  useEffect(() => {
    if (sources.length === 1 && sources[0].driver === 'sample' && !open.size) {
      setOpen(new Set(['src:sample', 'sch:sample:acme_shop']));
      db.schemas('sample')
        .then(([schema]) => db.tables('sample', schema))
        .catch(fail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  /** Opening a data source loads its schemas (and on Postgres its databases), and opens the database. */
  const loadSource = async (ds: DataSource) => {
    const schemas = await db.schemas(ds.id);
    if (ds.driver === 'postgres') {
      await db.databases(ds.id).catch(() => null);
      setOpen((s) => new Set([...s, `db:${ds.id}`]));
    }
    // A single user schema (public) opens too.
    if (schemas.length === 1) {
      setOpen((s) => new Set([...s, `sch:${ds.id}:${schemas[0]}`]));
      await db.tables(ds.id, schemas[0]);
    }
  };

  const refresh = async (id: string) => {
    if (state[id]?.status !== 'connected') return;
    await db.schemas(id, true).catch(fail);
    const ds = db.get(id);
    if (ds?.driver === 'postgres') await db.databases(id).catch(() => null);
    for (const key of open) {
      const sch = key.match(/^sch:([^:]+):(.*)$/);
      if (sch && sch[1] === id) await db.tables(id, sch[2], true).catch(() => {});
      const tbl = key.match(/^obj:([^:]+):([^.]+)\.(.*)$/);
      if (tbl && tbl[1] === id) {
        db.columns(id, tbl[2], tbl[3], true).catch(() => {});
        db.details(id, tbl[2], tbl[3], true).catch(() => {});
      }
    }
    if (open.has(`roles:${id}`)) db.roles(id, true).catch(() => {});
  };

  // ── Build the visible tree ──────────────────────────────────

  const nodes: TreeNode[] = [];
  const extras = new Map<string, ReactNode>(); // error / password rows after a node

  const pushObjectElements = (ds: DataSource, schema: string, obj: TableInfo, depth: number) => {
    const key = `obj:${ds.id}:${schema}.${obj.name}`;
    const cols: Column[] = state[ds.id]?.columns[`${schema}.${obj.name}`] ?? [];
    const details = state[ds.id]?.details[`${schema}.${obj.name}`];
    const columnNodes = (d: number): TreeNode[] =>
      cols.map((c) => ({
        key: `${key}:col:${c.name}`,
        depth: d,
        kind: 'column',
        label: c.name,
        icon: c.key === 'pk' ? ic('dbKey', 'db-pk') : c.key === 'fk' || c.foreign ? ic('dbKey', 'db-fk') : c.key === 'uq' ? ic('dbKey', 'db-uq') : ic('dbColumn'),
        detail: view.columnDetails ? `${c.type}${c.default !== null && c.default !== undefined ? ` = ${c.default}` : ''}` : undefined,
        leaf: true,
        source: ds.id,
        schema,
        object: obj,
      }));
    const sections: { id: string; label: string; items: TreeNode[] }[] = [{ id: 'columns', label: 'columns', items: [] }];
    if (details && isRelation(obj.kind) && obj.kind !== 'view') {
      sections.push(
        {
          id: 'keys',
          label: 'keys',
          items: details.keys.map((k) => ({ key: `${key}:key:${k.name}`, depth: 0, kind: 'key', label: k.name, icon: ic('dbKey', k.kind === 'pk' ? 'db-pk' : 'db-uq'), detail: `(${k.columns})`, leaf: true, source: ds.id })),
        },
        {
          id: 'fks',
          label: 'foreign keys',
          items: details.foreignKeys.map((f) => ({
            key: `${key}:fk:${f.name}`,
            depth: 0,
            kind: 'fk',
            label: f.name,
            icon: ic('dbKey', 'db-fk'),
            detail: `(${f.columns}) → ${f.refTable}(${f.refColumns})`,
            leaf: true,
            source: ds.id,
          })),
        },
        {
          id: 'indexes',
          label: 'indexes',
          items: details.indexes.map((i) => ({ key: `${key}:idx:${i.name}`, depth: 0, kind: 'index', label: i.name, icon: ic('dbIndex'), detail: `(${i.columns})${i.unique ? ' UNIQUE' : ''}`, leaf: true, source: ds.id })),
        },
        {
          id: 'checks',
          label: 'checks',
          items: details.checks.map((c) => ({ key: `${key}:chk:${c.name}`, depth: 0, kind: 'check', label: c.name, icon: ic('check'), detail: c.definition, leaf: true, source: ds.id })),
        },
      );
    }
    if (!view.objectElements) {
      nodes.push(...columnNodes(depth));
      for (const s of sections.slice(1)) nodes.push(...s.items.map((n) => ({ ...n, depth })));
      return;
    }
    for (const s of sections) {
      const count = s.id === 'columns' ? cols.length : s.items.length;
      if (!count && !view.emptyGroups) continue;
      const gKey = `${key}:${s.id}`;
      const gOpen = isOpen(gKey);
      nodes.push({ key: gKey, depth, kind: 'elements', label: s.label, icon: ic('folder', 'db-folder'), detail: String(count), open: gOpen, source: ds.id, schema, object: obj });
      if (!gOpen) continue;
      nodes.push(...(s.id === 'columns' ? columnNodes(depth + 1) : s.items.map((n) => ({ ...n, depth: depth + 1 }))));
    }
  };

  const pushObject = (ds: DataSource, schema: string, obj: TableInfo, depth: number) => {
    const key = `obj:${ds.id}:${schema}.${obj.name}`;
    const expandable = isRelation(obj.kind);
    const oOpen = expandable && isOpen(key);
    nodes.push({
      key,
      depth,
      kind: 'object',
      label: obj.name,
      icon: ic(OBJECT_ICON[obj.kind]),
      leaf: !expandable,
      open: oOpen,
      source: ds.id,
      schema,
      object: obj,
      load: () => Promise.all([db.columns(ds.id, schema, obj.name), obj.kind === 'view' ? null : db.details(ds.id, schema, obj.name)]),
    });
    if (oOpen) pushObjectElements(ds, schema, obj, depth + 1);
  };

  const pushSchema = (ds: DataSource, schema: string, depth: number, system: boolean) => {
    const st = state[ds.id];
    const key = `sch:${ds.id}:${schema}`;
    const sOpen = isOpen(key);
    const objects = st?.tables[schema];
    nodes.push({ key, depth, kind: 'schema', label: schema, icon: ic('dbSchema'), open: sOpen, source: ds.id, schema, muted: system, load: () => db.tables(ds.id, schema) });
    if (!sOpen || !objects) return;
    if (!view.schemaObjects) {
      const order = GROUPS.flatMap((g) => g.kinds);
      [...objects].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name)).forEach((o) => pushObject(ds, schema, o, depth + 1));
      return;
    }
    for (const g of GROUPS) {
      const items = objects.filter((o) => g.kinds.includes(o.kind));
      if (!items.length && !view.emptyGroups) continue;
      const gKey = `grp:${ds.id}:${schema}:${g.label}`;
      const byDefault = g.label === 'tables';
      const gOpen = isOpen(gKey, byDefault);
      nodes.push({ key: gKey, depth: depth + 1, kind: 'group', label: g.label, icon: ic('folder', 'db-folder'), detail: String(items.length), open: gOpen, defaultOpen: byDefault, source: ds.id, schema });
      if (gOpen) items.forEach((o) => pushObject(ds, schema, o, depth + 2));
    }
  };

  for (const ds of sources) {
    const st = state[ds.id];
    const srcKey = `src:${ds.id}`;
    const sOpen = isOpen(srcKey);
    const dbs = st?.databases;
    const status = st?.status === 'connecting' ? 'connecting…' : st?.status === 'connected' ? undefined : st?.status === 'error' ? 'error' : undefined;
    nodes.push({
      key: srcKey,
      depth: 0,
      kind: 'source',
      label: ds.name,
      icon: ic('database', `db-src db-${ds.driver}`),
      pill: dbs ? `1 of ${dbs.all.length}` : undefined,
      detail: status,
      open: sOpen,
      source: ds.id,
      load: () => loadSource(ds),
    });
    if (!sOpen) continue;
    if (st?.status === 'error') {
      extras.set(
        srcKey,
        st.needsPassword ? (
          <PasswordPrompt key={`${srcKey}:pw`} ds={ds} error={st.error ?? ''} onConnected={() => loadSource(ds).catch(fail)} onProperties={() => setDialog({ source: ds })} />
        ) : (
          <div key={`${srcKey}:err`} className="db-error" style={{ paddingLeft: 40 }}>
            {st.error}
            <button type="button" className="link-btn" onClick={() => loadSource(ds).catch(() => {})}>
              Retry
            </button>
            {ds.driver !== 'sample' && (
              <button type="button" className="link-btn" onClick={() => setDialog({ source: ds })}>
                Properties…
              </button>
            )}
          </div>
        ),
      );
      continue;
    }
    const schemas = [...(st?.schemas ?? []), ...(view.allNamespaces ? st?.systemSchemas ?? [] : [])];
    const total = (st?.schemas?.length ?? 0) + (st?.systemSchemas?.length ?? 0);
    if (ds.driver === 'postgres') {
      // Postgres: the database this connection opened, then its schemas.
      const dKey = `db:${ds.id}`;
      const dOpen = isOpen(dKey);
      nodes.push({ key: dKey, depth: 1, kind: 'database', label: dbs?.current ?? ds.database ?? '', icon: ic('database', 'db-database'), pill: st?.schemas ? `${schemas.length} of ${total}` : undefined, open: dOpen, source: ds.id });
      if (dOpen) schemas.forEach((s) => pushSchema(ds, s, 2, !!st?.systemSchemas?.includes(s)));
    } else {
      schemas.forEach((s) => pushSchema(ds, s, 1, !!st?.systemSchemas?.includes(s)));
    }
    if (view.serverObjects && (ds.driver === 'postgres' || ds.driver === 'mysql') && st?.status === 'connected') {
      const svKey = `srv:${ds.id}`;
      const svOpen = isOpen(svKey);
      nodes.push({ key: svKey, depth: 1, kind: 'server', label: 'Server Objects', icon: ic('dbServer'), open: svOpen, source: ds.id });
      if (svOpen) {
        const rKey = `roles:${ds.id}`;
        const rOpen = isOpen(rKey);
        const roles = st.roles;
        nodes.push({ key: rKey, depth: 2, kind: 'roles', label: ds.driver === 'mysql' ? 'users' : 'roles', icon: ic('folder', 'db-folder'), detail: roles ? String(roles.length) : undefined, open: rOpen, source: ds.id, load: () => db.roles(ds.id) });
        if (rOpen)
          (roles ?? []).forEach((r) =>
            nodes.push({ key: `role:${ds.id}:${r.name}`, depth: 3, kind: 'role', label: r.name, icon: ic('dbRole', r.superuser ? 'db-super' : ''), detail: r.superuser ? 'superuser' : r.login ? undefined : 'no login', leaf: true, source: ds.id }),
          );
      }
    }
  }

  const selectedNode = nodes.find((n) => n.key === selected) ?? null;
  const selectedSource = selectedNode ? db.get(selectedNode.source) : sources[0];
  const connected = !!selectedSource && state[selectedSource.id]?.status === 'connected';

  // ── Actions ─────────────────────────────────────────────────

  const consoleItems = (id: string): ContextItem[] => [
    { label: 'New Query Console', icon: 'dbConsole', run: () => ws.openConsole(id, db.newConsole(id)) },
    { label: 'Default Query Console', icon: 'dbConsole', shortcut: 'Ctrl+Shift+F10', run: () => ws.openConsole(id) },
    { kind: 'sep' },
    { label: 'All', submenu: db.consoles(id).map((name) => ({ label: name, icon: 'dbConsole' as const, run: () => ws.openConsole(id, name) })) },
  ];

  /** Opens SQL (a DDL, a generated statement) in a new console of the data source. */
  const openSql = (id: string, sql: string) => ws.openConsole(id, db.newConsole(id), sql);

  const showDdl = (n: TreeNode) => {
    if (!n.object || !n.schema) return;
    db.ddl(n.source, n.schema, n.object.name, n.object.kind)
      .then((ddl) => openSql(n.source, ddl))
      .catch(fail);
  };

  const copyDdl = (n: TreeNode) => {
    if (!n.object || !n.schema) return;
    db.ddl(n.source, n.schema, n.object.name, n.object.kind)
      .then((ddl) => copyText(ws, ddl, 'DDL'))
      .catch(fail);
  };

  const generate = async (n: TreeNode, what: 'select' | 'insert' | 'update' | 'delete') => {
    const ds = db.get(n.source);
    if (!ds || !n.object || !n.schema) return;
    const cols = await db.columns(n.source, n.schema, n.object.name).catch(() => [] as Column[]);
    const d = ds.driver;
    const target = qualified(d, n.schema, n.object.name);
    const names = cols.map((c) => quoteIdent(d, c.name));
    const keys = cols.filter((c) => c.key === 'pk');
    const where = (keys.length ? keys : cols.slice(0, 1)).map((c) => `${quoteIdent(d, c.name)} = ?`).join(' AND ');
    const sql = {
      select: `SELECT ${names.length ? `\n    ${names.join(',\n    ')}\n` : '* '}FROM ${target};`,
      insert: `INSERT INTO ${target} (${names.join(', ')})\nVALUES (${cols.map(() => '?').join(', ')});`,
      update: `UPDATE ${target}\nSET ${cols.filter((c) => c.key !== 'pk').map((c) => `${quoteIdent(d, c.name)} = ?`).join(',\n    ')}\nWHERE ${where};`,
      delete: `DELETE FROM ${target}\nWHERE ${where};`,
    }[what];
    openSql(n.source, sql + '\n');
  };

  const rename = (n: TreeNode) => {
    const ds = db.get(n.source);
    if (!ds || !n.object || !n.schema || ds.driver === 'sample') return;
    const { schema, object } = n;
    setPrompt({
      title: `Rename ${object.kind === 'table' ? 'Table' : 'Object'}`,
      label: `Rename ${object.name} to:`,
      value: object.name,
      preview: (v) => renameSql(ds.driver, schema, object.name, v, object.kind),
      run: async (v) => {
        await db.query(n.source, renameSql(ds.driver, schema, object.name, v, object.kind));
        await db.tables(n.source, schema, true);
        setSelected(`obj:${n.source}:${schema}.${v}`);
      },
    });
  };

  const drop = async (n: TreeNode) => {
    const ds = db.get(n.source);
    if (!ds || !n.object || !n.schema || ds.driver === 'sample') return;
    const sql = dropSql(ds.driver, n.schema, n.object.name, n.object.kind);
    if (!(await confirmDialog(`Drop ${n.object.name}? This runs:\n\n${sql}\n\nIt cannot be undone.`))) return;
    try {
      await db.query(n.source, sql);
      await db.tables(n.source, n.schema, true);
    } catch (e) {
      fail(e);
    }
  };

  const removeSource = async (ds: DataSource) => {
    if (await confirmDialog(`Remove data source "${ds.name}"? Its saved password is deleted too.`)) {
      await db.remove(ds.id);
      setSelected(null);
    }
  };

  const menuFor = (n: TreeNode): ContextItem[] => {
    const ds = db.get(n.source);
    if (!ds) return [];
    const isConnected = state[ds.id]?.status === 'connected';
    const copyName = { label: 'Copy Name', icon: 'copy' as const, run: () => copyText(ws, n.label, 'name') };
    const canEdit = ds.driver !== 'sample' && isConnected;
    const newMenu: ContextItem = {
      label: 'New',
      icon: 'plus',
      submenu: [
        ...(n.schema ? [{ label: 'Table…', icon: 'dbTable' as const, disabled: !canEdit, run: () => setTableDialog({ source: ds.id, schema: n.schema! }) }] : []),
        { label: 'Query Console', icon: 'dbConsole', run: () => ws.openConsole(ds.id, db.newConsole(ds.id)) },
        { label: 'Data Source…', icon: 'database', disabled: ws.backend.kind !== 'disk', run: () => setDialog({ source: null }) },
      ],
    };
    switch (n.kind) {
      case 'source':
        return [
          newMenu,
          { label: 'Properties…', icon: 'gear', shortcut: 'Shift+Enter', disabled: ds.driver === 'sample', run: () => setDialog({ source: ds }) },
          { kind: 'sep' },
          { label: 'Query Console', icon: 'dbConsole', submenu: consoleItems(ds.id) },
          { label: 'Refresh', icon: 'refresh', shortcut: 'Ctrl+F5', disabled: !isConnected, run: () => refresh(ds.id) },
          isConnected
            ? { label: 'Disconnect', icon: 'disconnect', run: () => db.disconnect(ds.id) }
            : { label: 'Connect', run: () => setNodeOpen({ ...n, open: false }, true) },
          { kind: 'sep' },
          copyName,
          ...(ds.driver === 'sample' ? [] : [{ kind: 'sep' as const }, { label: 'Remove Data Source', shortcut: 'Delete', run: () => removeSource(ds) }]),
        ];
      case 'database':
      case 'schema':
        return [
          newMenu,
          { label: 'Query Console', icon: 'dbConsole', submenu: consoleItems(ds.id) },
          { label: 'Refresh', icon: 'refresh', disabled: !isConnected, run: () => (n.schema ? db.tables(ds.id, n.schema, true).catch(fail) : refresh(ds.id)) },
          { kind: 'sep' },
          copyName,
        ];
      case 'object': {
        const o = n.object!;
        const relation = isRelation(o.kind);
        const readonly = ds.driver === 'sample';
        return [
          newMenu,
          ...(o.kind === 'table' ? [{ label: 'Modify Table…', shortcut: 'Ctrl+F6', disabled: !canEdit, run: () => setTableDialog({ source: ds.id, schema: n.schema!, table: o.name }) }] : []),
          ...(relation ? [{ label: 'Edit Data', icon: 'dbTable' as const, shortcut: 'F4', run: () => ws.openTable(ds.id, n.schema!, o.name) }] : []),
          { label: 'Refresh', icon: 'refresh', run: () => (relation ? Promise.all([db.columns(ds.id, n.schema!, o.name, true), db.details(ds.id, n.schema!, o.name, true)]).catch(fail) : db.tables(ds.id, n.schema!, true)) },
          { kind: 'sep' },
          { label: 'Rename…', shortcut: 'F2', disabled: readonly || o.kind === 'function' || o.kind === 'procedure', run: () => rename(n) },
          { kind: 'sep' },
          {
            label: 'SQL Scripts',
            submenu: [
              { label: 'DDL in Console', shortcut: 'Ctrl+B', run: () => showDdl(n) },
              { label: 'Copy DDL', icon: 'copy', run: () => copyDdl(n) },
              ...(relation
                ? [
                    { kind: 'sep' as const },
                    { label: 'SELECT Statement', run: () => void generate(n, 'select') },
                    ...(o.kind === 'table' ? [
                      { label: 'INSERT Statement', run: () => void generate(n, 'insert') },
                      { label: 'UPDATE Statement', run: () => void generate(n, 'update') },
                      { label: 'DELETE Statement', run: () => void generate(n, 'delete') },
                    ] : []),
                  ]
                : []),
            ],
          },
          { label: 'Query Console', icon: 'dbConsole', submenu: consoleItems(ds.id) },
          { kind: 'sep' },
          copyName,
          { label: 'Copy Qualified Name', run: () => copyText(ws, `${n.schema}.${o.name}`, 'qualified name') },
          { kind: 'sep' },
          { label: 'Drop…', shortcut: 'Delete', disabled: readonly, run: () => void drop(n) },
        ];
      }
      case 'column':
        return [
          ...(n.object?.kind === 'table' ? [{ label: 'Modify Column…', shortcut: 'Ctrl+F6', disabled: !canEdit, run: () => setTableDialog({ source: ds.id, schema: n.schema!, table: n.object!.name, column: n.label }) }, { kind: 'sep' as const }] : []),
          { label: 'Edit Data', icon: 'dbTable', shortcut: 'F4', run: () => n.object && ws.openTable(ds.id, n.schema!, n.object.name) },
          { kind: 'sep' },
          copyName,
          { label: 'Copy Qualified Name', run: () => copyText(ws, `${n.schema}.${n.object?.name}.${n.label}`, 'qualified name') },
        ];
      case 'group':
        return [newMenu, { label: 'Refresh', icon: 'refresh', disabled: !isConnected, run: () => db.tables(ds.id, n.schema!, true).catch(fail) }];
      default:
        return [copyName];
    }
  };

  const viewMenu = (): ContextItem[] => [
    { label: 'View in Groups', head: true },
    { label: 'Server and Database Objects', checked: view.serverObjects, run: () => setView({ serverObjects: !view.serverObjects }) },
    { label: 'Schema Objects', checked: view.schemaObjects, run: () => setView({ schemaObjects: !view.schemaObjects }) },
    { label: 'Object Elements', checked: view.objectElements, run: () => setView({ objectElements: !view.objectElements }) },
    { kind: 'sep' },
    { label: 'Show Elements', head: true },
    { label: 'All Namespaces', checked: view.allNamespaces, run: () => setView({ allNamespaces: !view.allNamespaces }) },
    { label: 'Empty Groups', checked: view.emptyGroups, run: () => setView({ emptyGroups: !view.emptyGroups }) },
    { kind: 'sep' },
    { label: 'Node Details', head: true },
    { label: 'Column Types and Defaults', checked: view.columnDetails, run: () => setView({ columnDetails: !view.columnDetails }) },
  ];

  /** Double click / Enter: open data for tables and views, else expand. */
  const activate = (n: TreeNode) => {
    if (n.kind === 'object' && n.object && isRelation(n.object.kind)) ws.openTable(n.source, n.schema!, n.object.name);
    else if (n.kind === 'object' && n.object) showDdl(n);
    else if (n.kind === 'column' && n.object) ws.openTable(n.source, n.schema!, n.object.name);
    else toggleNode(n);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = nodes.findIndex((n) => n.key === selected);
    const n = nodes[i];
    const move = (to: number) => {
      const t = nodes[Math.max(0, Math.min(nodes.length - 1, to))];
      if (t) setSelected(t.key);
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? 0 : i - 1);
    else if (!n) return;
    else if (e.key === 'ArrowRight') n.leaf ? undefined : n.open ? move(i + 1) : setNodeOpen(n, true);
    else if (e.key === 'ArrowLeft') {
      if (n.open && !n.leaf) setNodeOpen(n, false);
      else {
        for (let j = i - 1; j >= 0; j--) if (nodes[j].depth < n.depth) return move(j);
      }
    } else if (e.key === 'Enter' && e.shiftKey && n.kind === 'source') setDialog({ source: db.get(n.source) ?? null });
    else if (e.key === 'Enter') activate(n);
    else if (e.key === 'F4') n.kind === 'source' ? setDialog({ source: db.get(n.source) ?? null }) : activate(n);
    else if (e.key === 'F6' && e.ctrlKey && (n.kind === 'object' || n.kind === 'column') && n.object?.kind === 'table' && db.get(n.source)?.driver !== 'sample')
      setTableDialog({ source: n.source, schema: n.schema!, table: n.object.name, column: n.kind === 'column' ? n.label : undefined });
    else if (e.key === 'F2' && n.kind === 'object') rename(n);
    else if (e.key === 'Delete' && n.kind === 'object') void drop(n);
    else if (e.key === 'Delete' && n.kind === 'source') {
      const ds = db.get(n.source);
      if (ds && ds.driver !== 'sample') void removeSource(ds);
    } else if (e.key === 'F5' && e.ctrlKey) void refresh(n.source);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    tree.current?.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const selectedObject = selectedNode?.object && (selectedNode.kind === 'object' || selectedNode.kind === 'column') ? selectedNode : null;

  return (
    <>
      <div className="tw-toolbar db-toolbar">
        <button
          type="button"
          className="icon-btn small"
          aria-label="New"
          title="New"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: r.left,
              y: r.bottom + 2,
              items: [
                { label: 'Data Source…', icon: 'database', disabled: ws.backend.kind !== 'disk', run: () => setDialog({ source: null }) },
                { label: 'Query Console', icon: 'dbConsole', disabled: !selectedSource, run: () => selectedSource && ws.openConsole(selectedSource.id, db.newConsole(selectedSource.id)) },
              ],
            });
          }}
        >
          <Icon name="plus" size={15} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Data source properties" title="Data Source Properties (Shift+Enter)" disabled={!selectedSource || selectedSource.driver === 'sample'} onClick={() => selectedSource && setDialog({ source: selectedSource })}>
          <Icon name="gear" size={14} />
        </button>
        <span className="strip-sep" />
        <button type="button" className="icon-btn small" aria-label="Refresh" title="Refresh (Ctrl+F5)" disabled={!connected} onClick={() => selectedSource && refresh(selectedSource.id)}>
          <Icon name="refresh" size={14} />
        </button>
        <button type="button" className={'icon-btn small' + (connected ? ' db-disconnect' : '')} aria-label="Disconnect" title="Disconnect" disabled={!connected} onClick={() => selectedSource && db.disconnect(selectedSource.id)}>
          <Icon name="disconnect" size={14} />
        </button>
        <span className="strip-sep" />
        <button
          type="button"
          className="icon-btn small"
          aria-label="Query consoles"
          title="Jump to Query Console (Ctrl+Shift+F10)"
          disabled={!selectedSource}
          onClick={(e) => {
            if (!selectedSource) return;
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2, items: [{ label: 'Query Consoles', head: true }, ...consoleItems(selectedSource.id)] });
          }}
        >
          <Icon name="dbConsole" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn small"
          aria-label="Edit data"
          title="Edit Data (F4)"
          disabled={!selectedObject || !isRelation(selectedObject.object!.kind)}
          onClick={() => selectedObject && ws.openTable(selectedObject.source, selectedObject.schema!, selectedObject.object!.name)}
        >
          <Icon name="dbTable" size={15} />
        </button>
        <button type="button" className="icon-btn small db-ddl" aria-label="DDL" title="Open DDL in Console (Ctrl+B)" disabled={!selectedObject} onClick={() => selectedObject && showDdl(selectedObject)}>
          DDL
        </button>
        <span className="strip-sep" />
        <button
          type="button"
          className="icon-btn small"
          aria-label="View options"
          title="View Options"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2, items: viewMenu() });
          }}
        >
          <Icon name="eye" size={15} />
        </button>
      </div>
      <div ref={tree} className="panel-body tree db-tree" role="tree" aria-label="Data sources" tabIndex={0} onKeyDown={onKeyDown}>
        {nodes.map((n) => (
          <div key={n.key} style={{ display: 'contents' }}>
            <div
              role="treeitem"
              aria-selected={n.key === selected}
              aria-expanded={n.leaf ? undefined : !!n.open}
              aria-level={n.depth + 1}
              className={'row' + (n.key === selected ? ' selected' : '')}
              style={{ paddingLeft: 4 + n.depth * 18 }}
              title={n.detail ? `${n.label}  ${n.detail}` : n.label}
              onClick={() => {
                setSelected(n.key);
                // Containers open on click, like folders; tables only select (expand with the arrow).
                if (n.kind !== 'object' && !n.leaf) toggleNode(n);
              }}
              onDoubleClick={() => (n.kind === 'object' || n.kind === 'column' ? activate(n) : undefined)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(n.key);
                setMenu({ x: e.clientX, y: e.clientY, items: menuFor(n) });
              }}
            >
              <span
                className={'chev' + (n.open ? ' open' : '')}
                style={{ visibility: n.leaf ? 'hidden' : 'visible' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(n.key);
                  toggleNode(n);
                }}
              >
                <Icon name="chevronRight" size={12} />
              </span>
              {n.icon}
              <span className={'name' + (n.muted ? ' muted' : '')}>{n.label}</span>
              {n.pill && <span className="db-pill">{n.pill}</span>}
              {n.detail && <span className="detail">{n.detail}</span>}
            </div>
            {extras.get(n.key)}
          </div>
        ))}
        {!sources.length && (
          <div className="empty db-empty">
            No data sources yet.
            <button type="button" className="link-btn" onClick={() => setDialog({ source: null })} disabled={ws.backend.kind !== 'disk'}>
              Add a data source
            </button>
            <span className="muted">PostgreSQL, MySQL / MariaDB or SQLite. Settings can come from your .env.</span>
          </div>
        )}
        {sources[0]?.driver === 'sample' && (
          <div className="empty" style={{ fontSize: 12 }}>
            Sample data. Open a project folder to connect to your databases.
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {tableDialog && <TableDialog ws={ws} request={tableDialog} onClose={() => setTableDialog(null)} />}
      {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} onError={fail} />}
      {dialog && (
        <DataSourceDialog
          ws={ws}
          source={dialog.source}
          onClose={(saved) => {
            setDialog(null);
            if (saved) {
              setSelected(`src:${saved.id}`);
              setOpen((s) => new Set([...s, `src:${saved.id}`]));
              loadSource(saved).catch(fail);
            }
          }}
        />
      )}
    </>
  );
}

/** A name to type, with the SQL it will run (Rename…). */
function PromptDialog({
  title,
  label,
  value,
  preview,
  run,
  onClose,
  onError,
}: {
  title: string;
  label: string;
  value: string;
  preview: (v: string) => string;
  run: (v: string) => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const ok = async () => {
    const v = text.trim();
    if (!v || v === value) return onClose();
    setBusy(true);
    try {
      await run(v);
      onClose();
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="jb-dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width: 460 }} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="jb-dialog-title">{title}</div>
        <div className="jb-dialog-body">
          <label htmlFor="db-prompt">{label}</label>
          <div className="field">
            <input id="db-prompt" ref={input} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void ok()} />
          </div>
          <pre className="db-prompt-preview">{preview(text.trim() || value)}</pre>
        </div>
        <div className="jb-dialog-buttons">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void ok()}>
            {busy ? 'Running…' : 'Refactor'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The server rejected the (missing or wrong) password: ask for it right there, like PhpStorm. */
function PasswordPrompt({ ds, error, onConnected, onProperties }: { ds: DataSource; error: string; onConnected: () => void; onProperties: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const connect = async () => {
    setBusy(true);
    if (await db.connect(ds.id, password)) onConnected();
    setBusy(false);
  };
  return (
    <div className="db-password" style={{ paddingLeft: 40 }}>
      <div className="db-error">{error}</div>
      <div className="db-password-row">
        <div className="field">
          <input
            ref={input}
            type="password"
            placeholder={`Password for ${ds.user || 'the user'}`}
            aria-label={`Password for ${ds.name}`}
            value={password}
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void connect();
              }
            }}
          />
        </div>
        <button type="button" className="btn small primary" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button type="button" className="link-btn" onClick={onProperties}>
          Properties…
        </button>
      </div>
    </div>
  );
}

export { driverName };

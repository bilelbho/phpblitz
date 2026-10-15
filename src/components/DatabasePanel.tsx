// Database tool window: data sources → schemas → tables / views → columns, loaded as you expand.

import { useEffect, useState, type ReactNode } from 'react';
import type { Workspace } from '../useWorkspace';
import { db, useDb } from '../db/store';
import { driverName, type DataSource, type KeyKind } from '../db/types';
import { Badge, Icon } from './Icon';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { DataSourceDialog } from './DataSourceDialog';
import { copyText } from '../editorMenu';
import { confirmDialog } from '../platform';

const KEY_BADGE: Record<KeyKind, [string, string]> = {
  pk: ['K', '#e8c37e'],
  fk: ['F', '#72b7f2'],
  uq: ['U', '#c6a0f6'],
};
const DRIVER_BADGE: Record<string, [string, string]> = {
  postgres: ['P', '#5e8fd6'],
  mysql: ['M', '#e3a869'],
  sqlite: ['S', '#7fb0d6'],
  sample: ['M', '#e3a869'],
};

type Selection = { kind: 'source'; id: string } | { kind: 'schema'; id: string; schema: string } | { kind: 'table'; id: string; schema: string; table: string } | null;

export function DatabasePanel({ ws }: { ws: Workspace }) {
  const { sources, state } = useDb();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Selection>(null);
  const [dialog, setDialog] = useState<{ source: DataSource | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);

  // The sample project opens with its database expanded, to show something right away.
  useEffect(() => {
    if (sources.length === 1 && sources[0].driver === 'sample' && !open.size) expand('src:sample', async () => {
        const [schema] = await db.schemas('sample');
        await db.tables('sample', schema);
        setOpen((s) => new Set([...s, `sch:sample:${schema}`]));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  const expand = (key: string, load?: () => Promise<unknown>) => {
    setOpen((s) => new Set([...s, key]));
    load?.().catch((e) => ws.notify({ title: 'Database', body: String(e instanceof Error ? e.message : e), tone: 'error' }));
  };
  const toggle = (key: string, load?: () => Promise<unknown>) => {
    if (open.has(key)) setOpen((s) => new Set([...s].filter((k) => k !== key)));
    else expand(key, load);
  };

  const selectedSource = selected ? db.get(selected.id) : sources[0];
  const refresh = async (id: string) => {
    const st = state[id];
    if (st?.status !== 'connected') return;
    await db.schemas(id, true).catch(() => {});
    for (const key of open) {
      const m = key.match(/^sch:([^:]+):(.*)$/);
      if (m && m[1] === id) db.tables(id, m[2], true).catch(() => {});
    }
  };
  const remove = async (ds: DataSource) => {
    if (await confirmDialog(`Remove data source "${ds.name}"? Its saved password is deleted too.`)) {
      await db.remove(ds.id);
      setSelected(null);
    }
  };

  const sourceMenu = (ds: DataSource): ContextItem[] => {
    const connected = state[ds.id]?.status === 'connected';
    return [
      { label: 'Open Query Console', icon: 'terminal', shortcut: 'Ctrl+Shift+F10', run: () => ws.openConsole(ds.id) },
      { kind: 'sep' },
      { label: 'Refresh', icon: 'refresh', disabled: !connected, run: () => refresh(ds.id) },
      connected ? { label: 'Disconnect', run: () => db.disconnect(ds.id) } : { label: 'Connect', run: () => toggle(`src:${ds.id}`, () => db.schemas(ds.id)) },
      { kind: 'sep' },
      { label: 'Copy Name', icon: 'copy', run: () => copyText(ws, ds.name, 'name') },
      ...(ds.driver === 'sample'
        ? []
        : [
            { label: 'Properties…', icon: 'gear' as const, run: () => setDialog({ source: ds }) },
            { label: 'Remove Data Source', run: () => remove(ds) },
          ]),
    ];
  };
  const tableMenu = (id: string, schema: string, table: string): ContextItem[] => [
    { label: 'Open Table', shortcut: 'F4', run: () => ws.openTable(id, schema, table) },
    { label: 'Open Query Console', icon: 'terminal', run: () => ws.openConsole(id) },
    { kind: 'sep' },
    { label: 'Copy Name', icon: 'copy', run: () => copyText(ws, table, 'table name') },
    { label: 'Copy Qualified Name', run: () => copyText(ws, `${schema}.${table}`, 'qualified name') },
    { kind: 'sep' },
    { label: 'Refresh Columns', icon: 'refresh', run: () => db.columns(id, schema, table, true) },
  ];

  const row = (
    key: string,
    depth: number,
    label: string,
    detail: ReactNode,
    badge: [string, string],
    opts: { leaf?: boolean; isOpen?: boolean; sel?: boolean; onClick?: () => void; onDouble?: () => void; onMenu?: (e: React.MouseEvent) => void; muted?: boolean } = {},
  ) => (
    <button
      key={key}
      type="button"
      className={'row' + (opts.sel ? ' selected' : '')}
      style={{ paddingLeft: 4 + depth * 18 }}
      onClick={opts.onClick}
      onDoubleClick={opts.onDouble}
      onContextMenu={(e) => {
        e.preventDefault();
        opts.onClick?.();
        opts.onMenu?.(e);
      }}
      aria-expanded={opts.leaf ? undefined : !!opts.isOpen}
    >
      <span className={'chev' + (opts.isOpen ? ' open' : '')} style={{ visibility: opts.leaf ? 'hidden' : 'visible' }}>
        <Icon name="chevronRight" size={12} strokeWidth={2.5} />
      </span>
      <Badge text={badge[0]} color={badge[1]} />
      <span className={'name' + (opts.muted ? ' muted' : '')}>{label}</span>
      <span className="detail">{detail}</span>
    </button>
  );

  const rows: ReactNode[] = [];
  for (const ds of sources) {
    const st = state[ds.id];
    const srcKey = `src:${ds.id}`;
    const srcOpen = open.has(srcKey);
    const status = st?.status === 'connecting' ? 'connecting…' : st?.status === 'connected' ? st.version?.split(/[,(]/)[0].slice(0, 40) : driverName(ds.driver);
    rows.push(
      row(srcKey, 0, ds.name, status, DRIVER_BADGE[ds.driver], {
        isOpen: srcOpen,
        sel: selected?.kind === 'source' && selected.id === ds.id,
        onClick: () => {
          setSelected({ kind: 'source', id: ds.id });
          toggle(srcKey, () => db.schemas(ds.id));
        },
        onMenu: (e) => setMenu({ x: e.clientX, y: e.clientY, items: sourceMenu(ds) }),
      }),
    );
    if (!srcOpen) continue;
    if (st?.status === 'error') {
      rows.push(
        <div key={`${srcKey}:err`} className="db-error" style={{ paddingLeft: 40 }}>
          {st.error}
          <button type="button" className="link-btn" onClick={() => db.schemas(ds.id).catch(() => {})}>
            Retry
          </button>
          {ds.driver !== 'sample' && (
            <button type="button" className="link-btn" onClick={() => setDialog({ source: ds })}>
              Properties…
            </button>
          )}
        </div>,
      );
      continue;
    }
    for (const schema of st?.schemas ?? []) {
      const schKey = `sch:${ds.id}:${schema}`;
      const schOpen = open.has(schKey);
      const tables = st?.tables[schema];
      rows.push(
        row(schKey, 1, schema, tables ? `${tables.length}` : '', ['S', '#9d8cf5'], {
          isOpen: schOpen,
          sel: selected?.kind === 'schema' && selected.id === ds.id && selected.schema === schema,
          onClick: () => {
            setSelected({ kind: 'schema', id: ds.id, schema });
            toggle(schKey, () => db.tables(ds.id, schema));
          },
          onMenu: (e) => setMenu({ x: e.clientX, y: e.clientY, items: [{ label: 'Open Query Console', icon: 'terminal', run: () => ws.openConsole(ds.id) }, { label: 'Refresh', icon: 'refresh', run: () => db.tables(ds.id, schema, true) }] }),
        }),
      );
      if (!schOpen || !tables) continue;
      for (const group of ['table', 'view'] as const) {
        const items = tables.filter((t) => t.kind === group);
        if (!items.length) continue;
        const grpKey = `grp:${ds.id}:${schema}:${group}`;
        // Tables start open (the common case); views start closed.
        const grpOpen = group === 'table' ? !open.has(grpKey + ':closed') : open.has(grpKey);
        rows.push(
          row(grpKey, 2, group === 'table' ? 'tables' : 'views', `${items.length}`, ['▤', '#5d6573'], {
            isOpen: grpOpen,
            onClick: () => (group === 'table' ? toggle(grpKey + ':closed') : toggle(grpKey)),
          }),
        );
        if (!grpOpen) continue;
        for (const t of items) {
          const tKey = `tbl:${ds.id}:${schema}.${t.name}`;
          const tOpen = open.has(tKey);
          const cols = st?.columns[`${schema}.${t.name}`];
          rows.push(
            row(tKey, 3, t.name, cols ? `${cols.length} columns` : '', group === 'table' ? ['T', '#5fc9be'] : ['V', '#7fb0d6'], {
              isOpen: tOpen,
              sel: selected?.kind === 'table' && selected.id === ds.id && selected.schema === schema && selected.table === t.name,
              onClick: () => {
                setSelected({ kind: 'table', id: ds.id, schema, table: t.name });
                toggle(tKey, () => db.columns(ds.id, schema, t.name));
              },
              onDouble: () => ws.openTable(ds.id, schema, t.name),
              onMenu: (e) => setMenu({ x: e.clientX, y: e.clientY, items: tableMenu(ds.id, schema, t.name) }),
            }),
          );
          if (!tOpen) continue;
          for (const c of cols ?? []) {
            rows.push(
              row(`col:${tKey}.${c.name}`, 4, c.name, `${c.type}${c.nullable ? '' : ' not null'}`, c.key ? KEY_BADGE[c.key] : ['c', '#5d6573'], {
                leaf: true,
                onDouble: () => ws.openTable(ds.id, schema, t.name),
              }),
            );
          }
        }
      }
    }
  }

  return (
    <>
      <div className="tw-toolbar">
        <button type="button" className="icon-btn small" aria-label="New data source" title="New Data Source" disabled={ws.backend.kind !== 'disk'} onClick={() => setDialog({ source: null })}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Refresh" title="Refresh" disabled={!selectedSource || state[selectedSource.id]?.status !== 'connected'} onClick={() => selectedSource && refresh(selectedSource.id)}>
          <Icon name="refresh" size={13} />
        </button>
        <button
          type="button"
          className="icon-btn small"
          aria-label="Data source properties"
          title="Properties"
          disabled={!selectedSource || selectedSource.driver === 'sample'}
          onClick={() => selectedSource && setDialog({ source: selectedSource })}
        >
          <Icon name="gear" size={13} />
        </button>
        <button type="button" className="btn small" style={{ border: 0 }} disabled={!selectedSource} onClick={() => selectedSource && ws.openConsole(selectedSource.id)}>
          <Icon name="terminal" size={13} />
          Query console
        </button>
      </div>
      <div className="panel-body tree">
        {rows}
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
      {dialog && (
        <DataSourceDialog
          ws={ws}
          source={dialog.source}
          onClose={(saved) => {
            setDialog(null);
            if (saved) {
              setSelected({ kind: 'source', id: saved.id });
              expand(`src:${saved.id}`, () => db.schemas(saved.id));
            }
          }}
        />
      )}
    </>
  );
}

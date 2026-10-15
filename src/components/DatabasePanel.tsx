import { useState, type ReactNode } from 'react';
import type { Workspace } from '../useWorkspace';
import { SAMPLE_DB, type ColumnKey } from '../mock';
import { Badge, Icon } from './Icon';

const KEY_BADGE: Record<NonNullable<ColumnKey>, [string, string]> = {
  pk: ['K', '#e8c37e'],
  fk: ['F', '#72b7f2'],
  uq: ['U', '#c6a0f6'],
};

export function DatabasePanel({ ws }: { ws: Workspace }) {
  const [open, setOpen] = useState<Set<string>>(new Set(['ds', 'schema', 'tables', 'users']));
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const node = (id: string, depth: number, label: string, detail: string, badge: [string, string], onClick: () => void, opts: { leaf?: boolean; selected?: boolean } = {}) => (
    <button
      key={id}
      type="button"
      className={'row' + (opts.selected ? ' selected' : '')}
      style={{ paddingLeft: 4 + depth * 18 }}
      onClick={onClick}
      aria-expanded={opts.leaf ? undefined : open.has(id)}
    >
      <span className={'chev' + (open.has(id) ? ' open' : '')} style={{ visibility: opts.leaf ? 'hidden' : 'visible' }}>
        <Icon name="chevronRight" size={12} strokeWidth={2.5} />
      </span>
      <Badge text={badge[0]} color={badge[1]} />
      <span className="name">{label}</span>
      <span className="detail">{detail}</span>
    </button>
  );

  const rows: ReactNode[] = [node('ds', 0, SAMPLE_DB.connection, SAMPLE_DB.engine, ['D', '#e3a869'], () => toggle('ds'))];
  if (open.has('ds')) {
    rows.push(node('schema', 1, SAMPLE_DB.schema, 'default', ['S', '#9d8cf5'], () => toggle('schema')));
    if (open.has('schema')) {
      const tables = Object.entries(SAMPLE_DB.tables);
      rows.push(node('tables', 2, 'tables', String(tables.length), ['▤', '#5d6573'], () => toggle('tables')));
      if (open.has('tables')) {
        for (const [name, table] of tables) {
          const active = ws.activeId === `table:${name}`;
          rows.push(
            node(`t:${name}`, 3, name, `${table.rows.length} rows`, ['T', '#5fc9be'], () => {
              ws.openTable(name);
              toggle(name);
            }, { selected: active }),
          );
          if (open.has(name)) {
            for (const col of table.columns) {
              rows.push(node(`c:${name}.${col.name}`, 4, col.name, col.type, col.key ? KEY_BADGE[col.key] : ['c', '#5d6573'], () => ws.openTable(name), { leaf: true }));
            }
          }
        }
      }
    }
  }

  return (
    <>
      <div className="tw-toolbar">
        <button type="button" className="icon-btn small" aria-label="New data source" title="New data source (coming soon)" disabled>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Refresh" title="Refresh (coming soon)" disabled>
          <Icon name="refresh" size={13} />
        </button>
        <button type="button" className="btn small" style={{ border: 0 }} onClick={() => ws.openTable('users')}>
          <Icon name="terminal" size={13} />
          Query console
        </button>
      </div>
      <div className="panel-body tree">
        {rows}
        <div className="empty" style={{ fontSize: 12 }}>
          This is sample data. Connecting to real databases comes later.
        </div>
      </div>
    </>
  );
}

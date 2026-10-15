// A table's data in an editor tab, like PhpStorm's table editor: pages, WHERE filter, sort by
// header, edit cells / add / delete rows, then Submit (Ctrl+Enter) or Revert.

import { useCallback, useEffect, useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { db, useDb } from '../db/store';
import { qualified, quoteIdent, quoteLiteral, rowMatch } from '../db/dialect';
import type { Column, QueryResult } from '../db/types';
import { DataGrid, type Cell } from './DataGrid';
import { Icon } from './Icon';

const PAGE_SIZES = [100, 500, 1000];

export function TableEditor({ ws, source, schema, table }: { ws: Workspace; source: string; schema: string; table: string }) {
  useDb();
  const ds = db.get(source);
  const [limit, setLimit] = useState(500);
  const [offset, setOffset] = useState(0);
  const [where, setWhere] = useState('');
  const [whereInput, setWhereInput] = useState('');
  const [orderBy, setOrderBy] = useState<{ column: string; desc: boolean } | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [meta, setMeta] = useState<Column[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pending changes, sent by Submit.
  const [edits, setEdits] = useState<Map<string, string | null>>(new Map());
  const [added, setAdded] = useState(0);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const pending = edits.size > 0 || added > 0 || deleted.size > 0;
  const editable = ds?.driver !== 'sample';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cols, page] = await Promise.all([db.columns(source, schema, table), db.page(source, { schema, table, where, orderBy, limit, offset })]);
      setMeta(cols);
      setResult(page.result);
      setTotal(page.total);
      setEdits(new Map());
      setAdded(0);
      setDeleted(new Set());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [source, schema, table, where, orderBy, limit, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = result?.columns ?? meta.map((c) => c.name);
  const baseRows = result?.rows ?? [];
  const rows = [...baseRows, ...Array.from({ length: added }, () => columns.map(() => null))];

  const onEdit = (cell: Cell, value: string | null) =>
    setEdits((m) => {
      const next = new Map(m);
      const original = cell.r < baseRows.length ? baseRows[cell.r][cell.c] : undefined;
      if (original === value) next.delete(`${cell.r}:${cell.c}`);
      else next.set(`${cell.r}:${cell.c}`, value);
      return next;
    });

  const deleteRows = (list: number[]) => {
    for (const r of list) {
      if (r >= baseRows.length) {
        // A row that isn't in the database yet: just drop it (only the last one can be dropped cleanly).
        if (r === baseRows.length + added - 1) {
          setAdded((n) => n - 1);
          setEdits((m) => new Map([...m].filter(([k]) => !k.startsWith(`${r}:`))));
        }
        continue;
      }
      setDeleted((s) => {
        const next = new Set(s);
        if (next.has(r)) next.delete(r);
        else next.add(r);
        return next;
      });
    }
  };

  /** The statements Submit runs, in order: updates, inserts, deletes. */
  const statements = (): string[] => {
    if (!ds) return [];
    const d = ds.driver;
    const target = qualified(d, schema, table);
    const out: string[] = [];
    const byRow = new Map<number, [number, string | null][]>();
    for (const [key, value] of edits) {
      const [r, c] = key.split(':').map(Number);
      byRow.set(r, [...(byRow.get(r) ?? []), [c, value]]);
    }
    for (const [r, changes] of byRow) {
      if (r >= baseRows.length || deleted.has(r)) continue;
      const set = changes.map(([c, v]) => `${quoteIdent(d, columns[c])} = ${quoteLiteral(d, v)}`).join(', ');
      out.push(`UPDATE ${target} SET ${set} WHERE ${rowMatch(d, meta, columns, baseRows[r])}`);
    }
    for (let r = baseRows.length; r < baseRows.length + added; r++) {
      const changes = byRow.get(r) ?? [];
      out.push(
        changes.length
          ? `INSERT INTO ${target} (${changes.map(([c]) => quoteIdent(d, columns[c])).join(', ')}) VALUES (${changes.map(([, v]) => quoteLiteral(d, v)).join(', ')})`
          : d === 'mysql'
            ? `INSERT INTO ${target} () VALUES ()`
            : `INSERT INTO ${target} DEFAULT VALUES`,
      );
    }
    for (const r of deleted) out.push(`DELETE FROM ${target} WHERE ${rowMatch(d, meta, columns, baseRows[r])}`);
    return out;
  };

  const submit = async () => {
    const list = statements();
    if (!list.length) return;
    if (!meta.some((c) => c.key === 'pk') && (edits.size || deleted.size)) {
      ws.notify({ title: 'No primary key', body: `${table} has no primary key, so rows are matched by all their values.`, tone: 'warning' });
    }
    setLoading(true);
    for (const sql of list) {
      try {
        const r = await db.query(source, sql);
        if (r.affected === 0) ws.notify({ title: 'No row changed', body: sql, tone: 'warning' });
      } catch (e) {
        setLoading(false);
        setError(`${String(e instanceof Error ? e.message : e)}\n\n${sql}`);
        return;
      }
    }
    ws.setStatus(`${list.length} change${list.length === 1 ? '' : 's'} submitted to ${table}`);
    await load();
  };

  const sortBy = (column: string) => {
    setOffset(0);
    setOrderBy((o) => (o?.column !== column ? { column, desc: false } : o.desc ? null : { column, desc: true }));
  };

  const last = total !== null ? Math.max(0, Math.floor((total - 1) / limit) * limit) : null;
  const shown = baseRows.length;

  return (
    <div
      className="table-editor"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
        if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && !pending)) {
          e.preventDefault();
          load();
        }
      }}
    >
      <div className="tw-toolbar te-toolbar">
        <button type="button" className="icon-btn small" title="First Page" aria-label="First page" disabled={offset === 0 || loading} onClick={() => setOffset(0)}>
          <span className="te-arrow">|‹</span>
        </button>
        <button type="button" className="icon-btn small" title="Previous Page" aria-label="Previous page" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>
          <span className="te-arrow">‹</span>
        </button>
        <span className="te-range">
          {shown ? `${offset + 1}-${offset + shown}` : '0'}
          {total !== null ? ` of ${total}` : ''}
        </span>
        <button type="button" className="icon-btn small" title="Next Page" aria-label="Next page" disabled={loading || (total !== null ? offset + limit >= total : shown < limit)} onClick={() => setOffset(offset + limit)}>
          <span className="te-arrow">›</span>
        </button>
        <button type="button" className="icon-btn small" title="Last Page" aria-label="Last page" disabled={loading || last === null || offset >= last} onClick={() => last !== null && setOffset(last)}>
          <span className="te-arrow">›|</span>
        </button>
        <select className="te-size" aria-label="Page size" value={limit} onChange={(e) => (setOffset(0), setLimit(Number(e.target.value)))}>
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} rows
            </option>
          ))}
        </select>
        <span className="te-sep" />
        <button type="button" className="icon-btn small" title="Reload Page (F5)" aria-label="Reload" disabled={loading} onClick={load}>
          <Icon name="refresh" size={13} />
        </button>
        {editable && (
          <>
            <button type="button" className="icon-btn small" title="Add Row" aria-label="Add row" onClick={() => setAdded((n) => n + 1)}>
              <Icon name="plus" size={14} />
            </button>
            <button type="button" className={'btn small te-submit' + (pending ? ' on' : '')} disabled={!pending || loading} onClick={submit} title={statements().join(';\n') || 'No changes'}>
              <Icon name="check" size={13} strokeWidth={2.6} />
              Submit
            </button>
            <button type="button" className="btn small ghost" disabled={!pending || loading} onClick={load}>
              <Icon name="rollback" size={13} />
              Revert
            </button>
          </>
        )}
        <span className="grow" />
        <span className="muted te-name">
          {ds?.name} · {schema}.{table}
        </span>
      </div>
      <div className="te-filter">
        <span className="te-filter-label">WHERE</span>
        <input
          className="te-where mono"
          value={whereInput}
          placeholder="e.g. status = 'paid' AND total > 100   (Enter to apply)"
          spellCheck={false}
          onChange={(e) => setWhereInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setOffset(0);
              setWhere(whereInput);
            }
            if (e.key === 'Escape' && whereInput) {
              setWhereInput('');
              setWhere('');
            }
          }}
        />
        <span className="te-filter-label">ORDER BY</span>
        <span className="mono te-order">{orderBy ? `${orderBy.column} ${orderBy.desc ? 'DESC' : 'ASC'}` : '—'}</span>
      </div>
      {error && (
        <div className="te-error">
          <pre>{error}</pre>
          <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" size={10} strokeWidth={2.5} />
          </button>
        </div>
      )}
      {result || meta.length ? (
        <DataGrid
          columns={columns}
          meta={meta}
          rows={rows}
          firstRow={offset + 1}
          sort={orderBy}
          onSort={sortBy}
          edits={editable ? edits : undefined}
          onEdit={editable ? onEdit : undefined}
          rowState={(r) => (r >= baseRows.length ? 'new' : deleted.has(r) ? 'deleted' : undefined)}
          onDeleteRows={editable ? deleteRows : undefined}
        />
      ) : (
        <div className="empty">{loading ? 'Loading…' : error ? '' : 'No data'}</div>
      )}
    </div>
  );
}

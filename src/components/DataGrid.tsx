// Result grid for tables and query results: sorting, keyboard navigation, in-place editing
// (double-click / Enter / F2), Set NULL, and copying cells or rows.

import { useEffect, useRef, useState } from 'react';
import type { Column } from '../db/types';
import { ContextMenu, type ContextItem } from './ContextMenu';

export type Cell = { r: number; c: number };
export type RowState = 'new' | 'deleted' | undefined;

interface Props {
  columns: string[];
  meta?: Column[];
  rows: (string | null)[][];
  /** Number shown on the first row (paging). */
  firstRow?: number;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  /** Editing: a value per changed cell, keyed "row:col". */
  edits?: Map<string, string | null>;
  onEdit?: (cell: Cell, value: string | null) => void;
  rowState?: (row: number) => RowState;
  onDeleteRows?: (rows: number[]) => void;
}

const NUMERIC = /^(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|real|double|float|money|serial|bigserial)/i;

export function DataGrid({ columns, meta, rows, firstRow = 1, sort, onSort, edits, onEdit, rowState, onDeleteRows }: Props) {
  const [sel, setSel] = useState<Cell | null>(rows.length && columns.length ? { r: 0, c: 0 } : null);
  const [editing, setEditing] = useState<{ cell: Cell; value: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const editable = !!onEdit;

  useEffect(() => {
    if (sel && (sel.r >= rows.length || sel.c >= columns.length)) setSel(rows.length && columns.length ? { r: Math.min(sel.r, rows.length - 1), c: Math.min(sel.c, columns.length - 1) } : null);
  }, [rows.length, columns.length, sel]);

  // Keep the selected cell in view.
  useEffect(() => {
    if (!sel) return;
    box.current?.querySelector(`[data-cell="${sel.r}:${sel.c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [sel]);

  const valueAt = (r: number, c: number) => (edits?.has(`${r}:${c}`) ? edits.get(`${r}:${c}`)! : rows[r]?.[c] ?? null);
  const numeric = (c: number) => {
    const m = meta?.find((x) => x.name === columns[c]);
    return m ? NUMERIC.test(m.type) : false;
  };

  const startEdit = (cell: Cell) => {
    if (!editable || rowState?.(cell.r) === 'deleted') return;
    setEditing({ cell, value: valueAt(cell.r, cell.c) ?? '' });
  };
  const commit = (value: string | null) => {
    if (editing && onEdit && value !== valueAt(editing.cell.r, editing.cell.c)) onEdit(editing.cell, value);
    setEditing(null);
    box.current?.focus();
  };

  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});
  const rowText = (r: number) => columns.map((_, c) => valueAt(r, c) ?? 'NULL').join('\t');

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || !sel) return;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setSel({ r: Math.max(0, Math.min(rows.length - 1, sel.r + dr)), c: Math.max(0, Math.min(columns.length - 1, sel.c + dc)) });
    };
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) move(0, 1);
    else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) move(0, -1);
    else if (e.key === 'PageDown') move(20, 0);
    else if (e.key === 'PageUp') move(-20, 0);
    else if (e.key === 'Home' && ctrl) move(-rows.length, -columns.length);
    else if (e.key === 'End' && ctrl) move(rows.length, columns.length);
    else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit(sel);
    } else if (ctrl && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copy(e.shiftKey ? rowText(sel.r) : valueAt(sel.r, sel.c) ?? 'NULL');
    } else if (ctrl && e.altKey && e.key.toLowerCase() === 'n' && editable) {
      e.preventDefault();
      onEdit!(sel, null);
    } else if (e.key === 'Delete' && onDeleteRows && ctrl) {
      e.preventDefault();
      onDeleteRows([sel.r]);
    } else if (editable && e.key.length === 1 && !ctrl && !e.altKey) {
      // Typing starts editing with that character, like a spreadsheet.
      e.preventDefault();
      if (rowState?.(sel.r) !== 'deleted') setEditing({ cell: sel, value: e.key });
    }
  };

  const cellMenu = (e: React.MouseEvent, cell: Cell) => {
    e.preventDefault();
    setSel(cell);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copy', shortcut: 'Ctrl+C', icon: 'copy', run: () => copy(valueAt(cell.r, cell.c) ?? 'NULL') },
        { label: 'Copy Row', shortcut: 'Ctrl+Shift+C', run: () => copy(rowText(cell.r)) },
        { label: 'Copy Column Name', run: () => copy(columns[cell.c]) },
        ...(editable
          ? [
              { kind: 'sep' as const },
              { label: 'Edit', shortcut: 'Enter', icon: 'pencil' as const, run: () => startEdit(cell) },
              { label: 'Set NULL', shortcut: 'Ctrl+Alt+N', run: () => onEdit!(cell, null) },
              ...(onDeleteRows ? [{ label: 'Delete Row', shortcut: 'Ctrl+Delete', run: () => onDeleteRows([cell.r]) }] : []),
            ]
          : []),
      ],
    });
  };

  if (!columns.length) return <div className="empty">No columns.</div>;
  return (
    <div ref={box} className="grid-wrap" tabIndex={0} onKeyDown={onKey}>
      <table className="grid">
        <thead>
          <tr>
            <th className="num" />
            {columns.map((name, c) => {
              const m = meta?.find((x) => x.name === name);
              const sorted = sort?.column === name;
              return (
                <th key={c} className={onSort ? 'sortable' : undefined} onClick={() => onSort?.(name)} title={m ? `${name}: ${m.type}${m.nullable ? '' : ' not null'}${m.default ? ` = ${m.default}` : ''}` : name}>
                  {m?.key && <span className={'key-mark ' + m.key}>{m.key === 'pk' ? 'PK' : m.key === 'fk' ? 'FK' : 'UQ'}</span>}
                  {name}
                  {m && <span className="col-type">{m.type}</span>}
                  {sorted && <span className="sort-mark">{sort!.desc ? '▼' : '▲'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const state = rowState?.(r);
            return (
              <tr key={r} className={state ? `row-${state}` : undefined}>
                <td className="num">{state === 'new' ? '+' : firstRow + r}</td>
                {row.map((_, c) => {
                  const v = valueAt(r, c);
                  const isSel = sel?.r === r && sel.c === c;
                  const changed = edits?.has(`${r}:${c}`);
                  if (editing && editing.cell.r === r && editing.cell.c === c) {
                    return (
                      <td key={c} className="editing">
                        <input
                          autoFocus
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onBlur={() => commit(editing.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commit(editing.value);
                            else if (e.key === 'Escape') {
                              setEditing(null);
                              box.current?.focus();
                            } else if (e.key === 'n' && (e.ctrlKey || e.metaKey) && e.altKey) {
                              e.preventDefault();
                              commit(null);
                            }
                          }}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={c}
                      data-cell={`${r}:${c}`}
                      className={(v === null ? 'null' : numeric(c) ? 'number' : '') + (isSel ? ' sel' : '') + (changed ? ' changed' : '')}
                      onMouseDown={() => setSel({ r, c })}
                      onDoubleClick={() => startEdit({ r, c })}
                      onContextMenu={(e) => cellMenu(e, { r, c })}
                      title={v !== null && v.length > 60 ? v.slice(0, 1000) : undefined}
                    >
                      {v === null ? '<null>' : v.length > 300 ? v.slice(0, 300) + '…' : v}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

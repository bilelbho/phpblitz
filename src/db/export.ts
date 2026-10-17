// Export of query results and table data: CSV, TSV, JSON, SQL INSERT statements, Markdown.

import { qualified, quoteIdent, quoteLiteral } from './dialect';
import type { Driver } from './types';

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; extension: string }[] = [
  { id: 'csv', label: 'CSV', extension: 'csv' },
  { id: 'tsv', label: 'TSV (tab-separated)', extension: 'tsv' },
  { id: 'json', label: 'JSON', extension: 'json' },
  { id: 'sql', label: 'SQL INSERT statements', extension: 'sql' },
  { id: 'markdown', label: 'Markdown table', extension: 'md' },
];

export interface ExportData {
  columns: string[];
  rows: (string | null)[][];
}

export interface ExportOptions {
  /** CSV / TSV: a first line with the column names. */
  header: boolean;
  /** SQL: the table the INSERTs go into, and its database (for quoting). */
  table?: { driver: Driver; schema: string; name: string };
  /** Columns whose values are numbers (written unquoted in JSON). */
  numeric?: Set<string>;
}

/** RFC 4180: fields with the separator, quotes or line breaks are quoted; NULL is empty. */
function delimited(data: ExportData, sep: string, header: boolean): string {
  const field = (v: string | null) => (v === null ? '' : /["\r\n]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = data.rows.map((r) => r.map(field).join(sep));
  if (header) lines.unshift(data.columns.map(field).join(sep));
  return lines.join('\r\n') + '\r\n';
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function json(data: ExportData, known?: Set<string>): string {
  // Without column types (a query result): columns whose every value is a plain number.
  const numeric = known ?? new Set(data.columns.filter((_, i) => data.rows.some((r) => r[i] !== null) && data.rows.every((r) => r[i] === null || NUMBER.test(r[i]!))));
  const value = (column: string, v: string | null) => (v !== null && numeric.has(column) && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
  return JSON.stringify(data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, value(c, r[i])]))), null, 2) + '\n';
}

function sql(data: ExportData, table: NonNullable<ExportOptions['table']>): string {
  const target = table.schema ? qualified(table.driver, table.schema, table.name) : quoteIdent(table.driver, table.name);
  const columns = data.columns.map((c) => quoteIdent(table.driver, c)).join(', ');
  return data.rows.map((r) => `INSERT INTO ${target} (${columns}) VALUES (${r.map((v) => quoteLiteral(table.driver, v)).join(', ')});`).join('\n') + '\n';
}

function markdown(data: ExportData): string {
  const cell = (v: string | null) => (v === null ? '*NULL*' : v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'));
  return [`| ${data.columns.map(cell).join(' | ')} |`, `| ${data.columns.map(() => '---').join(' | ')} |`, ...data.rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
}

export function exportText(format: ExportFormat, data: ExportData, options: ExportOptions): string {
  switch (format) {
    case 'csv':
      return delimited(data, ',', options.header);
    case 'tsv':
      return delimited(data, '\t', options.header);
    case 'json':
      return json(data, options.numeric);
    case 'sql':
      return sql(data, options.table ?? { driver: 'postgres', schema: '', name: 'result' });
    case 'markdown':
      return markdown(data);
  }
}

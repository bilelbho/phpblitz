// SQL that differs per database: quoting, the schema tree and table pages.

import type { Column, Driver, KeyKind, QueryResult, TableInfo } from './types';

export function quoteIdent(driver: Driver, name: string): string {
  return driver === 'mysql' || driver === 'sample' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"';
}

/** A value as an SQL literal: NULL, a number, or a quoted string. */
export function quoteLiteral(driver: Driver, value: string | null): string {
  if (value === null) return 'NULL';
  // MySQL treats backslashes in strings as escapes by default.
  const escaped = driver === 'mysql' ? value.replace(/\\/g, '\\\\').replace(/'/g, "''") : value.replace(/'/g, "''");
  return `'${escaped}'`;
}

export function qualified(driver: Driver, schema: string, table: string): string {
  return driver === 'sqlite' ? quoteIdent(driver, table) : `${quoteIdent(driver, schema)}.${quoteIdent(driver, table)}`;
}

export const schemasSql = (driver: Driver) =>
  driver === 'postgres'
    ? `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema') AND schema_name NOT LIKE 'pg\\_toast%' AND schema_name NOT LIKE 'pg\\_temp%'
       ORDER BY schema_name = 'public' DESC, schema_name`
    : driver === 'mysql'
      ? `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY schema_name`
      : `SELECT 'main'`;

export const tablesSql = (driver: Driver, schema: string) =>
  driver === 'sqlite'
    ? `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`
    : `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ${quoteLiteral(driver, schema)} ORDER BY table_name`;

export function parseTables(r: QueryResult): TableInfo[] {
  return r.rows.map(([name, type]) => ({ name: name ?? '', kind: /view/i.test(type ?? '') ? 'view' : 'table' }));
}

/** Columns with their key kind (one query; SQLite needs two pragmas, see columnsSqlite). */
export const columnsSql = (driver: Driver, schema: string, table: string) => {
  const s = quoteLiteral(driver, schema);
  const t = quoteLiteral(driver, table);
  if (driver === 'postgres') {
    return `SELECT c.column_name,
        CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
             WHEN c.character_maximum_length IS NOT NULL THEN c.data_type || '(' || c.character_maximum_length || ')'
             ELSE c.data_type END,
        c.is_nullable, c.column_default,
        (SELECT string_agg(tc.constraint_type, ',') FROM information_schema.key_column_usage k
           JOIN information_schema.table_constraints tc ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema
          WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name)
      FROM information_schema.columns c WHERE c.table_schema = ${s} AND c.table_name = ${t} ORDER BY c.ordinal_position`;
  }
  return `SELECT c.column_name, c.column_type, c.is_nullable, c.column_default,
      CONCAT_WS(',',
        IF(c.column_key = 'PRI', 'PRIMARY KEY', NULL),
        IF(c.column_key = 'UNI', 'UNIQUE', NULL),
        IF(EXISTS(SELECT 1 FROM information_schema.key_column_usage k WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                  AND k.column_name = c.column_name AND k.referenced_table_name IS NOT NULL), 'FOREIGN KEY', NULL))
    FROM information_schema.columns c WHERE c.table_schema = ${s} AND c.table_name = ${t} ORDER BY c.ordinal_position`;
};

export function parseColumns(r: QueryResult): Column[] {
  return r.rows.map(([name, type, nullable, def, keys]) => ({
    name: name ?? '',
    type: type ?? '',
    nullable: /^yes$/i.test(nullable ?? ''),
    default: def,
    key: keyOf(keys ?? ''),
  }));
}

function keyOf(keys: string): KeyKind | undefined {
  if (/PRIMARY/i.test(keys)) return 'pk';
  if (/FOREIGN/i.test(keys)) return 'fk';
  if (/UNIQUE/i.test(keys)) return 'uq';
  return undefined;
}

export const sqliteColumnsSql = (table: string) => [`PRAGMA table_info(${quoteLiteral('sqlite', table)})`, `PRAGMA foreign_key_list(${quoteLiteral('sqlite', table)})`];

export function parseSqliteColumns(info: QueryResult, fks: QueryResult): Column[] {
  const fkFrom = new Set(fks.rows.map((r) => r[fks.columns.indexOf('from')]));
  return info.rows.map((r) => {
    const get = (c: string) => r[info.columns.indexOf(c)];
    const name = get('name') ?? '';
    return {
      name,
      type: (get('type') ?? '').toLowerCase(),
      nullable: get('notnull') === '0',
      default: get('dflt_value'),
      key: get('pk') !== '0' ? 'pk' : fkFrom.has(name) ? 'fk' : undefined,
    };
  });
}

export interface PageRequest {
  schema: string;
  table: string;
  where: string;
  orderBy: { column: string; desc: boolean } | null;
  limit: number;
  offset: number;
}

export function pageSql(driver: Driver, p: PageRequest): string {
  let sql = `SELECT * FROM ${qualified(driver, p.schema, p.table)}`;
  if (p.where.trim()) sql += ` WHERE ${p.where.trim()}`;
  if (p.orderBy) sql += ` ORDER BY ${quoteIdent(driver, p.orderBy.column)} ${p.orderBy.desc ? 'DESC' : 'ASC'}`;
  return `${sql} LIMIT ${p.limit} OFFSET ${p.offset}`;
}

export function countSql(driver: Driver, schema: string, table: string, where: string): string {
  return `SELECT COUNT(*) FROM ${qualified(driver, schema, table)}${where.trim() ? ` WHERE ${where.trim()}` : ''}`;
}

/** WHERE clause matching one row: by primary key, else by every column's original value. */
export function rowMatch(driver: Driver, columns: Column[], resultColumns: string[], row: (string | null)[]): string {
  const keys = columns.filter((c) => c.key === 'pk');
  const use = keys.length ? keys : columns;
  return use
    .map((c) => {
      const v = row[resultColumns.indexOf(c.name)];
      return v === null || v === undefined ? `${quoteIdent(driver, c.name)} IS NULL` : `${quoteIdent(driver, c.name)} = ${quoteLiteral(driver, v)}`;
    })
    .join(' AND ');
}

// SQL that differs per database: quoting, the schema tree and table pages.

import type { Column, Constraint, Driver, IndexInfo, KeyKind, ObjectKind, QueryResult, RoleInfo, TableDetails, TableInfo } from './types';

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

/** Schemas, with a second column "1" for system ones (pg_catalog, information_schema…). */
export const schemasSql = (driver: Driver) =>
  driver === 'postgres'
    ? `SELECT nspname, CASE WHEN nspname IN ('pg_catalog', 'information_schema') THEN '1' ELSE '0' END FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
       ORDER BY nspname IN ('pg_catalog', 'information_schema'), nspname = 'public' DESC, nspname`
    : driver === 'mysql'
      ? `SELECT schema_name, CASE WHEN schema_name IN ('information_schema', 'mysql', 'performance_schema', 'sys') THEN '1' ELSE '0' END
         FROM information_schema.schemata ORDER BY 2, schema_name`
      : `SELECT 'main', '0'`;

/** Postgres: the databases on the server (a connection opens one of them). */
export const databasesSql = (driver: Driver) =>
  driver === 'postgres' ? `SELECT datname, CASE WHEN datname = current_database() THEN '1' ELSE '0' END FROM pg_database WHERE NOT datistemplate ORDER BY datname` : null;

export const rolesSql = (driver: Driver) =>
  driver === 'postgres'
    ? `SELECT rolname, CASE WHEN rolsuper THEN '1' ELSE '0' END, CASE WHEN rolcanlogin THEN '1' ELSE '0' END FROM pg_roles ORDER BY rolname LIKE 'pg\\_%', rolname`
    : driver === 'mysql'
      ? `SELECT CONCAT(user, '@', host), CASE WHEN super_priv = 'Y' THEN '1' ELSE '0' END, '1' FROM mysql.user ORDER BY user`
      : null;

export function parseRoles(r: QueryResult): RoleInfo[] {
  return r.rows.map(([name, su, login]) => ({ name: name ?? '', superuser: su === '1', login: login === '1' }));
}

/** Everything in a schema: tables, views, materialized views, sequences, functions, procedures. */
export const tablesSql = (driver: Driver, schema: string) => {
  const s = quoteLiteral(driver, schema);
  if (driver === 'sqlite') return `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`;
  if (driver === 'postgres')
    return `SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign' ELSE 'table' END
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${s} AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND NOT c.relispartition
      UNION ALL
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = ${s} AND p.prokind IN ('f', 'p')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`;
  return `SELECT table_name, CASE table_type WHEN 'VIEW' THEN 'view' WHEN 'SYSTEM VIEW' THEN 'view' ELSE 'table' END FROM information_schema.tables WHERE table_schema = ${s}
    UNION ALL SELECT routine_name, LOWER(routine_type) FROM information_schema.routines WHERE routine_schema = ${s}
    ORDER BY 1`;
};

const KINDS: ObjectKind[] = ['table', 'view', 'matview', 'foreign', 'sequence', 'function', 'procedure'];

export function parseTables(r: QueryResult): TableInfo[] {
  return r.rows.map(([name, type]) => {
    const t = (type ?? '').toLowerCase();
    return { name: name ?? '', kind: KINDS.includes(t as ObjectKind) ? (t as ObjectKind) : /view/.test(t) ? 'view' : 'table' };
  });
}

/** Keys, foreign keys and checks of a table: name, kind, columns, referenced table and columns, check expression. */
export function constraintsSql(driver: Driver, schema: string, table: string): string {
  const s = quoteLiteral(driver, schema);
  const t = quoteLiteral(driver, table);
  if (driver === 'postgres') {
    const cols = (arr: string, rel: string) =>
      `(SELECT string_agg(a.attname, ', ' ORDER BY k.ord) FROM unnest(${arr}) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.attnum)`;
    return `SELECT con.conname, CASE con.contype WHEN 'p' THEN 'pk' WHEN 'u' THEN 'uq' WHEN 'f' THEN 'fk' ELSE 'check' END,
        ${cols('con.conkey', 'con.conrelid')},
        CASE WHEN con.contype = 'f' THEN (SELECT nf.nspname || '.' || cf.relname FROM pg_class cf JOIN pg_namespace nf ON nf.oid = cf.relnamespace WHERE cf.oid = con.confrelid) END,
        CASE WHEN con.contype = 'f' THEN ${cols('con.confkey', 'con.confrelid')} END,
        CASE WHEN con.contype = 'c' THEN pg_get_constraintdef(con.oid) END,
        CASE WHEN con.contype = 'f' THEN ${FK_RULE_PG('con.confdeltype')} END,
        CASE WHEN con.contype = 'f' THEN ${FK_RULE_PG('con.confupdtype')} END
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${s} AND c.relname = ${t} AND con.contype IN ('p', 'u', 'f', 'c')
     ORDER BY con.contype = 'p' DESC, con.conname`;
  }
  if (driver === 'mysql')
    return `SELECT tc.constraint_name, CASE tc.constraint_type WHEN 'PRIMARY KEY' THEN 'pk' WHEN 'UNIQUE' THEN 'uq' WHEN 'FOREIGN KEY' THEN 'fk' ELSE 'check' END,
        GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position SEPARATOR ', '),
        MAX(CONCAT(k.referenced_table_schema, '.', k.referenced_table_name)),
        GROUP_CONCAT(k.referenced_column_name ORDER BY k.ordinal_position SEPARATOR ', '), NULL, MAX(rc.delete_rule), MAX(rc.update_rule)
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage k ON k.constraint_schema = tc.constraint_schema AND k.table_name = tc.table_name AND k.constraint_name = tc.constraint_name
      LEFT JOIN information_schema.referential_constraints rc ON rc.constraint_schema = tc.constraint_schema AND rc.constraint_name = tc.constraint_name
     WHERE tc.table_schema = ${s} AND tc.table_name = ${t}
     GROUP BY tc.constraint_name, tc.constraint_type ORDER BY tc.constraint_type = 'PRIMARY KEY' DESC, tc.constraint_name`;
  // SQLite: the primary key from table_info, foreign keys from foreign_key_list.
  return `SELECT 'pk_' || ${t}, 'pk', group_concat(name, ', '), NULL, NULL, NULL FROM (SELECT name FROM pragma_table_info(${t}) WHERE pk > 0 ORDER BY pk) HAVING count(*) > 0
    UNION ALL
    SELECT 'fk_' || ${t} || '_' || id, 'fk', group_concat("from", ', '), "table", group_concat("to", ', '), NULL, MAX(on_delete), MAX(on_update) FROM pragma_foreign_key_list(${t}) GROUP BY id`;
}

export function parseConstraints(r: QueryResult): Omit<TableDetails, 'indexes'> {
  const all: Constraint[] = r.rows.map(([name, kind, columns, refTable, refColumns, definition, onDelete, onUpdate]) => ({
    name: name ?? '',
    kind: (kind as Constraint['kind']) ?? 'check',
    columns: columns ?? '',
    refTable: refTable ?? undefined,
    refColumns: refColumns ?? undefined,
    definition: definition ?? undefined,
    onDelete: onDelete ?? undefined,
    onUpdate: onUpdate ?? undefined,
  }));
  return { keys: all.filter((c) => c.kind === 'pk' || c.kind === 'uq'), foreignKeys: all.filter((c) => c.kind === 'fk'), checks: all.filter((c) => c.kind === 'check') };
}

const FK_RULE_PG = (col: string) => `CASE ${col} WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END`;

/** A table's comment (Postgres, MySQL). */
export function tableCommentSql(driver: Driver, schema: string, table: string): string | null {
  if (driver === 'postgres') return `SELECT obj_description(${quoteLiteral(driver, `${quoteIdent(driver, schema)}.${quoteIdent(driver, table)}`)}::regclass, 'pg_class')`;
  if (driver === 'mysql') return `SELECT NULLIF(table_comment, '') FROM information_schema.tables WHERE table_schema = ${quoteLiteral(driver, schema)} AND table_name = ${quoteLiteral(driver, table)}`;
  return null;
}

/** Indexes: name, unique, primary, columns, definition. */
export function indexesSql(driver: Driver, schema: string, table: string): string {
  const s = quoteLiteral(driver, schema);
  const t = quoteLiteral(driver, table);
  if (driver === 'postgres')
    return `SELECT ic.relname, CASE WHEN i.indisunique THEN '1' ELSE '0' END, CASE WHEN i.indisprimary THEN '1' ELSE '0' END,
        (SELECT string_agg(COALESCE(a.attname, pg_get_indexdef(i.indexrelid, k.ord::int, true)), ', ' ORDER BY k.ord)
           FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum),
        pg_get_indexdef(i.indexrelid)
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${s} AND c.relname = ${t} ORDER BY ic.relname`;
  if (driver === 'mysql')
    return `SELECT index_name, CASE WHEN MIN(non_unique) = 0 THEN '1' ELSE '0' END, CASE WHEN index_name = 'PRIMARY' THEN '1' ELSE '0' END,
        GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', '), NULL
      FROM information_schema.statistics WHERE table_schema = ${s} AND table_name = ${t} GROUP BY index_name ORDER BY index_name`;
  return `SELECT il.name, il."unique", CASE WHEN il.origin = 'pk' THEN '1' ELSE '0' END, (SELECT group_concat(ii.name, ', ') FROM pragma_index_info(il.name) ii), m.sql
      FROM pragma_index_list(${t}) il LEFT JOIN sqlite_master m ON m.type = 'index' AND m.name = il.name ORDER BY il.name`;
}

export function parseIndexes(r: QueryResult): IndexInfo[] {
  return r.rows.map(([name, unique, primary, columns, definition]) => ({ name: name ?? '', unique: unique === '1', primary: primary === '1', columns: columns ?? '', definition: definition ?? undefined }));
}

/** PhpStorm-style short types: varchar(191), timestamp(0), timestamptz, int… */
export function shortType(type: string): string {
  return type
    .replace(/^character varying/, 'varchar')
    .replace(/^character\b/, 'char')
    .replace(/^timestamp(\(\d+\))? without time zone$/, 'timestamp$1')
    .replace(/^timestamp(\(\d+\))? with time zone$/, 'timestamptz$1')
    .replace(/^time(\(\d+\))? without time zone$/, 'time$1')
    .replace(/^time(\(\d+\))? with time zone$/, 'timetz$1');
}

/** Columns with their key kind (one query; SQLite needs two pragmas, see columnsSqlite). */
export const columnsSql = (driver: Driver, schema: string, table: string) => {
  const s = quoteLiteral(driver, schema);
  const t = quoteLiteral(driver, table);
  if (driver === 'postgres') {
    return `SELECT a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, pg_get_expr(d.adbin, d.adrelid),
        (SELECT string_agg(CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY' ELSE 'UNIQUE' END, ',')
           FROM pg_constraint con WHERE con.conrelid = a.attrelid AND a.attnum = ANY (con.conkey) AND con.contype IN ('p', 'f', 'u')),
        col_description(a.attrelid, a.attnum)
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = ${s} AND c.relname = ${t} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
  }
  return `SELECT c.column_name, c.column_type, c.is_nullable, c.column_default,
      CONCAT_WS(',',
        IF(c.column_key = 'PRI', 'PRIMARY KEY', NULL),
        IF(c.column_key = 'UNI', 'UNIQUE', NULL),
        IF(EXISTS(SELECT 1 FROM information_schema.key_column_usage k WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                  AND k.column_name = c.column_name AND k.referenced_table_name IS NOT NULL), 'FOREIGN KEY', NULL)),
      NULLIF(c.column_comment, '')
    FROM information_schema.columns c WHERE c.table_schema = ${s} AND c.table_name = ${t} ORDER BY c.ordinal_position`;
};

export function parseColumns(r: QueryResult): Column[] {
  return r.rows.map(([name, type, nullable, def, keys, comment]) => ({
    name: name ?? '',
    type: shortType(type ?? ''),
    nullable: /^yes$/i.test(nullable ?? ''),
    default: def,
    key: keyOf(keys ?? ''),
    foreign: /FOREIGN/i.test(keys ?? ''),
    comment: comment ?? undefined,
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

// ── DDL ─────────────────────────────────────────────────────────

/** Identifiers that need no quotes stay bare (Postgres folds unquoted names to lower case). */
function ddlIdent(driver: Driver, name: string): string {
  if (driver === 'postgres' && /^[a-z_][a-z0-9_$]*$/.test(name) && !PG_RESERVED.has(name)) return name;
  if (driver === 'mysql' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name;
  return quoteIdent(driver, name);
}
const PG_RESERVED = new Set(['user', 'order', 'group', 'table', 'select', 'where', 'from', 'to', 'limit', 'offset', 'default', 'check', 'column', 'constraint', 'primary', 'foreign', 'references', 'unique', 'all', 'and', 'or', 'not', 'null', 'end', 'case', 'when', 'desc', 'asc', 'grant', 'role', 'analyse', 'analyze', 'array', 'both', 'cast', 'collate', 'create', 'current_date', 'current_time', 'current_user', 'distinct', 'do', 'else', 'except', 'false', 'fetch', 'for', 'having', 'in', 'initially', 'intersect', 'into', 'leading', 'offset', 'only', 'placing', 'returning', 'session_user', 'some', 'symmetric', 'then', 'trailing', 'true', 'union', 'using', 'variadic', 'window', 'with']);

/** CREATE TABLE built from the catalog (Postgres): columns, keys, foreign keys, checks, then other indexes. */
export function tableDdl(driver: Driver, schema: string, table: string, columns: Column[], details: TableDetails): string {
  const q = (n: string) => ddlIdent(driver, n);
  const cols = (list: string) => list.split(/,\s*/).filter(Boolean).map(q).join(', ');
  const lines = columns.map((c) => `    ${q(c.name)} ${c.type}${c.default !== null && c.default !== undefined ? ` DEFAULT ${c.default}` : ''}${c.nullable ? '' : ' NOT NULL'}`);
  for (const k of details.keys) lines.push(`    CONSTRAINT ${q(k.name)} ${k.kind === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'} (${cols(k.columns)})`);
  for (const f of details.foreignKeys) {
    const [refSchema, refTable] = f.refTable?.includes('.') ? f.refTable.split('.') : [schema, f.refTable ?? ''];
    lines.push(`    CONSTRAINT ${q(f.name)} FOREIGN KEY (${cols(f.columns)}) REFERENCES ${q(refSchema)}.${q(refTable)} (${cols(f.refColumns ?? '')})`);
  }
  for (const c of details.checks) lines.push(`    CONSTRAINT ${q(c.name)} ${c.definition ?? ''}`);
  const constraintNames = new Set([...details.keys, ...details.foreignKeys].map((k) => k.name));
  const indexes = details.indexes.filter((i) => !constraintNames.has(i.name) && i.definition).map((i) => `${i.definition};`);
  return `CREATE TABLE ${q(schema)}.${q(table)}\n(\n${lines.join(',\n')}\n);\n${indexes.length ? `\n${indexes.join('\n')}\n` : ''}`;
}

/** Where the server keeps a DDL we can read as is (MySQL, SQLite, Postgres views and routines). */
export function storedDdlSql(driver: Driver, schema: string, name: string, kind: ObjectKind): string | null {
  if (driver === 'mysql') {
    if (kind === 'function' || kind === 'procedure') return `SHOW CREATE ${kind.toUpperCase()} ${qualified(driver, schema, name)}`;
    return `SHOW CREATE ${kind === 'view' ? 'VIEW' : 'TABLE'} ${qualified(driver, schema, name)}`;
  }
  if (driver === 'sqlite') return `SELECT sql || ';' FROM sqlite_master WHERE tbl_name = ${quoteLiteral(driver, name)} AND sql IS NOT NULL ORDER BY type = 'table' DESC, name`;
  if (driver === 'postgres') {
    if (kind === 'function' || kind === 'procedure') return `SELECT pg_get_functiondef(${quoteLiteral(driver, `${quoteIdent(driver, schema)}.${name}`)}::regprocedure)`;
    if (kind === 'view' || kind === 'matview')
      return `SELECT 'CREATE ${kind === 'matview' ? 'MATERIALIZED ' : 'OR REPLACE '}VIEW ' || ${quoteLiteral(driver, `${ddlIdent(driver, schema)}.${ddlIdent(driver, name)}`)} || E' AS\n' || pg_get_viewdef(${quoteLiteral(driver, `${quoteIdent(driver, schema)}.${quoteIdent(driver, name)}`)}::regclass, true)`;
    if (kind === 'sequence')
      return `SELECT 'CREATE SEQUENCE ' || ${quoteLiteral(driver, `${ddlIdent(driver, schema)}.${ddlIdent(driver, name)}`)} || ' AS ' || format_type(seqtypid, NULL) || ' START ' || seqstart || ' INCREMENT ' || seqincrement || ' MINVALUE ' || seqmin || ' MAXVALUE ' || seqmax || CASE WHEN seqcycle THEN ' CYCLE' ELSE '' END || ';'
        FROM pg_sequence WHERE seqrelid = ${quoteLiteral(driver, `${quoteIdent(driver, schema)}.${quoteIdent(driver, name)}`)}::regclass`;
  }
  return null;
}

/** The DDL text from storedDdlSql's result (MySQL puts it in the second column). */
export function parseStoredDdl(driver: Driver, r: QueryResult): string {
  if (driver === 'mysql') {
    const i = r.columns.findIndex((c) => /^create /i.test(c));
    return `${r.rows[0]?.[i >= 0 ? i : 1] ?? ''};\n`;
  }
  return r.rows.map((row) => row[0] ?? '').join('\n\n') + '\n';
}

export function renameSql(driver: Driver, schema: string, table: string, to: string, kind: ObjectKind): string {
  if (driver === 'mysql') return `RENAME TABLE ${qualified(driver, schema, table)} TO ${qualified(driver, schema, to)}`;
  const what = kind === 'view' ? 'VIEW' : kind === 'matview' ? 'MATERIALIZED VIEW' : kind === 'sequence' ? 'SEQUENCE' : 'TABLE';
  return `ALTER ${driver === 'sqlite' ? 'TABLE' : what} ${qualified(driver, schema, table)} RENAME TO ${quoteIdent(driver, to)}`;
}

export function dropSql(driver: Driver, schema: string, name: string, kind: ObjectKind): string {
  const what = { table: 'TABLE', foreign: 'FOREIGN TABLE', view: 'VIEW', matview: 'MATERIALIZED VIEW', sequence: 'SEQUENCE', function: 'FUNCTION', procedure: 'PROCEDURE' }[kind];
  // Routines carry their argument list in the name (Postgres): "fn(integer)".
  const target = kind === 'function' || kind === 'procedure' ? (driver === 'postgres' ? `${quoteIdent(driver, schema)}.${name}` : qualified(driver, schema, name)) : qualified(driver, schema, name);
  return `DROP ${what} ${target}`;
}

// Modify Table / New Table: a table as an editable model, and the SQL that turns the original into
// the edited one (CREATE TABLE for a new table, ALTER TABLE… for a changed one), per database.

import { qualified, quoteIdent, quoteLiteral } from './dialect';
import type { Column, Driver, TableDetails } from './types';

export type FkRule = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
export const FK_RULES: FkRule[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

/** Every element keeps `id` (its original name, or a new id) so edits can be matched to the original. */
export interface ColumnModel {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  /** SQL expression, as written: 0, 'text', now(), nextval('…'). Empty: none. */
  default: string;
  comment: string;
}

export interface KeyModel {
  id: string;
  name: string;
  primary: boolean;
  columns: string[];
}

export interface ForeignKeyModel {
  id: string;
  name: string;
  columns: string[];
  /** "schema.table" or "table". */
  refTable: string;
  refColumns: string[];
  onDelete: FkRule;
  onUpdate: FkRule;
}

export interface IndexModel {
  id: string;
  name: string;
  unique: boolean;
  columns: string[];
}

export interface CheckModel {
  id: string;
  name: string;
  expression: string;
}

export interface TableModel {
  name: string;
  comment: string;
  columns: ColumnModel[];
  keys: KeyModel[];
  foreignKeys: ForeignKeyModel[];
  indexes: IndexModel[];
  checks: CheckModel[];
}

const split = (list: string | undefined) => (list ?? '').split(/,\s*/).filter(Boolean);

/** The model of an existing table, from what the Database tool loaded. */
export function modelOf(name: string, comment: string, columns: Column[], details: TableDetails): TableModel {
  const constraintNames = new Set([...details.keys, ...details.foreignKeys].map((k) => k.name));
  return {
    name,
    comment,
    columns: columns.map((c) => ({ id: c.name, name: c.name, type: c.type, nullable: c.nullable, default: c.default ?? '', comment: c.comment ?? '' })),
    keys: details.keys.map((k) => ({ id: k.name, name: k.name, primary: k.kind === 'pk', columns: split(k.columns) })),
    foreignKeys: details.foreignKeys.map((f) => ({
      id: f.name,
      name: f.name,
      columns: split(f.columns),
      refTable: f.refTable ?? '',
      refColumns: split(f.refColumns),
      onDelete: (f.onDelete as FkRule) ?? 'NO ACTION',
      onUpdate: (f.onUpdate as FkRule) ?? 'NO ACTION',
    })),
    // Indexes backing a key are managed through the key.
    indexes: details.indexes.filter((i) => !constraintNames.has(i.name) && !i.primary).map((i) => ({ id: i.name, name: i.name, unique: i.unique, columns: split(i.columns) })),
    checks: details.checks.map((c) => ({ id: c.name, name: c.name, expression: (c.definition ?? '').replace(/^CHECK\s*/i, '') })),
  };
}

export function emptyModel(name = 'new_table'): TableModel {
  return { name, comment: '', columns: [], keys: [], foreignKeys: [], indexes: [], checks: [] };
}

let counter = 0;
/** An id for a new element (never equal to an original name). */
export const newId = () => `\u0000new${++counter}`;

// ── SQL ─────────────────────────────────────────────────────────

const q = (d: Driver, n: string) => quoteIdent(d, n);
const cols = (d: Driver, list: string[]) => list.map((c) => q(d, c)).join(', ');

function refTarget(d: Driver, schema: string, ref: string): string {
  const [s, t] = ref.includes('.') ? [ref.slice(0, ref.indexOf('.')), ref.slice(ref.indexOf('.') + 1)] : [schema, ref];
  return qualified(d, s, t);
}

function columnDefinition(d: Driver, c: ColumnModel): string {
  let sql = `${q(d, c.name)} ${c.type}`;
  if (c.default.trim()) sql += ` DEFAULT ${c.default.trim()}`;
  if (!c.nullable) sql += ' NOT NULL';
  if (d === 'mysql' && c.comment) sql += ` COMMENT ${quoteLiteral(d, c.comment)}`;
  return sql;
}

function keyClause(d: Driver, k: KeyModel): string {
  const kind = k.primary ? 'PRIMARY KEY' : 'UNIQUE';
  return d === 'mysql' && k.primary ? `PRIMARY KEY (${cols(d, k.columns)})` : `CONSTRAINT ${q(d, k.name)} ${kind} (${cols(d, k.columns)})`;
}

function fkClause(d: Driver, schema: string, f: ForeignKeyModel): string {
  let sql = `CONSTRAINT ${q(d, f.name)} FOREIGN KEY (${cols(d, f.columns)}) REFERENCES ${refTarget(d, schema, f.refTable)} (${cols(d, f.refColumns)})`;
  if (f.onDelete !== 'NO ACTION') sql += ` ON DELETE ${f.onDelete}`;
  if (f.onUpdate !== 'NO ACTION') sql += ` ON UPDATE ${f.onUpdate}`;
  return sql;
}

const checkClause = (d: Driver, c: CheckModel) => `CONSTRAINT ${q(d, c.name)} CHECK (${c.expression})`;

function createIndex(d: Driver, schema: string, table: string, i: IndexModel): string {
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(d, i.name)} ON ${qualified(d, schema, table)} (${cols(d, i.columns)})`;
}

function dropIndex(d: Driver, schema: string, table: string, i: IndexModel): string {
  if (d === 'mysql') return `DROP INDEX ${q(d, i.name)} ON ${qualified(d, schema, table)}`;
  return `DROP INDEX ${d === 'postgres' ? `${q(d, schema)}.${q(d, i.name)}` : q(d, i.name)}`;
}

function commentOn(d: Driver, what: 'TABLE' | 'COLUMN', target: string, comment: string): string | null {
  if (d !== 'postgres') return null;
  return `COMMENT ON ${what} ${target} IS ${comment ? quoteLiteral(d, comment) : 'NULL'}`;
}

/** CREATE TABLE (and its indexes and comments) for a new table. */
export function createStatements(d: Driver, schema: string, t: TableModel): string[] {
  const lines = [
    ...t.columns.map((c) => columnDefinition(d, c)),
    ...t.keys.map((k) => keyClause(d, k)),
    ...t.foreignKeys.map((f) => fkClause(d, schema, f)),
    ...(d === 'sqlite' && !t.checks.length ? [] : t.checks.map((c) => checkClause(d, c))),
  ];
  const table = qualified(d, schema, t.name);
  const out = [`CREATE TABLE ${table}\n(\n    ${lines.join(',\n    ')}\n)${d === 'mysql' && t.comment ? ` COMMENT = ${quoteLiteral(d, t.comment)}` : ''}`];
  for (const i of t.indexes) out.push(createIndex(d, schema, t.name, i));
  const tc = t.comment ? commentOn(d, 'TABLE', table, t.comment) : null;
  if (tc) out.push(tc);
  for (const c of t.columns) {
    const cc = c.comment ? commentOn(d, 'COLUMN', `${table}.${q(d, c.name)}`, c.comment) : null;
    if (cc) out.push(cc);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The statements that turn `before` into `after`, in a safe order: drop constraints and indexes
 * that go away or change, change columns, add columns, then add constraints and indexes, then
 * rename the table. SQLite can only rename, add and drop columns: other changes come back as
 * comments saying so.
 */
export function alterStatements(d: Driver, schema: string, before: TableModel, after: TableModel): string[] {
  const out: string[] = [];
  const table = qualified(d, schema, before.name);
  const alter = (clause: string) => `ALTER TABLE ${table} ${clause}`;
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const unsupported = (what: string) => out.push(`-- SQLite cannot ${what}: recreate the table to change it`);

  // 1. Constraints and indexes removed or changed (changed ones are re-added below).
  const aKeys = byId(after.keys);
  const aFks = byId(after.foreignKeys);
  const aIdx = byId(after.indexes);
  const aChecks = byId(after.checks);
  const changed = <T extends { id: string }>(x: T, map: Map<string, T>) => !map.has(x.id) || !same(x, map.get(x.id));
  for (const f of before.foreignKeys.filter((x) => changed(x, aFks))) {
    if (d === 'sqlite') unsupported(`drop the foreign key ${f.name}`);
    else out.push(alter(d === 'mysql' ? `DROP FOREIGN KEY ${q(d, f.name)}` : `DROP CONSTRAINT ${q(d, f.name)}`));
  }
  for (const k of before.keys.filter((x) => changed(x, aKeys))) {
    if (d === 'sqlite') unsupported(`drop the key ${k.name}`);
    else if (d === 'mysql') out.push(alter(k.primary ? 'DROP PRIMARY KEY' : `DROP INDEX ${q(d, k.name)}`));
    else out.push(alter(`DROP CONSTRAINT ${q(d, k.name)}`));
  }
  for (const c of before.checks.filter((x) => changed(x, aChecks))) {
    if (d === 'sqlite') unsupported(`drop the check ${c.name}`);
    else out.push(alter(d === 'mysql' ? `DROP CHECK ${q(d, c.name)}` : `DROP CONSTRAINT ${q(d, c.name)}`));
  }
  for (const i of before.indexes.filter((x) => changed(x, aIdx))) out.push(dropIndex(d, schema, before.name, i));

  // 2. Columns: dropped, changed, added.
  const aCols = byId(after.columns);
  const bCols = byId(before.columns);
  for (const c of before.columns.filter((x) => !aCols.has(x.id))) out.push(alter(`DROP COLUMN ${q(d, c.name)}`));
  for (const c of after.columns) {
    const old = bCols.get(c.id);
    if (!old) continue;
    if (d === 'mysql') {
      if (!same(old, c)) out.push(alter(`CHANGE COLUMN ${q(d, old.name)} ${columnDefinition(d, c)}`));
      continue;
    }
    if (old.name !== c.name) out.push(alter(`RENAME COLUMN ${q(d, old.name)} TO ${q(d, c.name)}`));
    const col = q(d, c.name);
    if (d === 'sqlite') {
      if (old.type !== c.type || old.nullable !== c.nullable || old.default !== c.default) unsupported(`change the column ${c.name}`);
      continue;
    }
    if (old.type !== c.type) out.push(alter(`ALTER COLUMN ${col} TYPE ${c.type}`));
    if (old.default !== c.default) out.push(alter(c.default.trim() ? `ALTER COLUMN ${col} SET DEFAULT ${c.default.trim()}` : `ALTER COLUMN ${col} DROP DEFAULT`));
    if (old.nullable !== c.nullable) out.push(alter(`ALTER COLUMN ${col} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`));
    if (old.comment !== c.comment) out.push(commentOn(d, 'COLUMN', `${table}.${col}`, c.comment)!);
  }
  for (const c of after.columns.filter((x) => !bCols.has(x.id))) {
    out.push(alter(`ADD COLUMN ${columnDefinition(d, c)}`));
    const cc = c.comment ? commentOn(d, 'COLUMN', `${table}.${q(d, c.name)}`, c.comment) : null;
    if (cc) out.push(cc);
  }

  // 3. Constraints and indexes added or changed.
  const bKeys = byId(before.keys);
  const bFks = byId(before.foreignKeys);
  const bIdx = byId(before.indexes);
  const bChecks = byId(before.checks);
  for (const k of after.keys.filter((x) => changed(x, bKeys))) {
    if (d === 'sqlite') unsupported(`add the key ${k.name}`);
    else out.push(alter(`ADD ${keyClause(d, k)}`));
  }
  for (const f of after.foreignKeys.filter((x) => changed(x, bFks))) {
    if (d === 'sqlite') unsupported(`add the foreign key ${f.name}`);
    else out.push(alter(`ADD ${fkClause(d, schema, f)}`));
  }
  for (const c of after.checks.filter((x) => changed(x, bChecks))) {
    if (d === 'sqlite') unsupported(`add the check ${c.name}`);
    else out.push(alter(`ADD ${checkClause(d, c)}`));
  }
  for (const i of after.indexes.filter((x) => changed(x, bIdx))) out.push(createIndex(d, schema, before.name, i));

  // 4. The table itself.
  if (before.comment !== after.comment) {
    if (d === 'mysql') out.push(alter(`COMMENT = ${quoteLiteral(d, after.comment)}`));
    else if (d === 'postgres') out.push(commentOn(d, 'TABLE', table, after.comment)!);
  }
  if (before.name !== after.name) {
    out.push(d === 'mysql' ? `RENAME TABLE ${table} TO ${qualified(d, schema, after.name)}` : alter(`RENAME TO ${q(d, after.name)}`));
  }
  return out;
}

/** The statements as one script, for the preview and the query console. */
export const script = (statements: string[]) => statements.map((s) => (s.startsWith('--') ? s : `${s};`)).join('\n');

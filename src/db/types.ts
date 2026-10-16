// Data sources (Database tool window) and what the drivers return.

export type Driver = 'postgres' | 'mysql' | 'sqlite' | 'sample';

export interface DataSource {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port?: number;
  user: string;
  database: string;
  /** SQLite database file. */
  file: string;
  ssl: boolean;
  /** Password kept in the OS credential store (never in this object). */
  savePassword: boolean;
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  affected: number | null;
  truncated: boolean;
  ms: number;
}

export type KeyKind = 'pk' | 'fk' | 'uq';

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  key?: KeyKind;
  /** Also part of a foreign key (a primary key column can be one too). */
  foreign?: boolean;
  comment?: string;
}

export type ObjectKind = 'table' | 'view' | 'matview' | 'foreign' | 'sequence' | 'function' | 'procedure';

export interface TableInfo {
  name: string;
  kind: ObjectKind;
}

/** Objects you can SELECT from (tables, views…), for completion and the data editor. */
export const isRelation = (kind: ObjectKind) => kind === 'table' || kind === 'view' || kind === 'matview' || kind === 'foreign';

export interface Constraint {
  name: string;
  kind: 'pk' | 'uq' | 'fk' | 'check';
  /** "id" or "user_id, role_id". */
  columns: string;
  /** Foreign keys: "public.users" and its columns. */
  refTable?: string;
  refColumns?: string;
  /** Checks: the expression. */
  definition?: string;
  /** Foreign keys: NO ACTION, CASCADE… */
  onDelete?: string;
  onUpdate?: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string;
  /** CREATE INDEX … (Postgres), for the DDL. */
  definition?: string;
}

export interface TableDetails {
  keys: Constraint[];
  foreignKeys: Constraint[];
  checks: Constraint[];
  indexes: IndexInfo[];
}

export interface RoleInfo {
  name: string;
  superuser: boolean;
  login: boolean;
}

export const DRIVERS: { id: Exclude<Driver, 'sample'>; name: string; port?: number }[] = [
  { id: 'postgres', name: 'PostgreSQL', port: 5432 },
  { id: 'mysql', name: 'MySQL / MariaDB', port: 3306 },
  { id: 'sqlite', name: 'SQLite' },
];

export function driverName(d: Driver): string {
  return d === 'sample' ? 'Sample (MySQL)' : DRIVERS.find((x) => x.id === d)?.name ?? d;
}

/** "app@localhost", "shop.sqlite"… */
export function defaultName(ds: Pick<DataSource, 'driver' | 'host' | 'database' | 'file'>): string {
  if (ds.driver === 'sqlite') return ds.file.split(/[\\/]/).pop() || 'SQLite';
  return `${ds.database || ds.driver}@${ds.host || 'localhost'}`;
}

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
}

export interface TableInfo {
  name: string;
  kind: 'table' | 'view';
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

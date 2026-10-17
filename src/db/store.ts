// Data sources of the open project, their connections and the schema tree cache.
// Lives outside React (like the terminal manager) so tabs and the tool window share it.

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SAMPLE_DB } from '../mock';
import {
  columnsSql,
  constraintsSql,
  countSql,
  databasesSql,
  indexesSql,
  pageSql,
  parseColumns,
  parseConstraints,
  parseIndexes,
  parseRoles,
  parseSqliteColumns,
  parseTables,
  parseStoredDdl,
  rolesSql,
  schemasSql,
  storedDdlSql,
  tableDdl,
  sqliteColumnsSql,
  tablesSql,
  type PageRequest,
} from './dialect';
import type { Column, DataSource, ObjectKind, QueryResult, RoleInfo, TableDetails, TableInfo } from './types';
import { projectStorage } from '../projectStorage';

export interface SourceState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  version?: string;
  error?: string;
  /** The server wants a password we don't have (not saved, or wrong): ask for it. */
  needsPassword?: boolean;
  schemas?: string[];
  /** pg_catalog, information_schema… (shown with "All Namespaces"). */
  systemSchemas?: string[];
  /** Postgres: the databases on the server and the one this connection opened. */
  databases?: { all: string[]; current: string };
  roles?: RoleInfo[];
  tables: Record<string, TableInfo[] | undefined>;
  columns: Record<string, Column[] | undefined>;
  /** Keys, foreign keys, checks and indexes, by "schema.table". */
  details: Record<string, TableDetails | undefined>;
}

const emptyState = (): SourceState => ({ status: 'idle', tables: {}, columns: {}, details: {} });
const colKey = (schema: string, table: string) => `${schema}.${table}`;

const SAMPLE_SOURCE: DataSource = {
  id: 'sample',
  name: SAMPLE_DB.connection,
  driver: 'sample',
  host: 'localhost',
  user: 'root',
  database: SAMPLE_DB.schema,
  file: '',
  ssl: false,
  savePassword: false,
};

class DbStore {
  private root = '';
  private sample = false;
  sources: DataSource[] = [];
  state: Record<string, SourceState> = {};
  /**
   * Passwords typed this session, by data source. Used when connecting, so a password that is not
   * saved in the OS credential store still works until PHPBlitz closes (like PhpStorm).
   */
  private passwords = new Map<string, string>();
  private listeners = new Set<() => void>();
  private snapshot = { sources: this.sources, state: this.state };

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;

  private changed() {
    this.snapshot = { sources: [...this.sources], state: { ...this.state } };
    this.listeners.forEach((l) => l());
  }

  private patch(id: string, p: Partial<SourceState>) {
    this.state[id] = { ...(this.state[id] ?? emptyState()), ...p };
    this.changed();
  }

  private storageKey() {
    return `phpblitz.dataSources:${this.root}`;
  }

  /** Loads the data sources of a project (the sample project gets its sample database). */
  open(root: string, sample: boolean) {
    if (root === this.root && sample === this.sample) return;
    this.closeAll();
    this.root = root;
    this.sample = sample;
    if (sample) {
      this.sources = [SAMPLE_SOURCE];
    } else {
      try {
        this.sources = JSON.parse(projectStorage.getItem(this.storageKey()) ?? '[]');
      } catch {
        this.sources = [];
      }
    }
    this.state = {};
    this.changed();
  }

  private persist() {
    if (this.sample) return;
    try {
      projectStorage.setItem(this.storageKey(), JSON.stringify(this.sources));
    } catch {
      // Not saved; still usable this session.
    }
  }

  get(id: string) {
    return this.sources.find((s) => s.id === id);
  }

  /**
   * Adds or updates a data source; `password` (when given) is saved or forgotten per savePassword.
   * Returns a warning when the OS credential store refused the password (it is still used this session).
   */
  async save(ds: DataSource, password?: string): Promise<string | null> {
    const i = this.sources.findIndex((s) => s.id === ds.id);
    if (i >= 0) this.sources[i] = ds;
    else this.sources.push(ds);
    this.persist();
    let warning: string | null = null;
    if (password !== undefined) this.passwords.set(ds.id, password);
    if (ds.driver !== 'sample' && ds.driver !== 'sqlite') {
      if (!ds.savePassword) await invoke('db_set_password', { id: ds.id, password: null }).catch(() => {});
      else if (password !== undefined)
        await invoke('db_set_password', { id: ds.id, password }).catch((e) => {
          warning = `The password could not be saved in the system's credential store (${e}). It is kept until PHPBlitz closes.`;
        });
    }
    // Settings changed: reconnect on next use.
    if (this.state[ds.id]?.status === 'connected') await this.disconnect(ds.id);
    else this.patch(ds.id, { ...emptyState() });
    this.changed();
    return warning;
  }

  async remove(id: string) {
    await this.disconnect(id);
    this.sources = this.sources.filter((s) => s.id !== id);
    delete this.state[id];
    this.passwords.delete(id);
    this.persist();
    invoke('db_set_password', { id, password: null }).catch(() => {});
    this.changed();
  }

  /** One connection attempt at a time per data source (the panel and a query may ask together). */
  private connecting = new Map<string, Promise<boolean>>();

  /**
   * Connects with `password`, else the one typed this session, else the saved one (Rust reads the
   * credential store). A password given here that works is remembered for the session.
   */
  async connect(id: string, password?: string): Promise<boolean> {
    const ds = this.get(id);
    if (!ds) return false;
    if (this.state[id]?.status === 'connected') return true;
    const pending = this.connecting.get(id);
    if (pending && password === undefined) return pending;
    const attempt = (async () => {
      this.patch(id, { status: 'connecting', error: undefined, needsPassword: false });
      try {
        const pw = password ?? this.passwords.get(id) ?? null;
        const version = ds.driver === 'sample' ? SAMPLE_DB.engine : await invoke<string>('db_connect', { source: ds, password: pw });
        if (password !== undefined) this.passwords.set(id, password);
        this.patch(id, { status: 'connected', version, tables: {}, columns: {}, details: {}, schemas: undefined, systemSchemas: undefined, databases: undefined, roles: undefined });
        return true;
      } catch (e) {
        const error = String(e);
        this.patch(id, { status: 'error', error, needsPassword: ds.driver !== 'sqlite' && isPasswordError(error) });
        return false;
      } finally {
        this.connecting.delete(id);
      }
    })();
    this.connecting.set(id, attempt);
    return attempt;
  }

  async disconnect(id: string) {
    if (this.get(id)?.driver !== 'sample') await invoke('db_disconnect', { id }).catch(() => {});
    this.patch(id, { ...emptyState() });
  }

  closeAll() {
    for (const s of this.sources) if (this.state[s.id]?.status === 'connected' && s.driver !== 'sample') invoke('db_disconnect', { id: s.id }).catch(() => {});
  }

  /** Runs SQL, connecting first when needed. */
  async query(id: string, sql: string, limit = 1000): Promise<QueryResult> {
    const ds = this.get(id);
    if (!ds) throw new Error('Unknown data source');
    if (!(await this.connect(id))) throw new Error(this.state[id]?.error ?? 'Could not connect');
    if (ds.driver === 'sample') return sampleQuery(sql, limit);
    return invoke<QueryResult>('db_query', { id, sql, limit });
  }

  async schemas(id: string, refresh = false): Promise<string[]> {
    const st = this.state[id];
    if (st?.schemas && !refresh) return st.schemas;
    const ds = this.get(id)!;
    if (!(await this.connect(id))) throw new Error(this.state[id]?.error ?? 'Could not connect');
    let schemas = [SAMPLE_DB.schema];
    let systemSchemas: string[] = [];
    if (ds.driver !== 'sample') {
      const rows = (await this.query(id, schemasSql(ds.driver))).rows;
      schemas = rows.filter((r) => r[1] !== '1').map((r) => r[0] ?? '');
      systemSchemas = rows.filter((r) => r[1] === '1').map((r) => r[0] ?? '');
    }
    this.patch(id, { schemas, systemSchemas, ...(refresh ? { tables: {}, columns: {}, details: {}, databases: undefined, roles: undefined } : {}) });
    return schemas;
  }

  /** Postgres: all databases on the server, and the one connected. */
  async databases(id: string): Promise<{ all: string[]; current: string } | null> {
    const ds = this.get(id);
    const sql = ds ? databasesSql(ds.driver) : null;
    if (!sql) return null;
    if (this.state[id]?.databases) return this.state[id]!.databases!;
    const rows = (await this.query(id, sql)).rows;
    const databases = { all: rows.map((r) => r[0] ?? ''), current: rows.find((r) => r[1] === '1')?.[0] ?? ds!.database };
    this.patch(id, { databases });
    return databases;
  }

  async roles(id: string, refresh = false): Promise<RoleInfo[]> {
    const ds = this.get(id);
    const sql = ds ? rolesSql(ds.driver) : null;
    if (!sql) return [];
    if (this.state[id]?.roles && !refresh) return this.state[id]!.roles!;
    const roles = parseRoles(await this.query(id, sql));
    this.patch(id, { roles });
    return roles;
  }

  /** Keys, foreign keys, checks and indexes of a table. */
  async details(id: string, schema: string, table: string, refresh = false): Promise<TableDetails> {
    const key = colKey(schema, table);
    const cached = this.state[id]?.details[key];
    if (cached && !refresh) return cached;
    const ds = this.get(id)!;
    let details: TableDetails = { keys: [], foreignKeys: [], checks: [], indexes: [] };
    if (ds.driver === 'sample') {
      const pk = (SAMPLE_DB.tables[table]?.columns ?? []).filter((c) => c.key === 'pk').map((c) => c.name);
      if (pk.length) details = { ...details, keys: [{ name: `${table}_pkey`, kind: 'pk', columns: pk.join(', ') }], indexes: [{ name: `${table}_pkey`, unique: true, primary: true, columns: pk.join(', ') }] };
    } else {
      const [constraints, indexes] = await Promise.all([this.query(id, constraintsSql(ds.driver, schema, table)), this.query(id, indexesSql(ds.driver, schema, table))]);
      details = { ...parseConstraints(constraints), indexes: parseIndexes(indexes) };
    }
    this.patch(id, { details: { ...(this.state[id]?.details ?? {}), [key]: details } });
    return details;
  }

  /** An object's DDL: from the server where it keeps one, else built from the catalog (Postgres tables). */
  async ddl(id: string, schema: string, name: string, kind: ObjectKind): Promise<string> {
    const ds = this.get(id)!;
    if (ds.driver === 'sample') {
      const cols = await this.columns(id, schema, name);
      return tableDdl('mysql', schema, name, cols, await this.details(id, schema, name));
    }
    if (ds.driver === 'postgres' && (kind === 'table' || kind === 'foreign')) {
      const [cols, details] = await Promise.all([this.columns(id, schema, name), this.details(id, schema, name)]);
      return tableDdl(ds.driver, schema, name, cols, details);
    }
    const sql = storedDdlSql(ds.driver, schema, name, kind);
    if (!sql) throw new Error(`No DDL for ${name}`);
    return parseStoredDdl(ds.driver, await this.query(id, sql));
  }

  cachedDetails(id: string, schema: string, table: string) {
    return this.state[id]?.details[colKey(schema, table)];
  }

  // ── Query consoles (several per data source, like PhpStorm) ──

  private consolesKey(id: string) {
    return `phpblitz.consoles:${this.root}:${id}`;
  }

  /** Console names of a data source; "console" (the default one) always exists. */
  consoles(id: string): string[] {
    try {
      const list = JSON.parse(localStorage.getItem(this.consolesKey(id)) ?? '[]') as string[];
      return list.includes('console') ? list : ['console', ...list];
    } catch {
      return ['console'];
    }
  }

  /** A new console: "console_1", "console_2"… */
  newConsole(id: string): string {
    const list = this.consoles(id);
    let n = 1;
    while (list.includes(`console_${n}`)) n++;
    const name = `console_${n}`;
    try {
      localStorage.setItem(this.consolesKey(id), JSON.stringify([...list, name]));
    } catch {
      // This session only.
    }
    this.changed();
    return name;
  }

  async tables(id: string, schema: string, refresh = false): Promise<TableInfo[]> {
    const cached = this.state[id]?.tables[schema];
    if (cached && !refresh) return cached;
    const ds = this.get(id)!;
    const tables =
      ds.driver === 'sample'
        ? Object.keys(SAMPLE_DB.tables).map((name) => ({ name, kind: 'table' as const }))
        : parseTables(await this.query(id, tablesSql(ds.driver, schema)));
    this.patch(id, { tables: { ...(this.state[id]?.tables ?? {}), [schema]: tables } });
    return tables;
  }

  async columns(id: string, schema: string, table: string, refresh = false): Promise<Column[]> {
    const key = colKey(schema, table);
    const cached = this.state[id]?.columns[key];
    if (cached && !refresh) return cached;
    const ds = this.get(id)!;
    let columns: Column[];
    if (ds.driver === 'sample') {
      columns = (SAMPLE_DB.tables[table]?.columns ?? []).map((c) => ({ name: c.name, type: c.type, nullable: c.key !== 'pk', default: null, key: c.key }));
    } else if (ds.driver === 'sqlite') {
      const [info, fks] = sqliteColumnsSql(table);
      columns = parseSqliteColumns(await this.query(id, info), await this.query(id, fks));
    } else {
      columns = parseColumns(await this.query(id, columnsSql(ds.driver, schema, table)));
    }
    this.patch(id, { columns: { ...(this.state[id]?.columns ?? {}), [key]: columns } });
    return columns;
  }

  cachedColumns(id: string, schema: string, table: string) {
    return this.state[id]?.columns[colKey(schema, table)];
  }

  async page(id: string, p: PageRequest): Promise<{ result: QueryResult; total: number | null }> {
    const ds = this.get(id)!;
    if (ds.driver === 'sample') return samplePage(p);
    const [result, count] = await Promise.all([this.query(id, pageSql(ds.driver, p), p.limit), this.query(id, countSql(ds.driver, p.schema, p.table, p.where)).catch(() => null)]);
    return { result, total: count ? Number(count.rows[0]?.[0] ?? 0) : null };
  }
}

/** Errors that mean "give me (another) password": Postgres, MySQL / MariaDB. */
export function isPasswordError(error: string): boolean {
  return /password authentication failed|no password (was )?supplied|password is required|Access denied for user|authentication failed/i.test(error);
}

export const db = new DbStore();

export function useDb() {
  return useSyncExternalStore(db.subscribe, db.getSnapshot);
}

// ── The sample project's database (browser preview) ─────────────

function samplePage(p: PageRequest): { result: QueryResult; total: number } {
  const t = SAMPLE_DB.tables[p.table];
  if (!t) throw new Error(`Table ${p.table} doesn't exist`);
  let rows = [...t.rows];
  // Only `column = 'value'` filters, enough to try the WHERE box.
  const m = p.where.trim().match(/^`?(\w+)`?\s*=\s*'?([^']*)'?$/);
  if (p.where.trim() && m) rows = rows.filter((r) => r[t.columns.findIndex((c) => c.name === m[1])] === m[2]);
  if (p.orderBy) {
    const i = t.columns.findIndex((c) => c.name === p.orderBy!.column);
    rows.sort((a, b) => String(a[i] ?? '').localeCompare(String(b[i] ?? ''), undefined, { numeric: true }) * (p.orderBy!.desc ? -1 : 1));
  }
  const total = rows.length;
  return { result: { columns: t.columns.map((c) => c.name), rows: rows.slice(p.offset, p.offset + p.limit), affected: null, truncated: false, ms: 0 }, total };
}

function sampleQuery(sql: string, limit: number): QueryResult {
  const m = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/;$/, '').match(/^select\s+\*\s+from\s+`?(\w+)`?(?:\s+limit\s+(\d+))?$/i);
  if (!m || !SAMPLE_DB.tables[m[1]]) throw new Error('The sample database only understands SELECT * FROM <table>. Open a real project and add a data source to run any SQL.');
  const t = SAMPLE_DB.tables[m[1]];
  const n = Math.min(limit, m[2] ? Number(m[2]) : limit);
  return { columns: t.columns.map((c) => c.name), rows: t.rows.slice(0, n), affected: null, truncated: !m[2] && t.rows.length > limit, ms: 1 };
}

// ── .env import (Laravel DB_*, Symfony DATABASE_URL) ────────────

export function dataSourceFromEnv(text: string): Partial<DataSource> | null {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const url = env.DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url.replace(/^(\w+):/, (_, s: string) => `${s.toLowerCase()}:`));
      const scheme = u.protocol.replace(':', '');
      if (scheme === 'sqlite') return { driver: 'sqlite', file: decodeURIComponent(u.pathname.replace(/^\/+/, '')) };
      return {
        driver: /^postgres/.test(scheme) ? 'postgres' : 'mysql',
        host: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        user: decodeURIComponent(u.username),
        database: decodeURIComponent(u.pathname.replace(/^\//, '')),
        password: decodeURIComponent(u.password),
      } as Partial<DataSource> & { password: string };
    } catch {
      // Not a URL; try the Laravel variables.
    }
  }
  const conn = env.DB_CONNECTION;
  if (!conn) return null;
  if (conn === 'sqlite') return { driver: 'sqlite', file: env.DB_DATABASE ?? 'database/database.sqlite' };
  return {
    driver: conn === 'pgsql' ? 'postgres' : 'mysql',
    host: env.DB_HOST ?? '127.0.0.1',
    port: env.DB_PORT ? Number(env.DB_PORT) : undefined,
    user: env.DB_USERNAME ?? '',
    database: env.DB_DATABASE ?? '',
    password: env.DB_PASSWORD ?? '',
  } as Partial<DataSource> & { password: string };
}

// One store per page: reload fully on hot update instead of starting a second, empty one.
import.meta.hot?.dispose(() => location.reload());

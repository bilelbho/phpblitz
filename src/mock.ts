// SAMPLE_DB is the sample project's database, served by db/store.ts's sample driver.

export type ColumnKey = 'pk' | 'fk' | 'uq' | undefined;

export interface Table {
  columns: { name: string; type: string; key?: ColumnKey }[];
  rows: (string | null)[][];
}

export const SAMPLE_DB: { connection: string; engine: string; schema: string; tables: Record<string, Table> } = {
  connection: 'acme_shop@localhost',
  engine: 'MySQL 8.0',
  schema: 'acme_shop',
  tables: {
    users: {
      columns: [
        { name: 'id', type: 'bigint', key: 'pk' },
        { name: 'name', type: 'varchar(255)' },
        { name: 'email', type: 'varchar(255)', key: 'uq' },
        { name: 'company', type: 'varchar(255)' },
        { name: 'is_admin', type: 'tinyint(1)' },
        { name: 'created_at', type: 'timestamp' },
      ],
      rows: [
        ['1', 'Jane Cooper', 'jane@example.com', 'Northwind', '1', '2026-09-02 10:14:00'],
        ['2', 'Omar Haddad', 'omar@example.com', 'Bluefin Labs', '0', '2026-09-05 16:41:12'],
        ['3', 'Lina Moreau', 'lina@example.com', null, '0', '2026-09-11 08:03:55'],
        ['4', 'Kenji Sato', 'kenji@example.com', 'Northwind', '0', '2026-10-01 12:30:09'],
      ],
    },
    orders: {
      columns: [
        { name: 'id', type: 'bigint', key: 'pk' },
        { name: 'user_id', type: 'bigint', key: 'fk' },
        { name: 'total', type: 'decimal(10,2)' },
        { name: 'status', type: 'varchar(32)' },
        { name: 'created_at', type: 'timestamp' },
      ],
      rows: [
        ['101', '1', '249.00', 'paid', '2026-09-03 09:12:44'],
        ['102', '2', '89.50', 'pending', '2026-09-06 11:20:01'],
        ['103', '1', '1200.00', 'paid', '2026-09-20 15:45:30'],
      ],
    },
    invoices: {
      columns: [
        { name: 'id', type: 'bigint', key: 'pk' },
        { name: 'user_id', type: 'bigint', key: 'fk' },
        { name: 'amount', type: 'decimal(10,2)' },
        { name: 'total', type: 'decimal(10,2)' },
        { name: 'status', type: 'varchar(32)' },
      ],
      rows: [
        ['9001', '1', '249.00', '298.80', 'paid'],
        ['9002', '2', '89.50', '107.40', 'pending'],
      ],
    },
    migrations: {
      columns: [
        { name: 'id', type: 'int', key: 'pk' },
        { name: 'migration', type: 'varchar(255)' },
        { name: 'batch', type: 'int' },
      ],
      rows: [
        ['1', '0001_01_01_000000_create_users_table', '1'],
        ['2', '2026_09_01_120000_create_orders_table', '1'],
        ['3', '2026_09_14_093000_create_invoices_table', '2'],
      ],
    },
  },
};

# Databases

PostgreSQL, MySQL / MariaDB and SQLite, in the **Database** tool window.

- **Add from .env** fills in the connection from Laravel's `DB_*` variables or Symfony's
  `DATABASE_URL`. Or add a data source by hand.
- **Schema tree**: schemas, tables, views, columns, keys, indexes and routines.
- **Query consoles**: write SQL with completion, run it, and see the results in a grid.
- **Table data**: open a table to browse, filter and sort its rows, and edit them: changes are
  shown as SQL before they're applied.

Passwords stay in your system's credential store (Windows Credential Manager, macOS Keychain, the
Secret Service on Linux), never in files. Data sources are saved in `.blitz/workspace.json`, on this
machine only.

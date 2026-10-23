//! Database connections for the Database tool window: PostgreSQL, MySQL/MariaDB and SQLite.
//!
//! The UI builds its SQL (including the schema tree, from information_schema or SQLite's
//! pragmas) and sends it here; results come back as text cells, like a database console.
//! Passwords live in the OS credential store (Windows Credential Manager, macOS Keychain).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSource {
    id: String,
    /// "postgres", "mysql" (also MariaDB) or "sqlite".
    driver: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    database: String,
    /// SQLite database file.
    #[serde(default)]
    file: String,
    #[serde(default)]
    ssl: bool,
}

enum Conn {
    Postgres(postgres::Client),
    Mysql(mysql::Conn),
    Sqlite(rusqlite::Connection),
}

/// Stops a running query from outside its connection (whose lock the query holds): a second
/// connection asks the server (Postgres cancel request, MySQL KILL QUERY); SQLite is interrupted.
enum Canceller {
    Postgres { token: postgres::CancelToken, ssl: bool },
    Mysql { opts: mysql::Opts, id: u32 },
    Sqlite(rusqlite::InterruptHandle),
}

impl Canceller {
    fn cancel(&self) -> Result<(), String> {
        match self {
            Canceller::Postgres { token, ssl } => {
                if *ssl {
                    token.cancel_query(postgres_native_tls::MakeTlsConnector::new(tls_connector()?))
                } else {
                    token.cancel_query(postgres::NoTls)
                }
                .map_err(|e| pg_error(&e))
            }
            Canceller::Mysql { opts, id } => {
                use mysql::prelude::Queryable;
                let mut conn = mysql::Conn::new(opts.clone()).map_err(|e| e.to_string())?;
                conn.query_drop(format!("KILL QUERY {id}")).map_err(|e| e.to_string())
            }
            Canceller::Sqlite(handle) => {
                handle.interrupt();
                Ok(())
            }
        }
    }
}

struct Connection {
    conn: Arc<Mutex<Conn>>,
    cancel: Arc<Canceller>,
}

#[derive(Default)]
pub struct DbState {
    conns: Mutex<HashMap<String, Connection>>,
}

#[derive(Serialize, Default, Debug)]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    /// Rows changed by the last statement when it returned no rows.
    affected: Option<u64>,
    /// More rows existed than `limit`.
    truncated: bool,
    ms: u64,
}

const KEYRING_SERVICE: &str = "PHPBlitz";

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("datasource:{id}")).map_err(|e| e.to_string())
}

fn stored_password(id: &str) -> Option<String> {
    keyring_entry(id).ok()?.get_password().ok()
}

/// Like libpq's sslmode=require: encrypted, certificate not verified.
fn tls_connector() -> Result<native_tls::TlsConnector, String> {
    native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).build().map_err(|e| e.to_string())
}

fn open(ds: &DataSource, password: Option<String>) -> Result<Conn, String> {
    open_with_cancel(ds, password).map(|(conn, _)| conn)
}

/// Connects, and makes what can stop this connection's queries.
fn open_with_cancel(ds: &DataSource, password: Option<String>) -> Result<(Conn, Canceller), String> {
    let password = password.or_else(|| stored_password(&ds.id)).unwrap_or_default();
    let host = if ds.host.trim().is_empty() { "localhost" } else { ds.host.trim() };
    match ds.driver.as_str() {
        "postgres" => {
            let mut cfg = postgres::Config::new();
            cfg.host(host)
                .port(ds.port.unwrap_or(5432))
                .user(&ds.user)
                .password(&password)
                .connect_timeout(Duration::from_secs(10))
                .application_name("PHPBlitz");
            if !ds.database.is_empty() {
                cfg.dbname(&ds.database);
            }
            let client = if ds.ssl {
                cfg.ssl_mode(postgres::config::SslMode::Require);
                cfg.connect(postgres_native_tls::MakeTlsConnector::new(tls_connector()?))
            } else {
                cfg.connect(postgres::NoTls)
            };
            let client = client.map_err(|e| pg_error(&e))?;
            let cancel = Canceller::Postgres { token: client.cancel_token(), ssl: ds.ssl };
            Ok((Conn::Postgres(client), cancel))
        }
        "mysql" => {
            let mut opts = mysql::OptsBuilder::new()
                .ip_or_hostname(Some(host))
                .tcp_port(ds.port.unwrap_or(3306))
                .user(Some(&ds.user))
                .pass(Some(password))
                .tcp_connect_timeout(Some(Duration::from_secs(10)));
            if !ds.database.is_empty() {
                opts = opts.db_name(Some(&ds.database));
            }
            if ds.ssl {
                opts = opts.ssl_opts(Some(mysql::SslOpts::default().with_danger_accept_invalid_certs(true)));
            }
            let opts = mysql::Opts::from(opts);
            let conn = mysql::Conn::new(opts.clone()).map_err(|e| e.to_string())?;
            let cancel = Canceller::Mysql { opts, id: conn.connection_id() };
            Ok((Conn::Mysql(conn), cancel))
        }
        "sqlite" => {
            if !std::path::Path::new(&ds.file).is_file() {
                return Err(format!("{} does not exist", ds.file));
            }
            let db = rusqlite::Connection::open_with_flags(&ds.file, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| e.to_string())?;
            let cancel = Canceller::Sqlite(db.get_interrupt_handle());
            Ok((Conn::Sqlite(db), cancel))
        }
        other => Err(format!("Unknown driver {other}")),
    }
}

/// Postgres errors print as "db error"; show the server's message and detail instead.
fn pg_error(e: &postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => {
            let mut msg = format!("{}: {}", db.severity(), db.message());
            if let Some(detail) = db.detail() {
                msg.push_str(&format!("\n{detail}"));
            }
            if let Some(hint) = db.hint() {
                msg.push_str(&format!("\nHint: {hint}"));
            }
            msg
        }
        None => {
            // Connection errors keep their cause (refused, timed out, bad password…).
            let mut msg = e.to_string();
            let mut source = std::error::Error::source(e);
            while let Some(s) = source {
                msg = format!("{msg}: {s}");
                source = s.source();
            }
            msg
        }
    }
}

fn version(conn: &mut Conn) -> String {
    let sql = match conn {
        Conn::Postgres(_) => "SELECT version()",
        Conn::Mysql(_) => "SELECT CONCAT(@@version_comment, ' ', VERSION())",
        Conn::Sqlite(_) => "SELECT 'SQLite ' || sqlite_version()",
    };
    run(conn, sql, 1)
        .ok()
        .and_then(|r| r.rows.into_iter().next())
        .and_then(|row| row.into_iter().next().flatten())
        .unwrap_or_default()
}

/// Runs one or more statements; returns the last result set (or the last statement's row count).
/// At most `limit` rows are kept, and a query with more is stopped (`cancel`) rather than read to
/// its end: `SELECT * FROM events` on millions of rows costs neither memory nor minutes.
fn run(conn: &mut Conn, sql: &str, limit: usize) -> Result<QueryResult, String> {
    run_with(conn, sql, limit, None)
}

fn run_with(conn: &mut Conn, sql: &str, limit: usize, cancel: Option<&Canceller>) -> Result<QueryResult, String> {
    let started = Instant::now();
    // Postgres, one query that returns rows: streamed with COPY (the simple query protocol collects
    // every row first). Anything else, or a query COPY doesn't take, the usual way below.
    if let (Conn::Postgres(client), Some(query)) = (&mut *conn, single_read(sql)) {
        match pg_copy(client, query, limit, cancel) {
            Ok(mut out) => {
                out.ms = started.elapsed().as_millis() as u64;
                return Ok(out);
            }
            // The query ran and failed (cancelled, an error in it): running it again won't help.
            Err(CopyError::Query(message)) => return Err(message),
            Err(CopyError::NotForCopy) => {}
        }
    }
    let mut out = QueryResult::default();
    match conn {
        Conn::Postgres(client) => {
            // The simple query protocol returns every value as text, whatever its type.
            let messages = client.simple_query(sql).map_err(|e| pg_error(&e))?;
            let mut current: Option<QueryResult> = None;
            for m in messages {
                match m {
                    postgres::SimpleQueryMessage::RowDescription(cols) => {
                        current = Some(QueryResult { columns: cols.iter().map(|c| c.name().to_string()).collect(), ..Default::default() });
                    }
                    postgres::SimpleQueryMessage::Row(row) => {
                        let set = current.get_or_insert_with(|| QueryResult {
                            columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                            ..Default::default()
                        });
                        if set.rows.len() >= limit {
                            set.truncated = true;
                            continue;
                        }
                        set.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                    }
                    postgres::SimpleQueryMessage::CommandComplete(n) => match current.take() {
                        Some(set) => out = set,
                        None => out = QueryResult { affected: Some(n), ..Default::default() },
                    },
                    _ => {}
                }
            }
            if let Some(set) = current {
                out = set;
            }
        }
        Conn::Mysql(c) => {
            use mysql::prelude::Queryable;
            let mut result = c.query_iter(sql).map_err(|e| e.to_string())?;
            while let Some(set) = result.iter() {
                let columns: Vec<String> = set.columns().as_ref().iter().map(|c| c.name_str().into_owned()).collect();
                let affected = set.affected_rows();
                let mut current = QueryResult { columns, ..Default::default() };
                for row in set {
                    let row = row.map_err(|e| e.to_string())?;
                    if current.rows.len() >= limit {
                        current.truncated = true;
                        break;
                    }
                    current.rows.push(row.unwrap().into_iter().map(mysql_text).collect());
                }
                if current.columns.is_empty() {
                    current.affected = Some(affected);
                }
                out = current;
                if out.truncated {
                    // The rest isn't wanted: the server stops (else dropping the result reads it all).
                    if let Some(cancel) = cancel {
                        let _ = cancel.cancel();
                    }
                    break;
                }
            }
            // After a stopped query the driver reports the interruption: not an error here.
            drop(result);
        }
        Conn::Sqlite(db) => {
            let mut batch = rusqlite::Batch::new(db, sql);
            while let Some(mut stmt) = batch.next().map_err(|e| e.to_string())? {
                let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
                if columns.is_empty() {
                    let n = stmt.execute([]).map_err(|e| e.to_string())?;
                    out = QueryResult { affected: Some(n as u64), ..Default::default() };
                    continue;
                }
                let mut current = QueryResult { columns, ..Default::default() };
                let count = current.columns.len();
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    if current.rows.len() >= limit {
                        current.truncated = true;
                        break;
                    }
                    current.rows.push((0..count).map(|i| sqlite_text(row.get_ref(i).ok())).collect());
                }
                out = current;
            }
        }
    }
    out.ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

/// The query, when `sql` is a single statement that returns rows (SELECT, WITH, VALUES, TABLE). A
/// semicolon anywhere but at the end means several statements, or one in a string: not streamed.
fn single_read(sql: &str) -> Option<&str> {
    let query = sql.trim().trim_end_matches(';').trim_end();
    if query.contains(';') {
        return None;
    }
    let first = query.split(|c: char| !c.is_ascii_alphabetic()).next()?.to_ascii_lowercase();
    ["select", "with", "values", "table"].contains(&first.as_str()).then_some(query)
}

/// A Postgres query streamed as CSV (`COPY (query) TO STDOUT`): values as text like the simple
/// protocol's, NULL as an unquoted empty field. Stops after `limit` rows.
fn pg_copy(client: &mut postgres::Client, query: &str, limit: usize, cancel: Option<&Canceller>) -> Result<QueryResult, CopyError> {
    use std::io::Read;
    let reader = client.copy_out(&format!("COPY ({query}) TO STDOUT WITH (FORMAT csv, HEADER true)")).map_err(|e| {
        // COPY refusing the statement (its syntax, a kind it doesn't take): the usual way runs it.
        let refused = e.code().is_some_and(|c| *c == postgres::error::SqlState::SYNTAX_ERROR || *c == postgres::error::SqlState::FEATURE_NOT_SUPPORTED);
        if refused {
            CopyError::NotForCopy
        } else {
            CopyError::Query(pg_error(&e))
        }
    })?;
    let mut bytes = std::io::BufReader::new(reader).bytes().peekable();
    // An error while reading is the query's own (cancelled, division by zero…).
    let mut next = || csv_record(&mut bytes).map_err(|e| CopyError::Query(copy_read_error(&e)));
    let columns = next()?.unwrap_or_default().into_iter().map(Option::unwrap_or_default).collect();
    let mut out = QueryResult { columns, ..Default::default() };
    while let Some(row) = next()? {
        if out.rows.len() >= limit {
            out.truncated = true;
            if let Some(cancel) = cancel {
                let _ = cancel.cancel();
            }
            break;
        }
        out.rows.push(row);
    }
    Ok(out)
}

enum CopyError {
    /// COPY doesn't take this statement: run it the usual way.
    NotForCopy,
    /// The query itself failed.
    Query(String),
}

/// A read error of a COPY stream: the server's message when there is one.
fn copy_read_error(e: &std::io::Error) -> String {
    match e.get_ref().and_then(|inner| inner.downcast_ref::<postgres::Error>()) {
        Some(pg) => pg_error(pg),
        None => e.to_string(),
    }
}

/// One CSV record (Postgres' CSV: `,` between fields, `"` quotes with `""` inside, NULL as an
/// unquoted empty field); `None` at the end.
fn csv_record(bytes: &mut std::iter::Peekable<impl Iterator<Item = std::io::Result<u8>>>) -> std::io::Result<Option<Vec<Option<String>>>> {
    if bytes.peek().is_none() {
        return Ok(None);
    }
    let (mut fields, mut field, mut quoted, mut in_quotes) = (Vec::new(), Vec::new(), false, false);
    let end = |field: &mut Vec<u8>, quoted: &mut bool| {
        let value = if field.is_empty() && !*quoted { None } else { Some(String::from_utf8_lossy(field).into_owned()) };
        field.clear();
        *quoted = false;
        value
    };
    while let Some(b) = bytes.next() {
        let b = b?;
        if in_quotes {
            if b == b'"' {
                if bytes.peek().is_some_and(|n| n.as_ref().is_ok_and(|n| *n == b'"')) {
                    bytes.next();
                    field.push(b'"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(b);
            }
            continue;
        }
        match b {
            b',' => fields.push(end(&mut field, &mut quoted)),
            b'\n' => {
                fields.push(end(&mut field, &mut quoted));
                return Ok(Some(fields));
            }
            b'\r' => {}
            b'"' if field.is_empty() && !quoted => {
                quoted = true;
                in_quotes = true;
            }
            _ => field.push(b),
        }
    }
    fields.push(end(&mut field, &mut quoted));
    Ok(Some(fields))
}

fn mysql_text(v: mysql::Value) -> Option<String> {
    use mysql::Value::*;
    match v {
        NULL => None,
        Bytes(b) => Some(String::from_utf8_lossy(&b).into_owned()),
        Int(i) => Some(i.to_string()),
        UInt(u) => Some(u.to_string()),
        Float(f) => Some(f.to_string()),
        Double(d) => Some(d.to_string()),
        Date(y, mo, d, h, mi, s, us) => Some(if us > 0 {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
        } else {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
        }),
        Time(neg, days, h, mi, s, _) => Some(format!("{}{:02}:{mi:02}:{s:02}", if neg { "-" } else { "" }, days * 24 + h as u32)),
    }
}

fn sqlite_text(v: Option<rusqlite::types::ValueRef>) -> Option<String> {
    use rusqlite::types::ValueRef::*;
    match v? {
        Null => None,
        Integer(i) => Some(i.to_string()),
        Real(f) => Some(f.to_string()),
        Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        Blob(b) => Some(format!("<blob {} bytes>", b.len())),
    }
}

fn conn_of(state: &DbState, id: &str) -> Result<Arc<Mutex<Conn>>, String> {
    Ok(connection_of(state, id)?.0)
}

/// A connection and what stops its queries.
fn connection_of(state: &DbState, id: &str) -> Result<(Arc<Mutex<Conn>>, Arc<Canceller>), String> {
    let conns = state.conns.lock().map_err(|e| e.to_string())?;
    let c = conns.get(id).ok_or_else(|| "Not connected".to_string())?;
    Ok((Arc::clone(&c.conn), Arc::clone(&c.cancel)))
}

/// Connects (or reconnects) a data source and returns the server version.
/// `password`: use this one (e.g. just typed in the dialog) instead of the saved one.
#[tauri::command]
pub async fn db_connect(state: State<'_, DbState>, source: DataSource, password: Option<String>) -> Result<String, String> {
    connect(&state, source, password).await
}

/// The blocking drivers (postgres, mysql) run their own small runtime: everything that talks to
/// the server, dropping a connection included (it says goodbye), must happen on a blocking thread,
/// never on the async runtime that runs commands ("Cannot start a runtime from within a runtime").
async fn connect(state: &DbState, source: DataSource, password: Option<String>) -> Result<String, String> {
    let id = source.id.clone();
    let (conn, cancel, version) = tauri::async_runtime::spawn_blocking(move || {
        let (mut conn, cancel) = open_with_cancel(&source, password)?;
        let version = version(&mut conn);
        Ok::<_, String>((conn, cancel, version))
    })
    .await
    .map_err(|e| e.to_string())??;
    let connection = Connection { conn: Arc::new(Mutex::new(conn)), cancel: Arc::new(cancel) };
    let previous = state.conns.lock().map_err(|e| e.to_string())?.insert(id, connection);
    if let Some(previous) = previous {
        tauri::async_runtime::spawn_blocking(move || drop(previous));
    }
    Ok(version)
}

/// Test Connection: connects, reads the version and disconnects.
#[tauri::command]
pub async fn db_test(source: DataSource, password: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open(&source, password)?;
        Ok(version(&mut conn))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, id: String) -> Result<(), String> {
    // Closing a connection can wait on the network.
    let conn = state.conns.lock().map_err(|e| e.to_string())?.remove(&id);
    tauri::async_runtime::spawn_blocking(move || drop(conn)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_query(state: State<'_, DbState>, id: String, sql: String, limit: Option<usize>) -> Result<QueryResult, String> {
    let (conn, cancel) = connection_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = conn.lock().map_err(|e| e.to_string())?;
        run_with(&mut conn, &sql, limit.unwrap_or(1000), Some(&cancel))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops the query running on a connection (the console's Cancel). It ends with an error.
#[tauri::command]
pub async fn db_cancel(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let (_, cancel) = connection_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || cancel.cancel()).await.map_err(|e| e.to_string())?
}

/// One statement of a batch; `expect_row`: an UPDATE or DELETE of one row seen in the table editor,
/// which must change a row (none changed: someone else changed or deleted it meanwhile).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    sql: String,
    #[serde(default)]
    expect_row: bool,
}

/// Runs statements in one transaction: all of them, or none if one fails. Returns the rows each
/// one changed; an error says which statement failed.
fn execute_all(conn: &mut Conn, statements: &[Statement]) -> Result<Vec<u64>, String> {
    let begin = if matches!(conn, Conn::Mysql(_)) { "START TRANSACTION" } else { "BEGIN" };
    run(conn, begin, 1)?;
    let mut changed = Vec::with_capacity(statements.len());
    for (i, st) in statements.iter().enumerate() {
        let failure = match run(conn, &st.sql, 1) {
            Ok(r) if st.expect_row && r.affected == Some(0) => Some("no row matched: it was changed or deleted since the page was loaded".to_string()),
            Ok(r) => {
                changed.push(r.affected.unwrap_or(0));
                None
            }
            Err(e) => Some(e),
        };
        if let Some(e) = failure {
            let _ = run(conn, "ROLLBACK", 1);
            return Err(format!("Statement {} of {} failed, nothing was saved: {e}\n\n{}", i + 1, statements.len(), st.sql));
        }
    }
    if let Err(e) = run(conn, "COMMIT", 1) {
        let _ = run(conn, "ROLLBACK", 1);
        return Err(format!("Commit failed, nothing was saved: {e}"));
    }
    Ok(changed)
}

/// The table editor's Submit: its pending changes as one transaction.
#[tauri::command]
pub async fn db_execute(state: State<'_, DbState>, id: String, statements: Vec<Statement>) -> Result<Vec<u64>, String> {
    let conn = conn_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = conn.lock().map_err(|e| e.to_string())?;
        execute_all(&mut conn, &statements)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves (or with `None`, forgets) a data source's password in the OS credential store.
#[tauri::command]
pub async fn db_set_password(id: String, password: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring_entry(&id)?;
        match password {
            Some(p) => entry.set_password(&p).map_err(|e| e.to_string()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether a password is saved, so the dialog can show "saved" without reading it back.
#[tauri::command]
pub async fn db_has_password(id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || stored_password(&id).is_some()).await.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_postgres_csv() {
        let csv = b"id,name,note\n1,\"a, \"\"b\"\"\",\n2,\"\",\"two\nlines\"\n3,plain,x";
        let mut bytes = csv.iter().map(|b| Ok(*b)).peekable();
        let mut records = Vec::new();
        while let Some(r) = csv_record(&mut bytes).unwrap() {
            records.push(r);
        }
        let s = |v: &str| Some(v.to_string());
        assert_eq!(records[0], vec![s("id"), s("name"), s("note")]);
        assert_eq!(records[1], vec![s("1"), s("a, \"b\""), None], "quotes and commas inside; NULL is an unquoted empty field");
        assert_eq!(records[2], vec![s("2"), s(""), s("two\nlines")], "an empty string is quoted; newlines inside quotes");
        assert_eq!(records[3], vec![s("3"), s("plain"), s("x")], "the last record without a newline");
        assert_eq!(records.len(), 4);
    }

    #[test]
    fn streams_only_single_queries_that_return_rows() {
        assert_eq!(single_read("  SELECT * FROM users;  "), Some("SELECT * FROM users"));
        assert!(single_read("with x as (select 1) select * from x").is_some());
        assert!(single_read("VALUES (1), (2)").is_some());
        assert!(single_read("select 1; select 2").is_none(), "two statements");
        assert!(single_read("UPDATE users SET name = 'x'").is_none());
        assert!(single_read("SELECT ';' AS semicolon").is_none(), "a semicolon in a string: the usual way, to be safe");
        assert!(single_read("selection_view").is_none());
    }

    /// Postgres (PHPBLITZ_TEST_PG, the CI's service): a big result is cut at the limit without
    /// reading it all, values keep NULL vs empty, the connection works on, and Cancel stops a query.
    #[test]
    fn postgres_streams_cuts_and_cancels() {
        let Ok(spec) = std::env::var("PHPBLITZ_TEST_PG") else { return };
        let p: Vec<&str> = spec.split_whitespace().collect();
        let source = DataSource { id: "pg-stream".into(), driver: "postgres".into(), host: p[0].into(), port: p[1].parse().ok(), user: p[2].into(), database: p[4].into(), file: String::new(), ssl: false };
        let (mut conn, cancel) = open_with_cancel(&source, Some(p[3].into())).unwrap();
        let big = run_with(&mut conn, "SELECT g AS n, CASE WHEN g % 2 = 0 THEN NULL ELSE '' END AS v, 'a,\"b\"' AS q FROM generate_series(1, 200000) g", 1000, Some(&cancel)).unwrap();
        assert!(big.truncated);
        assert_eq!(big.rows.len(), 1000);
        assert_eq!(big.columns, vec!["n", "v", "q"]);
        assert_eq!(big.rows[0], vec![Some("1".to_string()), Some(String::new()), Some("a,\"b\"".to_string())]);
        assert_eq!(big.rows[1][1], None, "NULL stays NULL");
        // The same connection answers the next query.
        assert_eq!(run(&mut conn, "SELECT 40 + 2", 10).unwrap().rows, vec![vec![Some("42".to_string())]]);
        // Statements that aren't one query still work (simple protocol).
        assert_eq!(run(&mut conn, "SELECT 1; SELECT 2", 10).unwrap().rows, vec![vec![Some("2".to_string())]]);
        // A syntax error is reported as usual; an error in the query comes back as it is.
        assert!(run(&mut conn, "SELECT FROM WHERE", 10).unwrap_err().contains("syntax"));
        assert!(run(&mut conn, "SELECT 1 / 0", 10).unwrap_err().contains("division by zero"));
        assert!(run(&mut conn, "SELECT * FROM no_such_table", 10).unwrap_err().contains("no_such_table"));
        // Cancel from another thread stops a long query.
        let cancel = std::sync::Arc::new(cancel);
        let stopper = std::sync::Arc::clone(&cancel);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            stopper.cancel().unwrap();
        });
        let started = Instant::now();
        let err = run_with(&mut conn, "SELECT pg_sleep(30)", 10, Some(&cancel)).unwrap_err();
        t.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(10), "{err}");
        assert!(err.to_lowercase().contains("cancel"), "{err}");
        assert_eq!(run(&mut conn, "SELECT 'still here'", 10).unwrap().rows[0][0].as_deref(), Some("still here"));
    }

    /// MySQL (PHPBLITZ_TEST_MYSQL="host port user password database"): cut at the limit with the
    /// rest stopped, and Cancel stops a query.
    #[test]
    fn mysql_cuts_and_cancels() {
        let Ok(spec) = std::env::var("PHPBLITZ_TEST_MYSQL") else { return };
        let p: Vec<&str> = spec.split_whitespace().collect();
        let source = DataSource { id: "my-stream".into(), driver: "mysql".into(), host: p[0].into(), port: p[1].parse().ok(), user: p[2].into(), database: p[4].into(), file: String::new(), ssl: false };
        let (mut conn, cancel) = open_with_cancel(&source, Some(p[3].into())).unwrap();
        let sql = "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 100000) SELECT n FROM g";
        let started = Instant::now();
        let big = run_with(&mut conn, &format!("SET SESSION cte_max_recursion_depth = 1000000; {sql}"), 1000, Some(&cancel)).unwrap();
        assert!(big.truncated && big.rows.len() == 1000, "{} rows", big.rows.len());
        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(run(&mut conn, "SELECT 40 + 2", 10).unwrap().rows, vec![vec![Some("42".to_string())]]);
        let cancel = std::sync::Arc::new(cancel);
        let stopper = std::sync::Arc::clone(&cancel);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            stopper.cancel().unwrap();
        });
        let started = Instant::now();
        let r = run_with(&mut conn, "SELECT SLEEP(30)", 10, Some(&cancel));
        t.join().unwrap();
        // KILL QUERY makes SLEEP return 1 early (or the query fail): either way, not 30 seconds.
        assert!(started.elapsed() < Duration::from_secs(10), "{r:?}");
        assert_eq!(run(&mut conn, "SELECT 'still here'", 10).unwrap().rows[0][0].as_deref(), Some("still here"));
    }

    /// Submit: everything in one transaction; a failing statement or a row that is gone undoes all.
    #[test]
    fn executes_a_batch_as_one_transaction() {
        let mut conn = Conn::Sqlite(rusqlite::Connection::open_in_memory().unwrap());
        run(&mut conn, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO t VALUES (1, 'a'), (2, 'b')", 10).unwrap();
        let st = |sql: &str, expect_row: bool| Statement { sql: sql.into(), expect_row };
        let names = |conn: &mut Conn| run(conn, "SELECT name FROM t ORDER BY id", 10).unwrap().rows.into_iter().map(|r| r[0].clone().unwrap()).collect::<Vec<_>>();

        let changed = execute_all(&mut conn, &[st("UPDATE t SET name = 'A' WHERE id = 1", true), st("INSERT INTO t (name) VALUES ('c')", false)]).unwrap();
        assert_eq!(changed, vec![1, 1]);
        assert_eq!(names(&mut conn), ["A", "b", "c"]);

        // The second statement fails (NOT NULL): the first is rolled back too.
        let err = execute_all(&mut conn, &[st("UPDATE t SET name = 'B' WHERE id = 2", true), st("INSERT INTO t (name) VALUES (NULL)", false)]).unwrap_err();
        assert!(err.starts_with("Statement 2 of 2 failed, nothing was saved"), "{err}");
        assert_eq!(names(&mut conn), ["A", "b", "c"]);

        // A row deleted meanwhile: the update matches nothing, so nothing is saved.
        let err = execute_all(&mut conn, &[st("DELETE FROM t WHERE id = 3", true), st("UPDATE t SET name = 'x' WHERE id = 99", true)]).unwrap_err();
        assert!(err.contains("no row matched"), "{err}");
        assert_eq!(names(&mut conn), ["A", "b", "c"]);

        // The connection is usable afterwards (no transaction left open).
        assert_eq!(execute_all(&mut conn, &[st("DELETE FROM t WHERE id = 3", true)]).unwrap(), vec![1]);
    }

    /// Regression: connecting ran the version query (and dropped replaced connections) on the
    /// async runtime, which panics with the blocking postgres driver and aborted the app.
    /// Runs against a real server when PHPBLITZ_TEST_PG="host port user password database" is set.
    #[test]
    fn connects_postgres_from_the_async_runtime() {
        let Ok(spec) = std::env::var("PHPBLITZ_TEST_PG") else { return };
        let p: Vec<&str> = spec.split_whitespace().collect();
        let source = DataSource {
            id: "pg-runtime-test".into(),
            driver: "postgres".into(),
            host: p[0].into(),
            port: p[1].parse().ok(),
            user: p[2].into(),
            database: p[4].into(),
            file: String::new(),
            ssl: false,
        };
        let state = DbState::default();
        tauri::async_runtime::block_on(async {
            let version = connect(&state, source.clone(), Some(p[3].into())).await.expect("connect");
            assert!(version.contains("PostgreSQL"), "{version}");
            // Reconnecting replaces (and drops) the first connection.
            connect(&state, source, Some(p[3].into())).await.expect("reconnect");
        });
        let conn = conn_of(&state, "pg-runtime-test").unwrap();
        let rows = run(&mut conn.lock().unwrap(), "select 1 + 1", 10).unwrap().rows;
        assert_eq!(rows, vec![vec![Some("2".to_string())]]);
        drop(conn);
        let removed = state.conns.lock().unwrap().remove("pg-runtime-test");
        drop(removed);
    }

    fn sqlite_source(file: &std::path::Path) -> DataSource {
        DataSource {
            id: "test".into(),
            driver: "sqlite".into(),
            host: String::new(),
            port: None,
            user: String::new(),
            database: String::new(),
            file: file.to_string_lossy().into_owned(),
            ssl: false,
        }
    }

    /// SQLite: Cancel interrupts a long query, and the connection works on.
    #[test]
    fn sqlite_cancels() {
        let dir = std::env::temp_dir().join(format!("phpblitz-db-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cancel.sqlite");
        let _ = std::fs::remove_file(&file);
        rusqlite::Connection::open(&file).unwrap();
        let (mut conn, cancel) = open_with_cancel(&sqlite_source(&file), None).unwrap();
        let cancel = std::sync::Arc::new(cancel);
        let stopper = std::sync::Arc::clone(&cancel);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            stopper.cancel().unwrap();
        });
        let started = Instant::now();
        // Counts to a billion: minutes without Cancel.
        let err = run_with(&mut conn, "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1000000000) SELECT count(*) FROM c", 10, Some(&cancel)).unwrap_err();
        t.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(10), "{err}");
        assert!(err.to_lowercase().contains("interrupt"), "{err}");
        assert_eq!(run(&mut conn, "SELECT 40 + 2", 10).unwrap().rows, vec![vec![Some("42".to_string())]]);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sqlite_queries_and_metadata() {
        let dir = std::env::temp_dir().join(format!("phpblitz-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("shop.sqlite");
        let _ = std::fs::remove_file(&file);
        rusqlite::Connection::open(&file).unwrap();

        let mut conn = open(&sqlite_source(&file), None).unwrap();
        assert!(version(&mut conn).starts_with("SQLite "));

        let created = run(
            &mut conn,
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, avatar BLOB); \
             INSERT INTO users (name, score, avatar) VALUES ('Ada', 9.5, x'0102'), ('Linus', NULL, NULL);",
            100,
        )
        .unwrap();
        assert_eq!(created.affected, Some(2), "last statement's row count");

        let r = run(&mut conn, "SELECT id, name, score, avatar FROM users ORDER BY id", 1).unwrap();
        assert_eq!(r.columns, ["id", "name", "score", "avatar"]);
        assert_eq!(r.rows, vec![vec![Some("1".into()), Some("Ada".into()), Some("9.5".into()), Some("<blob 2 bytes>".into())]]);
        assert!(r.truncated, "limit 1 of 2 rows");

        let info = run(&mut conn, "PRAGMA table_info('users')", 100).unwrap();
        assert_eq!(info.rows.len(), 4);

        let err = run(&mut conn, "SELECT nope FROM users", 10).unwrap_err();
        assert!(err.contains("nope"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

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

#[derive(Default)]
pub struct DbState {
    conns: Mutex<HashMap<String, Arc<Mutex<Conn>>>>,
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

fn open(ds: &DataSource, password: Option<String>) -> Result<Conn, String> {
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
                // Like libpq's sslmode=require: encrypted, certificate not verified.
                let tls = native_tls::TlsConnector::builder()
                    .danger_accept_invalid_certs(true)
                    .build()
                    .map_err(|e| e.to_string())?;
                cfg.ssl_mode(postgres::config::SslMode::Require);
                cfg.connect(postgres_native_tls::MakeTlsConnector::new(tls))
            } else {
                cfg.connect(postgres::NoTls)
            };
            client.map(Conn::Postgres).map_err(|e| pg_error(&e))
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
            mysql::Conn::new(opts).map(Conn::Mysql).map_err(|e| e.to_string())
        }
        "sqlite" => {
            if !std::path::Path::new(&ds.file).is_file() {
                return Err(format!("{} does not exist", ds.file));
            }
            rusqlite::Connection::open_with_flags(&ds.file, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map(Conn::Sqlite)
                .map_err(|e| e.to_string())
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
fn run(conn: &mut Conn, sql: &str, limit: usize) -> Result<QueryResult, String> {
    let started = Instant::now();
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
                        continue;
                    }
                    current.rows.push(row.unwrap().into_iter().map(mysql_text).collect());
                }
                if current.columns.is_empty() {
                    current.affected = Some(affected);
                }
                out = current;
            }
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
    state
        .conns
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| "Not connected".to_string())
}

/// Connects (or reconnects) a data source and returns the server version.
/// `password`: use this one (e.g. just typed in the dialog) instead of the saved one.
#[tauri::command]
pub async fn db_connect(state: State<'_, DbState>, source: DataSource, password: Option<String>) -> Result<String, String> {
    let id = source.id.clone();
    let mut conn = tauri::async_runtime::spawn_blocking(move || open(&source, password)).await.map_err(|e| e.to_string())??;
    let version = version(&mut conn);
    state.conns.lock().map_err(|e| e.to_string())?.insert(id, Arc::new(Mutex::new(conn)));
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
pub fn db_disconnect(state: State<'_, DbState>, id: String) -> Result<(), String> {
    state.conns.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn db_query(state: State<'_, DbState>, id: String, sql: String, limit: Option<usize>) -> Result<QueryResult, String> {
    let conn = conn_of(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = conn.lock().map_err(|e| e.to_string())?;
        run(&mut conn, &sql, limit.unwrap_or(1000))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves (or with `None`, forgets) a data source's password in the OS credential store.
#[tauri::command]
pub fn db_set_password(id: String, password: Option<String>) -> Result<(), String> {
    let entry = keyring_entry(&id)?;
    match password {
        Some(p) => entry.set_password(&p).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// Whether a password is saved, so the dialog can show "saved" without reading it back.
#[tauri::command]
pub fn db_has_password(id: String) -> bool {
    stored_password(&id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

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

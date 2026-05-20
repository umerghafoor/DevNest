use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::{AppError, AppResult};

const SCHEMA: &str = include_str!("../migrations/0001_init.sql");

pub type Db = Arc<Mutex<Connection>>;

pub fn open(app_data_dir: &std::path::Path) -> AppResult<Db> {
    std::fs::create_dir_all(app_data_dir)?;
    let path: PathBuf = app_data_dir.join("devnest.db");
    let conn = Connection::open(&path).map_err(|e| AppError::Db(e.to_string()))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| AppError::Db(e.to_string()))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| AppError::Db(e.to_string()))?;
    add_column_if_missing(&conn, "devices", "use_sudo", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(&conn, "devices", "keep_alive", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(Arc::new(Mutex::new(conn)))
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    spec: &str,
) -> AppResult<()> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| AppError::Db(e.to_string()))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| AppError::Db(e.to_string()))?
        .filter_map(|r| r.ok())
        .any(|name| name == column);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {spec}"),
            [],
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
    }
    Ok(())
}

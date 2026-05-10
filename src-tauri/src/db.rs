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
    Ok(Arc::new(Mutex::new(conn)))
}

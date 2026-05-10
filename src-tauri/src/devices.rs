use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub key_path: Option<String>,
    pub is_localhost: bool,
    pub sudo_prefix: Option<String>,
    pub use_sudo: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Key,
    Password,
    Localhost,
}

impl AuthType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthType::Key => "key",
            AuthType::Password => "password",
            AuthType::Localhost => "localhost",
        }
    }
}

impl std::str::FromStr for AuthType {
    type Err = AppError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "key" => Ok(AuthType::Key),
            "password" => Ok(AuthType::Password),
            "localhost" => Ok(AuthType::Localhost),
            other => Err(AppError::Invalid(format!("auth_type {other}"))),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDevice {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub key_path: Option<String>,
    pub sudo_prefix: Option<String>,
    #[serde(default)]
    pub use_sudo: bool,
}

const COLUMNS: &str = "id, name, host, port, username, auth_type, key_path, is_localhost, sudo_prefix, use_sudo, created_at, updated_at";

fn map_row(row: &Row<'_>) -> rusqlite::Result<Device> {
    let auth_str: String = row.get(5)?;
    Ok(Device {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get::<_, i64>(3)? as u16,
        username: row.get(4)?,
        auth_type: auth_str.parse().unwrap_or(AuthType::Password),
        key_path: row.get(6)?,
        is_localhost: row.get::<_, i64>(7)? == 1,
        sudo_prefix: row.get(8)?,
        use_sudo: row.get::<_, i64>(9)? == 1,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn ensure_localhost(db: &Db) -> AppResult<()> {
    let conn = db.lock();
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM devices WHERE is_localhost = 1 LIMIT 1",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| AppError::Db(e.to_string()))?
        .unwrap_or(false);

    if !exists {
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_ts();
        let username = std::env::var("USER").unwrap_or_else(|_| "user".into());
        conn.execute(
            "INSERT INTO devices (id, name, host, port, username, auth_type, key_path, is_localhost, sudo_prefix, use_sudo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 1, NULL, 0, ?, ?)",
            params![id, "localhost", "127.0.0.1", 22, username, "localhost", ts, ts],
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
    }
    Ok(())
}

pub fn list(db: &Db) -> AppResult<Vec<Device>> {
    let conn = db.lock();
    let sql = format!("SELECT {COLUMNS} FROM devices ORDER BY is_localhost DESC, name ASC");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| AppError::Db(e.to_string()))?;
    let rows = stmt
        .query_map([], map_row)
        .map_err(|e| AppError::Db(e.to_string()))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| AppError::Db(e.to_string()))?);
    }
    Ok(out)
}

pub fn create(db: &Db, new: NewDevice) -> AppResult<Device> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now_ts();

    {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO devices (id, name, host, port, username, auth_type, key_path, is_localhost, sudo_prefix, use_sudo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
            params![
                id,
                new.name,
                new.host,
                new.port as i64,
                new.username,
                new.auth_type.as_str(),
                new.key_path,
                new.sudo_prefix,
                if new.use_sudo { 1 } else { 0 },
                ts,
                ts,
            ],
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
    }

    get(db, &id)?.ok_or(AppError::NotFound(id))
}

pub fn get(db: &Db, id: &str) -> AppResult<Option<Device>> {
    let conn = db.lock();
    let sql = format!("SELECT {COLUMNS} FROM devices WHERE id = ?");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| AppError::Db(e.to_string()))?;
    let res = stmt
        .query_row(params![id], map_row)
        .optional()
        .map_err(|e| AppError::Db(e.to_string()))?;
    Ok(res)
}

pub fn set_use_sudo(db: &Db, id: &str, value: bool) -> AppResult<()> {
    let conn = db.lock();
    let ts = now_ts();
    conn.execute(
        "UPDATE devices SET use_sudo = ?, updated_at = ? WHERE id = ?",
        params![if value { 1 } else { 0 }, ts, id],
    )
    .map_err(|e| AppError::Db(e.to_string()))?;
    Ok(())
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    let conn = db.lock();
    let is_local: bool = conn
        .query_row(
            "SELECT is_localhost FROM devices WHERE id = ?",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .map(|v| v == 1)
        .map_err(|e| AppError::Db(e.to_string()))?;

    if is_local {
        return Err(AppError::Invalid("cannot delete localhost device".into()));
    }

    conn.execute("DELETE FROM devices WHERE id = ?", params![id])
        .map_err(|e| AppError::Db(e.to_string()))?;
    Ok(())
}

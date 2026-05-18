use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow};
use sqlx::sqlite::{SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::error::{AppError, AppResult};

pub const ROW_CAP: usize = 1000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SqlEngine {
    Postgres,
    Mysql,
    Sqlite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Value>>,
    pub truncated: bool,
    pub elapsed_ms: u128,
    pub rows_affected: Option<u64>,
}

/// Pool of live SQL connections keyed by connection id.
pub struct SqlPool {
    inner: Mutex<HashMap<String, Arc<EnginePool>>>,
}

#[allow(clippy::large_enum_variant)]
enum EnginePool {
    Postgres(sqlx::PgPool),
    Mysql(sqlx::MySqlPool),
    Sqlite(sqlx::SqlitePool),
}

impl SqlPool {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(
        &self,
        id: String,
        engine: SqlEngine,
        host: String,
        port: u16,
        username: String,
        password: Option<String>,
        database: Option<String>,
    ) -> AppResult<()> {
        let pool = match engine {
            SqlEngine::Postgres => {
                let mut opts = PgConnectOptions::new()
                    .host(&host)
                    .port(port)
                    .username(&username);
                if let Some(pw) = password.as_deref() {
                    opts = opts.password(pw);
                }
                if let Some(db) = database.as_deref() {
                    opts = opts.database(db);
                }
                let p = PgPoolOptions::new()
                    .max_connections(4)
                    .acquire_timeout(Duration::from_secs(10))
                    .connect_with(opts)
                    .await
                    .map_err(|e| AppError::Db(format!("postgres connect: {e}")))?;
                EnginePool::Postgres(p)
            }
            SqlEngine::Mysql => {
                let mut opts = MySqlConnectOptions::new()
                    .host(&host)
                    .port(port)
                    .username(&username);
                if let Some(pw) = password.as_deref() {
                    opts = opts.password(pw);
                }
                if let Some(db) = database.as_deref() {
                    opts = opts.database(db);
                }
                let p = MySqlPoolOptions::new()
                    .max_connections(4)
                    .acquire_timeout(Duration::from_secs(10))
                    .connect_with(opts)
                    .await
                    .map_err(|e| AppError::Db(format!("mysql connect: {e}")))?;
                EnginePool::Mysql(p)
            }
            SqlEngine::Sqlite => {
                // For SQLite the "database" carries the file path. Empty/none
                // means in-memory.
                let url = match database.as_deref() {
                    Some(path) if !path.is_empty() => format!("sqlite://{path}"),
                    _ => "sqlite::memory:".to_string(),
                };
                let p = SqlitePoolOptions::new()
                    .max_connections(4)
                    .acquire_timeout(Duration::from_secs(10))
                    .connect(&url)
                    .await
                    .map_err(|e| AppError::Db(format!("sqlite connect: {e}")))?;
                EnginePool::Sqlite(p)
            }
        };

        self.inner.lock().insert(id, Arc::new(pool));
        Ok(())
    }

    pub fn disconnect(&self, id: &str) {
        self.inner.lock().remove(id);
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.inner.lock().contains_key(id)
    }

    pub async fn query(&self, id: &str, sql: String) -> AppResult<QueryResult> {
        let pool = self
            .inner
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Db(format!("not connected: {id}")))?;

        let start = std::time::Instant::now();
        let trimmed = sql.trim_start().to_lowercase();
        let returns_rows = trimmed.starts_with("select")
            || trimmed.starts_with("show")
            || trimmed.starts_with("explain")
            || trimmed.starts_with("with")
            || trimmed.starts_with("pragma")
            || trimmed.starts_with("describe")
            || trimmed.starts_with("desc ");

        let result = match pool.as_ref() {
            EnginePool::Postgres(p) => {
                if returns_rows {
                    let rows = sqlx::query(&sql)
                        .fetch_all(p)
                        .await
                        .map_err(|e| AppError::Db(format!("postgres query: {e}")))?;
                    pg_rows_to_result(rows)
                } else {
                    let r = sqlx::query(&sql)
                        .execute(p)
                        .await
                        .map_err(|e| AppError::Db(format!("postgres exec: {e}")))?;
                    empty_result_with_affected(r.rows_affected())
                }
            }
            EnginePool::Mysql(p) => {
                if returns_rows {
                    let rows = sqlx::query(&sql)
                        .fetch_all(p)
                        .await
                        .map_err(|e| AppError::Db(format!("mysql query: {e}")))?;
                    mysql_rows_to_result(rows)
                } else {
                    let r = sqlx::query(&sql)
                        .execute(p)
                        .await
                        .map_err(|e| AppError::Db(format!("mysql exec: {e}")))?;
                    empty_result_with_affected(r.rows_affected())
                }
            }
            EnginePool::Sqlite(p) => {
                if returns_rows {
                    let rows = sqlx::query(&sql)
                        .fetch_all(p)
                        .await
                        .map_err(|e| AppError::Db(format!("sqlite query: {e}")))?;
                    sqlite_rows_to_result(rows)
                } else {
                    let r = sqlx::query(&sql)
                        .execute(p)
                        .await
                        .map_err(|e| AppError::Db(format!("sqlite exec: {e}")))?;
                    empty_result_with_affected(r.rows_affected())
                }
            }
        };

        let mut result = result;
        result.elapsed_ms = start.elapsed().as_millis();
        Ok(result)
    }

    pub async fn list_tables(&self, id: &str) -> AppResult<Vec<String>> {
        let pool = self
            .inner
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Db(format!("not connected: {id}")))?;

        let sql = match pool.as_ref() {
            EnginePool::Postgres(_) => {
                "SELECT table_schema || '.' || table_name AS name \
                 FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog','information_schema') \
                 ORDER BY 1"
            }
            EnginePool::Mysql(_) => {
                "SELECT table_name FROM information_schema.tables \
                 WHERE table_schema = DATABASE() ORDER BY table_name"
            }
            EnginePool::Sqlite(_) => {
                "SELECT name FROM sqlite_master \
                 WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            }
        };
        let result = self.query(id, sql.to_string()).await?;
        Ok(result
            .rows
            .into_iter()
            .filter_map(|r| r.into_iter().next())
            .map(|v| match v {
                Value::String(s) => s,
                other => other.to_string(),
            })
            .collect())
    }
}

fn empty_result_with_affected(affected: u64) -> QueryResult {
    QueryResult {
        columns: vec![],
        rows: vec![],
        truncated: false,
        elapsed_ms: 0,
        rows_affected: Some(affected),
    }
}

fn pg_rows_to_result(rows: Vec<PgRow>) -> QueryResult {
    let truncated = rows.len() > ROW_CAP;
    let rows: Vec<_> = rows.into_iter().take(ROW_CAP).collect();
    let columns = if let Some(r) = rows.first() {
        r.columns()
            .iter()
            .map(|c| ColumnInfo {
                name: c.name().to_string(),
                data_type: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        vec![]
    };
    let data: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| {
            (0..row.len())
                .map(|i| pg_value(row, i))
                .collect::<Vec<_>>()
        })
        .collect();
    QueryResult {
        columns,
        rows: data,
        truncated,
        elapsed_ms: 0,
        rows_affected: None,
    }
}

fn pg_value(row: &PgRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info();
    let name = ty.name();
    match name {
        "BOOL" => row.try_get::<bool, _>(i).map(Value::Bool).unwrap_or(Value::Null),
        "INT2" => row
            .try_get::<i16, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT4" => row
            .try_get::<i32, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT8" => row
            .try_get::<i64, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "FLOAT4" => row
            .try_get::<f32, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "FLOAT8" => row
            .try_get::<f64, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "JSON" | "JSONB" => row
            .try_get::<Value, _>(i)
            .unwrap_or(Value::Null),
        "TIMESTAMP" | "TIMESTAMPTZ" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(i)
            .map(|v| json!(v.to_rfc3339()))
            .or_else(|_| {
                row.try_get::<chrono::NaiveDateTime, _>(i)
                    .map(|v| json!(v.to_string()))
            })
            .unwrap_or(Value::Null),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(i)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(i)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(i)
            .map(Value::String)
            .unwrap_or_else(|_| Value::String(format!("<{name}>"))),
    }
}

fn mysql_rows_to_result(rows: Vec<MySqlRow>) -> QueryResult {
    let truncated = rows.len() > ROW_CAP;
    let rows: Vec<_> = rows.into_iter().take(ROW_CAP).collect();
    let columns = if let Some(r) = rows.first() {
        r.columns()
            .iter()
            .map(|c| ColumnInfo {
                name: c.name().to_string(),
                data_type: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        vec![]
    };
    let data: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| (0..row.len()).map(|i| mysql_value(row, i)).collect())
        .collect();
    QueryResult {
        columns,
        rows: data,
        truncated,
        elapsed_ms: 0,
        rows_affected: None,
    }
}

fn mysql_value(row: &MySqlRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info();
    let name = ty.name();
    match name {
        "BOOLEAN" | "TINYINT" => row
            .try_get::<i8, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "SMALLINT" => row
            .try_get::<i16, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT" | "MEDIUMINT" => row
            .try_get::<i32, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "BIGINT" => row
            .try_get::<i64, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "FLOAT" => row
            .try_get::<f32, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "DOUBLE" => row
            .try_get::<f64, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "JSON" => row.try_get::<Value, _>(i).unwrap_or(Value::Null),
        "DATETIME" | "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(i)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(i)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(i)
            .map(Value::String)
            .unwrap_or_else(|_| Value::String(format!("<{name}>"))),
    }
}

fn sqlite_rows_to_result(rows: Vec<SqliteRow>) -> QueryResult {
    let truncated = rows.len() > ROW_CAP;
    let rows: Vec<_> = rows.into_iter().take(ROW_CAP).collect();
    let columns = if let Some(r) = rows.first() {
        r.columns()
            .iter()
            .map(|c| ColumnInfo {
                name: c.name().to_string(),
                data_type: c.type_info().name().to_string(),
            })
            .collect()
    } else {
        vec![]
    };
    let data: Vec<Vec<Value>> = rows
        .iter()
        .map(|row| (0..row.len()).map(|i| sqlite_value(row, i)).collect())
        .collect();
    QueryResult {
        columns,
        rows: data,
        truncated,
        elapsed_ms: 0,
        rows_affected: None,
    }
}

fn sqlite_value(row: &SqliteRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info();
    let name = ty.name();
    match name {
        "INTEGER" => row
            .try_get::<i64, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "REAL" => row
            .try_get::<f64, _>(i)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "BOOLEAN" => row
            .try_get::<bool, _>(i)
            .map(Value::Bool)
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(i)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

use tauri::State;

use crate::devices::{self, Device, DeviceUpdate, NewDevice};
use crate::docker::{self, ContainerSummary};
use crate::error::{AppError, AppResult};
use crate::metrics::{self, CpuInfo, DimmModule, MetricsSnapshot};
use crate::secrets;
use crate::sql::{QueryResult, SqlEngine};
use crate::ssh::{self, CommandOutput};
use crate::state::AppState;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
pub fn app_version() -> AppResult<String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

fn require_device(state: &AppState, id: &str) -> AppResult<Device> {
    devices::get(&state.db, id)?.ok_or_else(|| AppError::NotFound(id.to_string()))
}

#[tauri::command]
pub fn list_devices(state: State<'_, AppState>) -> AppResult<Vec<Device>> {
    devices::list(&state.db)
}

#[tauri::command]
pub fn create_device(
    state: State<'_, AppState>,
    new: NewDevice,
    secret: Option<String>,
) -> AppResult<Device> {
    let device = devices::create(&state.db, new)?;
    if let Some(s) = secret {
        secrets::set(&device.id, &s)?;
    }
    Ok(device)
}

#[tauri::command]
pub fn delete_device(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.pool.disconnect(&id);
    secrets::delete(&id).ok();
    devices::delete(&state.db, &id)
}

/// Update an existing device's config. `secret` semantics:
///  - `None`  → keep the stored keyring entry as-is.
///  - `Some("")` → clear the keyring entry (e.g. drop a key passphrase).
///  - `Some(s)`  → overwrite the keyring entry with `s`.
///
/// Drops any live SSH session for this device so the new config takes
/// effect on the next connect (the heartbeat will reconnect within ~15s
/// if the device was previously connected).
#[tauri::command]
pub fn update_device(
    state: State<'_, AppState>,
    id: String,
    patch: DeviceUpdate,
    secret: Option<String>,
) -> AppResult<Device> {
    let device = devices::update(&state.db, &id, patch)?;
    if let Some(s) = secret {
        if s.is_empty() {
            secrets::delete(&id).ok();
        } else {
            secrets::set(&id, &s)?;
        }
    }
    // Force a reconnect with the new config.
    state.pool.disconnect(&id);
    Ok(device)
}

#[tauri::command]
pub fn set_use_sudo(state: State<'_, AppState>, id: String, value: bool) -> AppResult<Device> {
    devices::set_use_sudo(&state.db, &id, value)?;
    if !value {
        secrets::delete_sudo(&id).ok();
    }
    require_device(&state, &id)
}

/// Toggle the per-device `keep_alive` flag. When the device is currently
/// connected we don't reconfigure the live session here — the new value
/// takes effect on the next connect (which is when the SSH session is
/// rebuilt anyway). The heartbeat will reconnect within ~15s if the user
/// flipped this because their session was dropping.
#[tauri::command]
pub fn set_keep_alive(state: State<'_, AppState>, id: String, value: bool) -> AppResult<Device> {
    devices::set_keep_alive(&state.db, &id, value)?;
    require_device(&state, &id)
}

#[tauri::command]
pub fn set_sudo_password(
    _state: State<'_, AppState>,
    id: String,
    password: String,
) -> AppResult<()> {
    secrets::set_sudo(&id, &password)
}

#[tauri::command]
pub fn has_sudo_password(_state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(secrets::get_sudo(&id)?.is_some())
}

#[tauri::command]
pub fn clear_sudo_password(_state: State<'_, AppState>, id: String) -> AppResult<()> {
    secrets::delete_sudo(&id)
}

#[tauri::command]
pub fn connect_device(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let device = require_device(&state, &id)?;
    if device.is_localhost {
        return Ok(());
    }
    state.pool.connect(&device)
}

#[tauri::command]
pub fn disconnect_device(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.pool.disconnect(&id);
    Ok(())
}

#[tauri::command]
pub fn device_status(state: State<'_, AppState>, id: String) -> AppResult<&'static str> {
    let device = require_device(&state, &id)?;
    if device.is_localhost {
        return Ok("connected");
    }
    Ok(if state.pool.is_connected(&id) {
        "connected"
    } else {
        "offline"
    })
}

/// Actively probe the SSH session for liveness. Unlike `device_status`,
/// this opens a channel on the existing session and runs a no-op; if the
/// probe fails (TCP drop, server kicked us, etc.) the pooled session is
/// dropped so the next status call returns "offline". Returns the
/// post-probe status.
#[tauri::command]
pub fn device_ping(state: State<'_, AppState>, id: String) -> AppResult<&'static str> {
    let device = require_device(&state, &id)?;
    if device.is_localhost {
        return Ok("connected");
    }
    if !state.pool.is_connected(&id) {
        return Ok("offline");
    }
    Ok(if state.pool.probe(&id) {
        "connected"
    } else {
        "offline"
    })
}

#[tauri::command]
pub fn run_remote_command(
    state: State<'_, AppState>,
    device_id: String,
    cmd: String,
) -> AppResult<CommandOutput> {
    let device = require_device(&state, &device_id)?;
    ssh::run_command(&state.pool, &device, &cmd)
}

#[tauri::command]
pub fn docker_list_containers(
    state: State<'_, AppState>,
    device_id: String,
) -> AppResult<Vec<ContainerSummary>> {
    let device = require_device(&state, &device_id)?;
    docker::list_containers(&state.pool, &device)
}

#[tauri::command]
pub fn docker_action(
    state: State<'_, AppState>,
    device_id: String,
    container_id: String,
    action: String,
) -> AppResult<CommandOutput> {
    let device = require_device(&state, &device_id)?;
    docker::action(&state.pool, &device, &container_id, &action)
}

#[tauri::command]
pub fn docker_logs(
    state: State<'_, AppState>,
    device_id: String,
    container_id: String,
    tail: Option<u32>,
) -> AppResult<String> {
    let device = require_device(&state, &device_id)?;
    docker::logs(&state.pool, &device, &container_id, tail.unwrap_or(200))
}

// Marked `async` so Tauri runs them on the async runtime instead of the main
// (UI) thread. The functions themselves are sync — `async` here just opts
// them out of main-thread execution so a slow shell-out (e.g. dmidecode)
// never freezes the UI.
#[tauri::command(async)]
pub fn metrics_snapshot(
    state: State<'_, AppState>,
    device_id: String,
) -> AppResult<MetricsSnapshot> {
    let device = require_device(&state, &device_id)?;
    metrics::snapshot(&state.pool, &device)
}

#[tauri::command(async)]
pub fn cpu_info(state: State<'_, AppState>, device_id: String) -> AppResult<CpuInfo> {
    let device = require_device(&state, &device_id)?;
    metrics::cpu_info(&state.pool, &device)
}

#[tauri::command(async)]
pub fn dimm_info(state: State<'_, AppState>, device_id: String) -> AppResult<Vec<DimmModule>> {
    let device = require_device(&state, &device_id)?;
    metrics::dimms(&state.pool, &device)
}

// ── SQL ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn sql_set_password(_state: State<'_, AppState>, id: String, password: String) -> AppResult<()> {
    secrets::set_sql(&id, &password)
}

#[tauri::command]
pub fn sql_clear_password(_state: State<'_, AppState>, id: String) -> AppResult<()> {
    secrets::delete_sql(&id)
}

#[tauri::command]
pub fn sql_has_password(_state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(secrets::get_sql(&id)?.is_some())
}

/// Open an SSH local-port forward through `device_id` to `remote_host:remote_port`.
/// Returns the local port (on 127.0.0.1) that callers should connect to.
#[tauri::command]
pub fn sql_open_tunnel(
    state: State<'_, AppState>,
    id: String,
    device_id: String,
    remote_host: String,
    remote_port: u16,
) -> AppResult<u16> {
    let device = require_device(&state, &device_id)?;
    if device.is_localhost {
        return Err(AppError::Invalid(
            "cannot tunnel through localhost device".into(),
        ));
    }
    state.tunnels.open(&id, &device, remote_host, remote_port)
}

#[tauri::command]
pub fn sql_close_tunnel(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.tunnels.close(&id);
    Ok(())
}

#[tauri::command]
pub async fn sql_connect(
    state: State<'_, AppState>,
    id: String,
    engine: SqlEngine,
    host: String,
    port: u16,
    username: String,
    database: Option<String>,
) -> AppResult<()> {
    let password = secrets::get_sql(&id)?;
    state
        .sql
        .connect(id, engine, host, port, username, password, database)
        .await
}

#[tauri::command]
pub fn sql_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.sql.disconnect(&id);
    Ok(())
}

#[tauri::command]
pub fn sql_is_connected(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(state.sql.is_connected(&id))
}

#[tauri::command]
pub async fn sql_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
) -> AppResult<QueryResult> {
    state.sql.query(&id, sql).await
}

#[tauri::command]
pub async fn sql_list_tables(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<String>> {
    state.sql.list_tables(&id).await
}

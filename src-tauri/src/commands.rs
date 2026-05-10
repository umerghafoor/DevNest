use tauri::State;

use crate::devices::{self, Device, NewDevice};
use crate::docker::{self, ContainerSummary};
use crate::error::{AppError, AppResult};
use crate::metrics::{self, MetricsSnapshot};
use crate::secrets;
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

#[tauri::command]
pub fn set_use_sudo(state: State<'_, AppState>, id: String, value: bool) -> AppResult<Device> {
    devices::set_use_sudo(&state.db, &id, value)?;
    if !value {
        secrets::delete_sudo(&id).ok();
    }
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

#[tauri::command]
pub fn metrics_snapshot(
    state: State<'_, AppState>,
    device_id: String,
) -> AppResult<MetricsSnapshot> {
    let device = require_device(&state, &device_id)?;
    metrics::snapshot(&state.pool, &device)
}

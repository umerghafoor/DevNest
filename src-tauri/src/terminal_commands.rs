use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::devices;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::terminal;

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<String> {
    let term_id = Uuid::new_v4().to_string();
    let tid = term_id.clone();

    let device = devices::get(&state.db, &device_id)?.ok_or(AppError::NotFound(device_id))?;

    let on_output = move |chunk: Vec<u8>| {
        let _ = app.emit(&format!("terminal:{tid}"), B64.encode(&chunk));
    };

    let handle = if device.is_localhost {
        terminal::spawn_local(cols, rows, on_output)?
    } else {
        terminal::spawn_remote(&device, cols, rows, on_output)?
    };

    state.terminals.insert(term_id.clone(), handle);
    Ok(term_id)
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, term_id: String, data: String) -> AppResult<()> {
    let bytes = B64
        .decode(&data)
        .map_err(|_| AppError::Invalid("bad base64".into()))?;
    let handle = state
        .terminals
        .get(&term_id)
        .ok_or(AppError::NotFound(term_id))?;
    handle.write(bytes)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    term_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    let handle = state
        .terminals
        .get(&term_id)
        .ok_or(AppError::NotFound(term_id))?;
    handle.resize(cols, rows)
}

#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, term_id: String) -> AppResult<()> {
    state.terminals.remove(&term_id);
    Ok(())
}

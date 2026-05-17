/// systemd service management.
///
/// Works on the local device or any SSH device through `ssh::run_command`,
/// which also handles sudo wrapping when `device.use_sudo` is set.
use serde::Serialize;

use crate::devices::Device;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, SessionPool};

/// Single-quote-wrap a string for shell. Unit names are already sanitized
/// to an alphanumeric-plus-`.-_@:\` charset before reaching this, so we just
/// need to guard against the `'` byte (which sanitize_unit_name rejects).
fn shq(s: &str) -> String {
    format!("'{s}'")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemdUnit {
    pub name: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
    pub unit_file_state: Option<String>,
}

/// List all .service units with status + enable-state.
pub fn list_units(pool: &SessionPool, device: &Device) -> AppResult<Vec<SystemdUnit>> {
    // Use --all so inactive units show up too. --no-legend --plain to ease parsing.
    let out = ssh::run_command(
        pool,
        device,
        "systemctl list-units --type=service --all --no-legend --plain --no-pager",
    )?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "systemctl list-units exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }

    let mut units: Vec<SystemdUnit> = Vec::new();
    for line in out.stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Format: NAME LOAD ACTIVE SUB DESCRIPTION...
        let mut parts = trimmed.splitn(5, char::is_whitespace).peekable();
        let name = parts.next().unwrap_or("").to_string();
        let load = parts.next().unwrap_or("").to_string();
        let active = parts.next().unwrap_or("").to_string();
        let sub = parts.next().unwrap_or("").to_string();
        let description = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() || !name.ends_with(".service") {
            continue;
        }
        units.push(SystemdUnit {
            name,
            load,
            active,
            sub,
            description,
            unit_file_state: None,
        });
    }

    // Enrich with enable-state from list-unit-files (cheap, one extra call).
    let files = ssh::run_command(
        pool,
        device,
        "systemctl list-unit-files --type=service --no-legend --plain --no-pager",
    )?;
    if files.exit_code == 0 {
        use std::collections::HashMap;
        let mut states: HashMap<String, String> = HashMap::new();
        for line in files.stdout.lines() {
            let mut parts = line.split_whitespace();
            let Some(name) = parts.next() else { continue };
            let Some(state) = parts.next() else { continue };
            states.insert(name.to_string(), state.to_string());
        }
        for u in &mut units {
            if let Some(s) = states.get(&u.name) {
                u.unit_file_state = Some(s.clone());
            }
        }
    }
    Ok(units)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitStatus {
    pub name: String,
    pub active: String,
    pub sub: String,
    pub enabled: Option<String>,
    pub main_pid: Option<u32>,
    pub description: String,
}

/// Detailed status for a single unit.
pub fn unit_status(pool: &SessionPool, device: &Device, name: &str) -> AppResult<UnitStatus> {
    let unit = sanitize_unit_name(name)?;
    let unit_esc = shq(&unit);
    let cmd = format!(
        "systemctl show {unit_esc} --property=ActiveState,SubState,UnitFileState,MainPID,Description --no-pager"
    );
    let out = ssh::run_command(pool, device, &cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "systemctl show exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }
    let mut active = String::new();
    let mut sub = String::new();
    let mut enabled: Option<String> = None;
    let mut pid: Option<u32> = None;
    let mut description = String::new();
    for line in out.stdout.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k {
            "ActiveState" => active = v.to_string(),
            "SubState" => sub = v.to_string(),
            "UnitFileState" if !v.is_empty() => {
                enabled = Some(v.to_string());
            }
            "MainPID" => {
                pid = v.parse::<u32>().ok().filter(|p| *p != 0);
            }
            "Description" => description = v.to_string(),
            _ => {}
        }
    }
    Ok(UnitStatus {
        name: unit,
        active,
        sub,
        enabled,
        main_pid: pid,
        description,
    })
}

/// Get the unit file contents via `systemctl cat`.
pub fn unit_cat(pool: &SessionPool, device: &Device, name: &str) -> AppResult<String> {
    let unit = sanitize_unit_name(name)?;
    let cmd = format!("systemctl cat {} --no-pager", shq(&unit));
    let out = ssh::run_command(pool, device, &cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "systemctl cat exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }
    Ok(out.stdout)
}

/// Run one of start/stop/restart/enable/disable on a unit.
pub fn unit_action(
    pool: &SessionPool,
    device: &Device,
    name: &str,
    action: &str,
) -> AppResult<String> {
    let action = match action {
        "start" | "stop" | "restart" | "reload" | "enable" | "disable" => action,
        _ => return Err(AppError::Invalid(format!("unknown action: {action}"))),
    };
    let unit = sanitize_unit_name(name)?;
    let cmd = format!(
        "systemctl {action} {}",
        shq(&unit)
    );
    let out = ssh::run_command(pool, device, &cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "systemctl {action} exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }
    Ok(out.stdout)
}

pub fn daemon_reload(pool: &SessionPool, device: &Device) -> AppResult<()> {
    let out = ssh::run_command(pool, device, "systemctl daemon-reload")?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "daemon-reload exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }
    Ok(())
}

/// Write a unit file to `/etc/systemd/system/<name>` and run daemon-reload.
/// The write uses `tee` so sudo wrapping is applied if the device has sudo enabled.
pub fn write_unit_file(
    pool: &SessionPool,
    device: &Device,
    name: &str,
    content: &str,
) -> AppResult<()> {
    let unit = sanitize_unit_name(name)?;
    let path = format!("/etc/systemd/system/{unit}");
    let path_esc = shq(&path);
    // Base64-encode the content so arbitrary bytes (including newlines and
    // any sentinel sequences) round-trip cleanly through the shell. We then
    // pipe through `tee` so the redirection runs inside whatever sudo wrapper
    // run_command applies — `sudo cmd > /path` doesn't work because the shell
    // opens the file before sudo elevates.
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let cmd = format!("printf %s '{b64}' | base64 -d | tee {path_esc} > /dev/null");
    let out = ssh::run_command(pool, device, &cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "write unit exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }
    daemon_reload(pool, device)?;
    Ok(())
}

pub fn delete_unit_file(pool: &SessionPool, device: &Device, name: &str) -> AppResult<()> {
    let unit = sanitize_unit_name(name)?;
    let path = format!("/etc/systemd/system/{unit}");
    let path_esc = shq(&path);
    let cmd = format!("rm -f {path_esc}");
    let out = ssh::run_command(pool, device, &cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "delete unit exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }
    daemon_reload(pool, device)?;
    Ok(())
}

/// Reject unit names with whitespace, slashes, or anything other than the
/// characters systemd actually accepts. This is defense-in-depth on top of
/// the shell escaping.
fn sanitize_unit_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("unit name is empty".into()));
    }
    let ok = trimmed.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || c == '.'
            || c == '-'
            || c == '_'
            || c == '@'
            || c == ':'
            || c == '\\'
    });
    if !ok {
        return Err(AppError::Invalid(format!(
            "invalid unit name: {trimmed}"
        )));
    }
    Ok(trimmed.to_string())
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn systemd_list(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
) -> AppResult<Vec<SystemdUnit>> {
    let device = crate::devices::get(&state.db, &device_id)?
        .ok_or(AppError::NotFound(device_id))?;
    list_units(&state.pool, &device)
}

#[tauri::command]
pub fn systemd_status(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    name: String,
) -> AppResult<UnitStatus> {
    let device = crate::devices::get(&state.db, &device_id)?
        .ok_or(AppError::NotFound(device_id))?;
    unit_status(&state.pool, &device, &name)
}

#[tauri::command]
pub fn systemd_cat(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    name: String,
) -> AppResult<String> {
    let device = crate::devices::get(&state.db, &device_id)?
        .ok_or(AppError::NotFound(device_id))?;
    unit_cat(&state.pool, &device, &name)
}

#[tauri::command]
pub fn systemd_action(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    name: String,
    action: String,
) -> AppResult<String> {
    let device = crate::devices::get(&state.db, &device_id)?
        .ok_or(AppError::NotFound(device_id))?;
    unit_action(&state.pool, &device, &name, &action)
}

#[tauri::command]
pub fn systemd_write_unit(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    name: String,
    content: String,
) -> AppResult<()> {
    let device = crate::devices::get(&state.db, &device_id)?
        .ok_or(AppError::NotFound(device_id))?;
    write_unit_file(&state.pool, &device, &name, &content)
}

#[tauri::command]
pub fn systemd_delete_unit(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    name: String,
) -> AppResult<()> {
    let device = crate::devices::get(&state.db, &device_id)?
        .ok_or(AppError::NotFound(device_id))?;
    delete_unit_file(&state.pool, &device, &name)
}

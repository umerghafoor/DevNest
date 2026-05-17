mod commands;
mod db;
mod devices;
mod docker;
mod error;
mod git;
mod github;
mod http_client;
mod local_fs;
mod log_stream;
mod metrics;
mod ngrok;
mod secrets;
mod sftp;
mod sql;
mod ssh;
mod ssh_tunnel;
mod state;
mod systemd;
mod tailscale;
mod terminal;
mod terminal_commands;

use tauri::Manager;

use crate::state::AppState;

#[tauri::command]
fn sftp_list_dir(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
) -> error::AppResult<Vec<sftp::FileEntry>> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::list_dir(&path);
    }
    sftp::list_dir(&device, &path)
}

#[tauri::command]
fn sftp_read_file(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
) -> error::AppResult<String> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::read_file(&path);
    }
    sftp::read_file(&device, &path)
}

#[tauri::command]
fn sftp_write_file(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
    content: String,
) -> error::AppResult<()> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::write_file(&path, &content);
    }
    sftp::write_file(&device, &path, &content)
}

#[tauri::command]
fn sftp_mkdir(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
) -> error::AppResult<()> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::mkdir(&path);
    }
    sftp::mkdir(&device, &path)
}

#[tauri::command]
fn sftp_rename(
    state: tauri::State<'_, AppState>,
    device_id: String,
    from: String,
    to: String,
) -> error::AppResult<()> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::rename(&from, &to);
    }
    sftp::rename(&device, &from, &to)
}

#[tauri::command]
fn sftp_delete(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
    is_dir: bool,
) -> error::AppResult<()> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::delete(&path, is_dir);
    }
    sftp::delete(&device, &path, is_dir)
}

#[tauri::command]
fn tailscale_status(
    state: tauri::State<'_, AppState>,
    device_id: String,
) -> error::AppResult<tailscale::TailnetStatus> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    tailscale::status(&state.pool, &device)
}

#[tauri::command]
fn tailscale_set_exit_node(
    state: tauri::State<'_, AppState>,
    device_id: String,
    exit_node: Option<String>,
) -> error::AppResult<()> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    tailscale::set_exit_node(&state.pool, &device, exit_node.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,devnest=debug".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("app data dir resolves on every supported platform");
            let db = db::open(&app_data).expect("open devnest.db");
            devices::ensure_localhost(&db).expect("seed localhost device");
            app.manage(AppState {
                db,
                pool: ssh::SessionPool::new(),
                terminals: terminal::TerminalPool::new(),
                log_streams: log_stream::LogStreamPool::new(),
                ngrok: ngrok::NgrokPool::new(),
                tunnels: ssh_tunnel::TunnelPool::new(),
                sql: sql::SqlPool::new(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.ngrok.shutdown_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::app_version,
            commands::list_devices,
            commands::create_device,
            commands::delete_device,
            commands::set_use_sudo,
            commands::set_sudo_password,
            commands::has_sudo_password,
            commands::clear_sudo_password,
            commands::connect_device,
            commands::disconnect_device,
            commands::device_status,
            commands::device_ping,
            commands::run_remote_command,
            commands::docker_list_containers,
            commands::docker_action,
            commands::docker_logs,
            commands::metrics_snapshot,
            commands::cpu_info,
            commands::dimm_info,
            commands::sql_set_password,
            commands::sql_clear_password,
            commands::sql_has_password,
            commands::sql_open_tunnel,
            commands::sql_close_tunnel,
            commands::sql_connect,
            commands::sql_disconnect,
            commands::sql_is_connected,
            commands::sql_query,
            commands::sql_list_tables,
            terminal_commands::terminal_open,
            terminal_commands::terminal_write,
            terminal_commands::terminal_resize,
            terminal_commands::terminal_close,
            sftp_list_dir,
            sftp_read_file,
            sftp_write_file,
            sftp_mkdir,
            sftp_rename,
            sftp_delete,
            tailscale_status,
            tailscale_set_exit_node,
            log_stream::log_stream_start,
            log_stream::log_stream_stop,
            git::git_is_repo,
            git::git_branch,
            git::git_clone,
            git::git_log,
            git::git_branches,
            git::git_tags,
            git::git_show,
            git::git_diff,
            github::github_device_start,
            github::github_device_poll,
            github::github_signed_in,
            github::github_sign_out,
            github::github_user,
            github::github_list_repos,
            http_client::http_request,
            local_fs::fs_read_text,
            local_fs::fs_write_text,
            ngrok::ngrok_start,
            ngrok::ngrok_stop,
            ngrok::ngrok_list,
            ngrok::ngrok_available,
            systemd::systemd_list,
            systemd::systemd_status,
            systemd::systemd_cat,
            systemd::systemd_action,
            systemd::systemd_write_unit,
            systemd::systemd_delete_unit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devnest");
}

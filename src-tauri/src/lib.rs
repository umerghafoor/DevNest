mod commands;
mod db;
mod devices;
mod docker;
mod error;
mod git;
mod github;
mod http_client;
mod local_fs;
mod local_shell;
mod log_stream;
mod mac_rounded_corners;
mod metrics;
mod net;
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
fn sftp_disk_usage(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
    max_depth: Option<u32>,
) -> error::AppResult<sftp::DiskUsageNode> {
    let depth = max_depth.unwrap_or(4);
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::disk_usage(&path, depth);
    }

    // Run `du` over SSH and parse the flat output into a tree.
    let cmd = format!(
        "du -b --max-depth={depth} {path} 2>/dev/null || du -k --max-depth={depth} {path} 2>/dev/null",
        depth = depth,
        path = path,
    );
    let out = ssh::run_command(&state.pool, &device, &cmd)?;

    // Parse lines: each is "{size}\t{path}"
    let mut entries: Vec<(u64, String)> = Vec::new();
    for line in out.stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, '\t');
        let size_str = match parts.next() {
            Some(s) => s.trim(),
            None => continue,
        };
        let entry_path = match parts.next() {
            Some(p) => p.trim().to_string(),
            None => continue,
        };
        let size: u64 = size_str.parse().unwrap_or(0);
        entries.push((size, entry_path));
    }

    // The last line of `du` output is the root directory itself.
    // Build a tree from the flat list by inserting children under their parent.
    if entries.is_empty() {
        return Ok(sftp::DiskUsageNode {
            name: path.rsplit('/').next().unwrap_or(&path).to_string(),
            path: path.clone(),
            size: 0,
            children: Vec::new(),
        });
    }

    fn build_tree(entries: &[(u64, String)], root_path: &str) -> sftp::DiskUsageNode {
        use std::collections::HashMap;
        let mut nodes: HashMap<&str, sftp::DiskUsageNode> = HashMap::new();

        // Create a node for every entry.
        for (size, p) in entries {
            let name = p.rsplit('/').next().unwrap_or(p).to_string();
            nodes.insert(
                p.as_str(),
                sftp::DiskUsageNode {
                    name,
                    path: p.clone(),
                    size: *size,
                    children: Vec::new(),
                },
            );
        }

        // Sort entries by path depth (deepest first) so children are attached
        // before their parents.
        let mut sorted_paths: Vec<&str> = nodes.keys().copied().collect();
        sorted_paths.sort_by_key(|b| std::cmp::Reverse(b.matches('/').count()));

        for p in &sorted_paths {
            if *p == root_path {
                continue;
            }
            // Find the parent path.
            let parent = match p.rfind('/') {
                Some(idx) => {
                    let candidate = &p[..idx];
                    if candidate.is_empty() {
                        "/"
                    } else {
                        candidate
                    }
                }
                None => continue,
            };
            if nodes.contains_key(parent) {
                let child = nodes.remove(p).unwrap();
                if let Some(parent_node) = nodes.get_mut(parent) {
                    parent_node.children.push(child);
                }
            }
        }

        // Sort children by size descending in every node.
        fn sort_children(node: &mut sftp::DiskUsageNode) {
            node.children.sort_by_key(|b| std::cmp::Reverse(b.size));
            for child in &mut node.children {
                sort_children(child);
            }
        }

        let mut root = nodes
            .remove(root_path)
            .unwrap_or_else(|| sftp::DiskUsageNode {
                name: root_path
                    .rsplit('/')
                    .next()
                    .unwrap_or(root_path)
                    .to_string(),
                path: root_path.to_string(),
                size: 0,
                children: Vec::new(),
            });
        sort_children(&mut root);
        root
    }

    Ok(build_tree(&entries, &path))
}

#[tauri::command(async)]
fn sftp_download_file_bytes(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
) -> error::AppResult<Vec<u8>> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::download_file_bytes(&path);
    }
    sftp::download_file_bytes(&device, &path)
}

#[tauri::command(async)]
fn sftp_upload_file_bytes(
    state: tauri::State<'_, AppState>,
    device_id: String,
    path: String,
    data: Vec<u8>,
) -> error::AppResult<()> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    if device.is_localhost {
        return local_fs::upload_file_bytes(&path, &data);
    }
    sftp::upload_file_bytes(&device, &path, &data)
}

#[tauri::command(async)]
fn tailscale_status(
    state: tauri::State<'_, AppState>,
    device_id: String,
) -> error::AppResult<tailscale::TailnetStatus> {
    let device =
        devices::get(&state.db, &device_id)?.ok_or(error::AppError::NotFound(device_id))?;
    tailscale::status(&state.pool, &device)
}

#[tauri::command(async)]
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
        .plugin(tauri_plugin_window_state::Builder::new().build())
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
            commands::update_device,
            commands::delete_device,
            commands::set_use_sudo,
            commands::set_keep_alive,
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
            commands::system_info,
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
            sftp_disk_usage,
            sftp_download_file_bytes,
            sftp_upload_file_bytes,
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
            git::git_status,
            git::git_working_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            github::github_device_start,
            github::github_device_poll,
            github::github_signed_in,
            github::github_sign_out,
            github::github_user,
            github::github_list_repos,
            http_client::http_request,
            local_fs::fs_read_text,
            local_fs::fs_write_text,
            net::net_ping,
            net::net_speed_probe,
            net::net_speed_sample,
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
            mac_rounded_corners::enable_modern_window_style,
            mac_rounded_corners::reposition_traffic_lights,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devnest");
}

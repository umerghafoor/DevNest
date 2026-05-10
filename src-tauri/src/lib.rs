mod commands;
mod db;
mod devices;
mod docker;
mod error;
mod metrics;
mod secrets;
mod ssh;
mod state;

use tauri::Manager;

use crate::state::AppState;

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
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::app_version,
            commands::list_devices,
            commands::create_device,
            commands::delete_device,
            commands::connect_device,
            commands::disconnect_device,
            commands::device_status,
            commands::run_remote_command,
            commands::docker_list_containers,
            commands::docker_action,
            commands::docker_logs,
            commands::metrics_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devnest");
}

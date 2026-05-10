mod commands;
mod db;
mod error;

use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,devnest=debug".into()),
        )
        .init();

    let migrations = vec![Migration {
        version: 1,
        description: "create_devices_and_settings",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:devnest.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running devnest");
}

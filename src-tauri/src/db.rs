// DB access layer.
//
// Migrations live under src-tauri/migrations and are wired up in lib.rs via
// tauri_plugin_sql. For the MVP the JS side talks to SQLite directly through
// the plugin; this module exists as the home for any Rust-side queries we add
// later (e.g. background metrics writers, alert evaluator).

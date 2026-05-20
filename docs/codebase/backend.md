# Backend

Rust 2021, Tauri 2. Lives in `src-tauri/src/`. The crate name is
`devnest` (library `devnest_lib`).

## Boot

`main.rs` is a one-liner that calls `devnest_lib::run()`. That function
in `lib.rs`:

1. Registers Tauri plugins (`opener`, `dialog`) and sets up
   `tracing-subscriber`.
2. Opens the SQLite app DB (`Db::open()` in `db.rs`).
3. Builds `AppState` and `manage()`s it on the Tauri app handle.
4. Registers every `#[tauri::command]` in `invoke_handler!`.
5. Runs the window.

## AppState

[`state.rs`](../../src-tauri/src/state.rs) is the shared bag of pools
every command can reach:

```rust
pub struct AppState {
    pub db: Db,                  // app data (devices, settings)
    pub pool: SessionPool,       // SSH sessions, keyed by device id
    pub terminals: TerminalPool, // open PTYs (xterm.js backends)
    pub log_streams: LogStreamPool,
    pub ngrok: NgrokPool,
    pub tunnels: TunnelPool,     // SSH local-port forwards (for SQL)
    pub sql: SqlPool,            // live sqlx pools, keyed by connection id
}
```

A command receives `State<'_, AppState>` and reaches into whichever pool
it needs.

## Modules

| File                                   | Purpose                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands.rs`                          | Thin Tauri layer — wraps the modules below as `#[tauri::command]`s. Where the surface area lives.                                                                                           |
| `error.rs`                             | `AppError` (`Ssh`, `Db`, `NotFound`, `Invalid`, `SudoPasswordRequired`, `Io`) + JSON-friendly `Serialize` so the frontend gets `{kind, message, detail}`.                                   |
| `db.rs`                                | SQLite wrapper for app data; opens the DB under `dirs::data_local_dir()/devnest`.                                                                                                           |
| `devices.rs`                           | CRUD for `Device { id, name, host, port, username, authType, … }`.                                                                                                                          |
| `secrets.rs`                           | OS keyring access. Namespaced by service: `devnest` (SSH auth), `devnest-sudo`, `devnest-github`, `devnest-sql`.                                                                            |
| `ssh.rs`                               | `SessionPool` of `SshSession`s (one per device). Synchronous via the `ssh2` crate. `run_command` adds the optional sudo wrapping.                                                           |
| `ssh_tunnel.rs`                        | `TunnelPool` — opens a dedicated SSH session per tunnel and bridges a local 127.0.0.1 listener to `channel_direct_tcpip`. Used by the SQL client when a saved connection has `viaDeviceId`. |
| `sql.rs`                               | `SqlPool` of async sqlx pools (Postgres/MySQL/SQLite). 1k-row cap; converts driver-specific rows to JSON.                                                                                   |
| `docker.rs`                            | `docker ps`/`logs`/`start`/`stop` over the device's SSH session (or local shell).                                                                                                           |
| `metrics.rs`                           | CPU, memory, disk, network, thermal — built by reading `/proc` (Linux) or running shell commands.                                                                                           |
| `local_fs.rs`                          | Local file ops (read/write) for localhost devices.                                                                                                                                          |
| `sftp.rs`                              | Remote file ops over the SSH session.                                                                                                                                                       |
| `git.rs`                               | Wraps `git` CLI for repo introspection (log, branches, tags, diff).                                                                                                                         |
| `github.rs`                            | GitHub OAuth device flow + `gh` API for repos/user. Token in keyring.                                                                                                                       |
| `http_client.rs`                       | One async command: send an arbitrary HTTP request, return status/headers/body.                                                                                                              |
| `terminal.rs` / `terminal_commands.rs` | PTY lifecycle (`terminal_open` / `_write` / `_resize` / `_close`). Local PTYs via `portable-pty`, remote via SSH channel. Streams bytes back via `terminal:<id>` Tauri events.              |
| `log_stream.rs`                        | `tail -F`-style streaming. Spawns a process, streams stdout/stderr as `log:<id>` events.                                                                                                    |
| `ngrok.rs`                             | Manage local `ngrok` tunnels.                                                                                                                                                               |
| `tailscale.rs`                         | `tailscale status` + set-exit-node.                                                                                                                                                         |
| `systemd.rs`                           | List units, get status, edit unit files via SFTP.                                                                                                                                           |

## How a command typically looks

```rust
#[tauri::command]
pub fn docker_list_containers(
    state: State<'_, AppState>,
    device_id: String,
) -> AppResult<Vec<ContainerSummary>> {
    let device = require_device(&state, &device_id)?;
    docker::list_containers(&state.pool, &device)
}
```

The pattern:

1. Get the device record from `state.db`.
2. Hand off to a module function that does the real work using the
   relevant pool.
3. Return `AppResult<T>`. Errors serialise to the frontend automatically.

Async commands (`async fn`) work too — Tauri runs them on its
multi-threaded Tokio runtime. SQL, HTTP, and GitHub OAuth use this.

## SSH session model

`SessionPool` keeps one `SshSession` per device. Each session wraps
`ssh2::Session` behind a `parking_lot::Mutex` because `ssh2` is sync and
operations on a session can't run concurrently from multiple threads
without serialising.

Implications:

- A long-running command on a device blocks other commands on the _same_
  device while it holds the lock. Different devices are independent.
- The SQL client's SSH tunnels intentionally open a **new** SSH session
  per tunnel (`ssh_tunnel.rs::open_session`) so high-bandwidth tunnel
  traffic doesn't contend with the user's terminal / `docker ps` / etc.
- `SessionPool::probe(id)` runs `:` over the existing session to detect
  half-open TCP. If it fails, the session is dropped from the pool so
  the next status call returns "offline".

## Sudo flow

When a device has `use_sudo = true`, `ssh::run_command` wraps the
command in `sudo -S -p '' sh -c '<cmd>'` and pipes the keyring-stored
password to stdin. If the password is missing or rejected, the command
returns `AppError::SudoPasswordRequired(device_id)` and the frontend
shows the sudo-password dialog, stores the new password, and the next
call succeeds.

## Adding a Rust command

1. Write the function as `#[tauri::command]` in `commands.rs` (or in
   the relevant module if it's natural there — see `log_stream.rs`,
   `git.rs`, `github.rs`).
2. Add it to the `invoke_handler!` list in `lib.rs`.
3. Add a typed binding in `src/lib/api.ts`.
4. Call it from a panel.

Then `cargo check` + `npx tsc --noEmit`.

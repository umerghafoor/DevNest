/// Local ngrok tunnel management.
///
/// We shell out to the `ngrok` CLI (`ngrok http <port> --log=stdout
/// --log-format=json`) and parse the JSON log lines for the public URL.
///
/// Tunnels are app-managed: each one owns a child process, and all children
/// are killed when the app exits (see `shutdown_all`).
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: String,
    pub port: u16,
    pub proto: String,
    pub status: TunnelStatus,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Starting,
    Active,
    Stopped,
    Error,
}

struct TunnelEntry {
    info: Tunnel,
    child: Option<Child>,
}

#[derive(Default)]
pub struct NgrokPool {
    inner: Arc<Mutex<HashMap<String, TunnelEntry>>>,
}

impl NgrokPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<Tunnel> {
        self.inner
            .lock()
            .values()
            .map(|e| e.info.clone())
            .collect()
    }

    pub fn start(&self, port: u16, proto: String, app: AppHandle) -> AppResult<Tunnel> {
        if proto != "http" && proto != "tcp" {
            return Err(AppError::Invalid(format!("unsupported proto: {proto}")));
        }
        // Quick existence check so we fail fast with a clear message.
        which_ngrok()?;

        let id = uuid::Uuid::new_v4().to_string();
        let target = format!("{port}");
        let mut cmd = Command::new("ngrok");
        cmd.arg(&proto)
            .arg(&target)
            .arg("--log=stdout")
            .arg("--log-format=json")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::Invalid(format!("spawn ngrok: {e}")))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Invalid("ngrok stdout missing".into()))?;
        let stderr = child.stderr.take();

        let info = Tunnel {
            id: id.clone(),
            port,
            proto: proto.clone(),
            status: TunnelStatus::Starting,
            url: None,
            error: None,
        };
        let entry = TunnelEntry {
            info: info.clone(),
            child: Some(child),
        };
        self.inner.lock().insert(id.clone(), entry);

        // Stdout reader: parses JSON log lines for the tunnel URL.
        let pool = self.inner.clone();
        let id_stdout = id.clone();
        let app_stdout = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(url) = parse_url_from_log(&line) {
                    let mut guard = pool.lock();
                    if let Some(entry) = guard.get_mut(&id_stdout) {
                        entry.info.url = Some(url.clone());
                        entry.info.status = TunnelStatus::Active;
                        let snapshot = entry.info.clone();
                        drop(guard);
                        let _ = app_stdout.emit("ngrok:update", &snapshot);
                    } else {
                        break;
                    }
                }
                if let Some(err) = parse_error_from_log(&line) {
                    let mut guard = pool.lock();
                    if let Some(entry) = guard.get_mut(&id_stdout) {
                        entry.info.error = Some(err);
                        entry.info.status = TunnelStatus::Error;
                        let snapshot = entry.info.clone();
                        drop(guard);
                        let _ = app_stdout.emit("ngrok:update", &snapshot);
                    } else {
                        break;
                    }
                }
            }
        });

        // Stderr reader: capture any fatal errors that come on stderr instead
        // of as a JSON log line (e.g. "authtoken required").
        if let Some(stderr) = stderr {
            let pool = self.inner.clone();
            let id_stderr = id.clone();
            let app_stderr = app.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                let mut buf = String::new();
                for line in reader.lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        if !buf.is_empty() {
                            buf.push('\n');
                        }
                        buf.push_str(&line);
                    }
                }
                if !buf.is_empty() {
                    let mut guard = pool.lock();
                    if let Some(entry) = guard.get_mut(&id_stderr) {
                        if entry.info.status != TunnelStatus::Active {
                            entry.info.error = Some(buf.clone());
                            entry.info.status = TunnelStatus::Error;
                            let snapshot = entry.info.clone();
                            drop(guard);
                            let _ = app_stderr.emit("ngrok:update", &snapshot);
                        }
                    }
                }
            });
        }

        Ok(info)
    }

    pub fn stop(&self, id: &str) -> AppResult<()> {
        let mut guard = self.inner.lock();
        let Some(mut entry) = guard.remove(id) else {
            return Err(AppError::NotFound(id.to_string()));
        };
        if let Some(mut child) = entry.child.take() {
            // SIGKILL — ngrok closes the tunnel quickly on SIGTERM too, but kill
            // is more reliable across platforms.
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn shutdown_all(&self) {
        let mut guard = self.inner.lock();
        for (_id, mut entry) in guard.drain() {
            if let Some(mut child) = entry.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn which_ngrok() -> AppResult<()> {
    let probe = Command::new("ngrok").arg("--version").output();
    match probe {
        Ok(out) if out.status.success() => Ok(()),
        Ok(_) => Err(AppError::Invalid(
            "ngrok found but failed to run. Try `ngrok --version` in a terminal.".into(),
        )),
        Err(_) => Err(AppError::Invalid(
            "`ngrok` not found on PATH. Install it from https://ngrok.com/download and run `ngrok config add-authtoken <your-token>`.".into(),
        )),
    }
}

/// Parse one ngrok JSON log line and return the public URL if this line
/// announces a started tunnel.
fn parse_url_from_log(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let msg = v.get("msg").and_then(|m| m.as_str()).unwrap_or("");
    // ngrok logs `"msg":"started tunnel"` along with `"url"` once a tunnel is up.
    if msg.contains("started tunnel") || msg.contains("tunnel session started") {
        if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
            return Some(url.to_string());
        }
    }
    None
}

fn parse_error_from_log(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let level = v.get("lvl").and_then(|l| l.as_str()).unwrap_or("");
    if level == "error" || level == "fatal" || level == "crit" {
        return Some(
            v.get("err")
                .and_then(|e| e.as_str())
                .or_else(|| v.get("msg").and_then(|m| m.as_str()))
                .unwrap_or("ngrok error")
                .to_string(),
        );
    }
    None
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn ngrok_start(
    state: tauri::State<'_, crate::state::AppState>,
    app: AppHandle,
    port: u16,
    proto: String,
) -> AppResult<Tunnel> {
    state.ngrok.start(port, proto, app)
}

#[tauri::command]
pub fn ngrok_stop(
    state: tauri::State<'_, crate::state::AppState>,
    id: String,
) -> AppResult<()> {
    state.ngrok.stop(&id)
}

#[tauri::command]
pub fn ngrok_list(state: tauri::State<'_, crate::state::AppState>) -> AppResult<Vec<Tunnel>> {
    Ok(state.ngrok.list())
}

#[tauri::command]
pub fn ngrok_available() -> bool {
    which_ngrok().is_ok()
}

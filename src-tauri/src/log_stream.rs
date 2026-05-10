/// Background log-streaming over SSH.
///
/// `log_stream_start` opens a **dedicated** SSH connection (separate from the
/// session pool so it doesn't block other commands), runs an arbitrary command
/// (typically `tail -F <path>` or `journalctl -f`), and emits one Tauri event
/// per line on `log:<stream_id>`.
///
/// `log_stream_stop` sends a cancellation signal to the background thread,
/// which then drops the channel and connection.
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::devices::{self, Device};
use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;

/// Per-stream cancel handle
struct StreamHandle {
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct LogStreamPool {
    inner: Mutex<HashMap<String, StreamHandle>>,
}

impl LogStreamPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(
        &self,
        stream_id: String,
        device: Device,
        cmd: String,
        app: AppHandle,
    ) -> AppResult<()> {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_clone = cancel.clone();
        let sid = stream_id.clone();

        // Each stream gets its own SSH connection so it never contends with
        // the session pool used by other commands.
        let mut session = if device.is_localhost {
            None
        } else {
            Some(SshSession::connect(&device)?)
        };

        thread::spawn(move || {
            let event = format!("log:{sid}");

            if device.is_localhost {
                // Spawn a local process
                let child = std::process::Command::new("sh")
                    .arg("-c")
                    .arg(&cmd)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn();

                match child {
                    Err(e) => {
                        let _ = app.emit(&event, format!("[error] {e}"));
                    }
                    Ok(mut child) => {
                        let stdout = child.stdout.take().unwrap();
                        let reader = BufReader::new(stdout);
                        for line in reader.lines() {
                            if cancel_clone.load(Ordering::Relaxed) {
                                break;
                            }
                            match line {
                                Ok(l) => { let _ = app.emit(&event, l); }
                                Err(_) => break,
                            }
                        }
                        let _ = child.kill();
                    }
                }
            } else if let Some(ref mut sess) = session {
                match stream_ssh(sess, &cmd, &event, &cancel_clone, &app) {
                    Ok(_) => {}
                    Err(e) => { let _ = app.emit(&event, format!("[error] {e}")); }
                }
            }
        });

        self.inner.lock().insert(stream_id, StreamHandle { cancel });
        Ok(())
    }

    pub fn stop(&self, stream_id: &str) {
        if let Some(handle) = self.inner.lock().remove(stream_id) {
            handle.cancel.store(true, Ordering::Relaxed);
        }
    }
}

fn stream_ssh(
    session: &mut SshSession,
    cmd: &str,
    event: &str,
    cancel: &Arc<AtomicBool>,
    app: &AppHandle,
) -> AppResult<()> {
    let mut channel = session
        .channel_session()
        .map_err(|e| AppError::Ssh(format!("stream channel: {e}")))?;

    channel
        .exec(cmd)
        .map_err(|e| AppError::Ssh(format!("stream exec: {e}")))?;

    // Set non-blocking so we can check cancel flag
    session
        .set_blocking(false);

    let reader = BufReader::new(channel);
    for line in reader.lines() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        match line {
            Ok(l) => { let _ = app.emit(event, l); }
            Err(ref e) if is_would_block(e) => {
                // No data yet — small sleep to avoid busy spin
                thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }
            Err(_) => break,
        }
    }
    Ok(())
}

fn is_would_block(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::WouldBlock
        || e.raw_os_error() == Some(11) // EAGAIN on Linux
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn log_stream_start(
    state: tauri::State<'_, crate::state::AppState>,
    app: AppHandle,
    device_id: String,
    stream_id: String,
    cmd: String,
) -> AppResult<()> {
    let device = devices::get(&state.db, &device_id)?
        .ok_or(AppError::NotFound(device_id))?;
    state.log_streams.start(stream_id, device, cmd, app)
}

#[tauri::command]
pub fn log_stream_stop(
    state: tauri::State<'_, crate::state::AppState>,
    stream_id: String,
) -> AppResult<()> {
    state.log_streams.stop(&stream_id);
    Ok(())
}

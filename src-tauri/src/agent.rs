/// Third-party agent processes (Agent Client Protocol).
///
/// This module is a dumb line transport: it spawns the agent command on a
/// device (locally, or over a dedicated SSH channel), emits every stdout line
/// on `agent:<id>:out` (the JSON-RPC stream), every stderr line on
/// `agent:<id>:err` (diagnostics), and the exit code on `agent:<id>:exit`.
/// `agent_send` writes one line to the agent's stdin. The frontend picks
/// `<id>` so it can subscribe before the process starts.
///
/// All protocol logic (JSON-RPC, sessions, permissions, fs requests) lives in
/// the frontend (`src/lib/acp.ts`) so it can be unit-tested without Tauri.
///
/// The same transport runs agent install commands, so their output streams
/// into the panel too.
///
/// Agents are children of the app and are killed when it exits (see
/// `shutdown_all`).
use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::devices::{self, Device};
use crate::error::{AppError, AppResult};
use crate::ssh::{shell_single_quote as q, SessionPool, SshSession};

enum AgentEntry {
    Local {
        child: Child,
        stdin: ChildStdin,
    },
    /// The SSH thread owns the channel; we talk to it through `tx`.
    Remote {
        tx: Sender<String>,
        cancel: Arc<AtomicBool>,
    },
}

impl AgentEntry {
    fn kill(self) {
        match self {
            AgentEntry::Local { mut child, .. } => {
                let _ = child.kill();
                let _ = child.wait();
            }
            AgentEntry::Remote { cancel, .. } => cancel.store(true, Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
pub struct AgentPool {
    inner: Arc<Mutex<HashMap<String, AgentEntry>>>,
}

impl AgentPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(&self, id: String, device: &Device, spec: Spec, app: AppHandle) -> AppResult<()> {
        if self.inner.lock().contains_key(&id) {
            return Err(AppError::Invalid(format!("agent {id} already running")));
        }
        if spec.command.trim().is_empty() {
            return Err(AppError::Invalid("agent command is empty".into()));
        }
        if device.is_localhost {
            self.spawn_local(id, spec, app)
        } else {
            self.spawn_remote(id, device, spec, app)
        }
    }

    fn spawn_local(&self, id: String, spec: Spec, app: AppHandle) -> AppResult<()> {
        let cwd = if spec.cwd.trim().is_empty() {
            dirs::home_dir().ok_or_else(|| AppError::Invalid("no home directory".into()))?
        } else {
            spec.cwd.clone().into()
        };
        if !cwd.is_dir() {
            return Err(AppError::Invalid(format!(
                "not a directory: {}",
                cwd.display()
            )));
        }

        let mut cmd = login_shell_command(&spec.command, &spec.args);
        cmd.current_dir(cwd)
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::Invalid(format!("spawn {}: {e}", spec.command)))?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        // Register before the reader threads start so an agent that exits
        // instantly is still reaped (and reported) by the stdout thread.
        self.inner
            .lock()
            .insert(id.clone(), AgentEntry::Local { child, stdin });

        {
            let app = app.clone();
            let event = format!("agent:{id}:err");
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) => {
                            let _ = app.emit(&event, l);
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let inner = self.inner.clone();
        thread::spawn(move || {
            let out_event = format!("agent:{id}:out");
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if !l.trim().is_empty() {
                            let _ = app.emit(&out_event, l);
                        }
                    }
                    Err(_) => break,
                }
            }
            // stdout closed: the agent is gone (or about to be). Reap it.
            let entry = inner.lock().remove(&id);
            let code = match entry {
                Some(AgentEntry::Local { mut child, .. }) => {
                    child.wait().ok().and_then(|s| s.code())
                }
                _ => None,
            };
            let _ = app.emit(&format!("agent:{id}:exit"), code);
        });

        Ok(())
    }

    fn spawn_remote(
        &self,
        id: String,
        device: &Device,
        spec: Spec,
        app: AppHandle,
    ) -> AppResult<()> {
        // Dedicated connection: the agent holds its channel open for the
        // whole session and must not block the shared pool.
        let mut session = SshSession::connect(device)?;
        let mut channel = session.channel_session()?;
        channel
            .exec(&remote_command(&spec))
            .map_err(|e| AppError::Ssh(format!("agent exec: {e}")))?;
        session.set_blocking(false);

        let (tx, rx) = mpsc::channel::<String>();
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner.lock().insert(
            id.clone(),
            AgentEntry::Remote {
                tx,
                cancel: cancel.clone(),
            },
        );

        let inner = self.inner.clone();
        thread::spawn(move || {
            // Keep the session alive for as long as the channel.
            let _session = session;
            let code = pump_ssh(&mut channel, &rx, &cancel, &id, &app);
            inner.lock().remove(&id);
            let _ = app.emit(&format!("agent:{id}:exit"), code);
        });
        Ok(())
    }

    pub fn send(&self, id: &str, line: &str) -> AppResult<()> {
        let mut map = self.inner.lock();
        match map.get_mut(id) {
            Some(AgentEntry::Local { stdin, .. }) => {
                stdin.write_all(line.as_bytes())?;
                stdin.write_all(b"\n")?;
                stdin.flush()?;
                Ok(())
            }
            Some(AgentEntry::Remote { tx, .. }) => tx
                .send(format!("{line}\n"))
                .map_err(|_| AppError::Ssh("agent channel closed".into())),
            None => Err(AppError::NotFound(format!("agent {id}"))),
        }
    }

    pub fn kill(&self, id: &str) {
        let entry = self.inner.lock().remove(id);
        if let Some(entry) = entry {
            entry.kill();
        }
    }

    pub fn shutdown_all(&self) {
        let entries: Vec<_> = self.inner.lock().drain().map(|(_, e)| e).collect();
        for entry in entries {
            entry.kill();
        }
    }
}

pub struct Spec {
    pub command: String,
    pub args: Vec<String>,
    /// Empty = the user's home directory.
    pub cwd: String,
    pub env: HashMap<String, String>,
}

/// Single thread drives the non-blocking channel both ways: libssh2 sessions
/// aren't safe to use from several threads at once.
fn pump_ssh(
    channel: &mut ssh2::Channel,
    rx: &Receiver<String>,
    cancel: &AtomicBool,
    id: &str,
    app: &AppHandle,
) -> Option<i32> {
    let out_event = format!("agent:{id}:out");
    let err_event = format!("agent:{id}:err");
    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = channel.close();
            return None;
        }
        let mut progressed = false;

        // Outgoing: everything queued by `agent_send`.
        loop {
            match rx.try_recv() {
                Ok(line) => {
                    if write_all_nb(channel, line.as_bytes(), cancel).is_err() {
                        let _ = channel.close();
                        return None;
                    }
                    progressed = true;
                }
                Err(TryRecvError::Empty) => break,
                // Pool entry dropped (killed) — stop.
                Err(TryRecvError::Disconnected) => {
                    let _ = channel.close();
                    return None;
                }
            }
        }

        // Incoming stdout / stderr.
        match channel.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => {
                progressed = true;
                emit_lines(&mut out_buf, &chunk[..n], &out_event, app, true);
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        match channel.stderr().read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => {
                progressed = true;
                emit_lines(&mut err_buf, &chunk[..n], &err_event, app, false);
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => {}
        }

        if channel.eof() && !progressed {
            break;
        }
        if !progressed {
            thread::sleep(Duration::from_millis(10));
        }
    }

    // Give the server a moment to deliver the exit status.
    for _ in 0..50 {
        if channel.close().is_ok() && channel.wait_close().is_ok() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    channel.exit_status().ok()
}

fn write_all_nb(
    channel: &mut ssh2::Channel,
    mut buf: &[u8],
    cancel: &AtomicBool,
) -> std::io::Result<()> {
    while !buf.is_empty() {
        if cancel.load(Ordering::Relaxed) {
            return Err(ErrorKind::Interrupted.into());
        }
        match channel.write(buf) {
            Ok(n) => buf = &buf[n..],
            Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(e),
        }
    }
    loop {
        match channel.flush() {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(e),
        }
    }
}

/// Append `data` to `buf` and emit each complete line.
fn emit_lines(buf: &mut Vec<u8>, data: &[u8], event: &str, app: &AppHandle, skip_blank: bool) {
    buf.extend_from_slice(data);
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&line[..line.len() - 1]);
        let text = text.trim_end_matches('\r');
        if skip_blank && text.trim().is_empty() {
            continue;
        }
        let _ = app.emit(event, text.to_string());
    }
}

/// Shell prelude that adopts the PATH the user gets in an interactive
/// terminal. GUI apps on macOS don't inherit the shell PATH at all, and SSH
/// exec channels run a non-interactive shell, which on most distros skips
/// `~/.bashrc` — exactly where nvm, fnm, volta & co. add themselves. So
/// `gemini` works when the user types it but isn't found here.
///
/// We ask `$SHELL -lic` for its PATH, fenced by markers so anything the rc
/// files print can't corrupt it, and keep the current PATH if the answer
/// doesn't look like one (e.g. fish prints lists space-separated).
const ADOPT_USER_PATH: &str = r#"p=$("${SHELL:-/bin/sh}" -lic 'printf "\n__DEVNEST_PATH__=%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__DEVNEST_PATH__=//p' | tail -n 1)
case "$p" in *:*) PATH="$p"; export PATH ;; esac
"#;

/// `sh -c <script> devnest <command> <args…>`: exec the command with the
/// user's PATH, so it stays our direct child (kill works) with args as-is.
fn run_script() -> String {
    format!("{ADOPT_USER_PATH}exec \"$@\"")
}

/// Exits 0 if `$1` resolves with the user's PATH.
fn check_script() -> String {
    format!("{ADOPT_USER_PATH}command -v \"$1\" >/dev/null 2>&1")
}

#[cfg(unix)]
fn login_shell_command(command: &str, args: &[String]) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(run_script())
        .arg("devnest")
        .arg(command)
        .args(args);
    cmd
}

#[cfg(not(unix))]
fn login_shell_command(command: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(command);
    cmd.args(args);
    cmd
}

/// Remote equivalent, as one command line for the SSH exec channel.
fn remote_command(spec: &Spec) -> String {
    let mut s = String::new();
    if !spec.cwd.trim().is_empty() {
        s.push_str(&format!("cd {} && ", remote_path(&spec.cwd)));
    }
    s.push_str("exec ");
    if !spec.env.is_empty() {
        s.push_str("env ");
        for (k, v) in &spec.env {
            s.push_str(&q(&format!("{k}={v}")));
            s.push(' ');
        }
    }
    s.push_str("sh -c ");
    s.push_str(&q(&run_script()));
    s.push_str(" devnest ");
    s.push_str(&q(&spec.command));
    for a in &spec.args {
        s.push(' ');
        s.push_str(&q(a));
    }
    s
}

/// Quote a remote path, keeping a leading `~` expandable.
fn remote_path(p: &str) -> String {
    if p == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("\"$HOME\"/{}", q(rest))
    } else {
        q(p)
    }
}

/// Is `command` resolvable in the user's login shell on the device?
fn command_exists(pool: &SessionPool, device: &Device, command: &str) -> AppResult<bool> {
    if device.is_localhost {
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg(check_script())
            .arg("devnest")
            .arg(command)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        return Ok(status.success());
    }
    let script = format!("sh -c {} devnest {}", q(&check_script()), q(command));
    let sess = pool.get_or_connect(device)?;
    let out = sess.lock().run_with_stdin(&script, None)?;
    Ok(out.exit_code == 0)
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn agent_spawn(
    state: tauri::State<'_, crate::state::AppState>,
    app: AppHandle,
    device_id: String,
    agent_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Option<HashMap<String, String>>,
) -> AppResult<()> {
    let device = devices::get(&state.db, &device_id)?.ok_or(AppError::NotFound(device_id))?;
    let spec = Spec {
        command,
        args,
        cwd,
        env: env.unwrap_or_default(),
    };
    state.agents.spawn(agent_id, &device, spec, app)
}

#[tauri::command(async)]
pub fn agent_send(
    state: tauri::State<'_, crate::state::AppState>,
    agent_id: String,
    line: String,
) -> AppResult<()> {
    state.agents.send(&agent_id, &line)
}

#[tauri::command(async)]
pub fn agent_kill(
    state: tauri::State<'_, crate::state::AppState>,
    agent_id: String,
) -> AppResult<()> {
    state.agents.kill(&agent_id);
    Ok(())
}

#[tauri::command(async)]
pub fn agent_command_exists(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    command: String,
) -> AppResult<bool> {
    let device = devices::get(&state.db, &device_id)?.ok_or(AppError::NotFound(device_id))?;
    command_exists(&state.pool, &device, &command)
}

#[tauri::command(async)]
pub fn agent_secret_set(key_id: String, secret: String) -> AppResult<()> {
    crate::secrets::set_agent(&key_id, &secret)
}

#[tauri::command(async)]
pub fn agent_secret_get(key_id: String) -> AppResult<Option<String>> {
    crate::secrets::get_agent(&key_id)
}

#[tauri::command(async)]
pub fn agent_secret_delete(key_id: String) -> AppResult<()> {
    crate::secrets::delete_agent(&key_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_command_quotes_everything() {
        let spec = Spec {
            command: "npx".into(),
            args: vec!["-y".into(), "pkg with space".into()],
            cwd: "~/my repo".into(),
            env: HashMap::new(),
        };
        let cmd = remote_command(&spec);
        assert!(cmd.starts_with(r#"cd "$HOME"/'my repo' && exec sh -c '"#));
        assert!(cmd.ends_with(r#"' devnest 'npx' '-y' 'pkg with space'"#));
    }

    /// Run the real scripts with a fake $SHELL whose interactive startup
    /// adds a directory to PATH and prints noise, like an nvm .bashrc.
    #[cfg(unix)]
    #[test]
    fn adopts_interactive_path_and_ignores_rc_noise() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("devnest-path-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("fake-agent");
        std::fs::write(&tool, "#!/bin/sh\necho agent-ran \"$@\"\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A "shell" that only knows the extra PATH entry when interactive.
        let shell = dir.join("fake-shell");
        std::fs::write(
            &shell,
            format!(
                "#!/bin/sh\necho welcome-banner\nPATH=\"{}:$PATH\"\nshift\nexec /bin/sh -c \"$@\"\n",
                bin.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();

        let exists = Command::new("/bin/sh")
            .env("SHELL", &shell)
            .args(["-c", &check_script(), "devnest", "fake-agent"])
            .status()
            .unwrap();
        assert!(exists.success());

        let out = Command::new("/bin/sh")
            .env("SHELL", &shell)
            .args(["-c", &run_script(), "devnest", "fake-agent", "a b"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "agent-ran a b");

        let missing = Command::new("/bin/sh")
            .env("SHELL", &shell)
            .args(["-c", &check_script(), "devnest", "nope-not-here"])
            .status()
            .unwrap();
        assert!(!missing.success());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

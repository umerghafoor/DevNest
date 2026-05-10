use parking_lot::Mutex;
use serde::Serialize;
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use crate::devices::{AuthType, Device};
use crate::error::{AppError, AppResult};
use crate::secrets;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub struct SshSession {
    session: Session,
}

impl SshSession {
    pub fn connect(device: &Device) -> AppResult<Self> {
        let addr = format!("{}:{}", device.host, device.port);
        let tcp = TcpStream::connect_timeout(&addr.to_socket_addrs_one()?, Duration::from_secs(8))
            .map_err(|e| AppError::Ssh(format!("connect {addr}: {e}")))?;
        tcp.set_read_timeout(Some(Duration::from_secs(30))).ok();
        tcp.set_write_timeout(Some(Duration::from_secs(30))).ok();

        let mut session = Session::new().map_err(|e| AppError::Ssh(e.to_string()))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| AppError::Ssh(format!("handshake: {e}")))?;

        match device.auth_type {
            AuthType::Key => {
                let key_path: PathBuf = device
                    .key_path
                    .clone()
                    .ok_or_else(|| AppError::Invalid("key_path missing".into()))?
                    .into();
                let passphrase = secrets::get(&device.id).ok();
                session
                    .userauth_pubkey_file(&device.username, None, &key_path, passphrase.as_deref())
                    .map_err(|e| AppError::Ssh(format!("pubkey auth: {e}")))?;
            }
            AuthType::Password => {
                let pw = secrets::get(&device.id)
                    .map_err(|e| AppError::Ssh(format!("no stored password: {e}")))?;
                session
                    .userauth_password(&device.username, &pw)
                    .map_err(|e| AppError::Ssh(format!("password auth: {e}")))?;
            }
            AuthType::Localhost => {
                return Err(AppError::Invalid("localhost devices do not use SSH".into()));
            }
        }

        if !session.authenticated() {
            return Err(AppError::Ssh("authentication failed".into()));
        }

        Ok(Self { session })
    }

    pub fn run_with_stdin(&mut self, cmd: &str, stdin: Option<&str>) -> AppResult<CommandOutput> {
        let mut channel = self
            .session
            .channel_session()
            .map_err(|e| AppError::Ssh(format!("channel: {e}")))?;
        channel
            .exec(cmd)
            .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

        if let Some(input) = stdin {
            channel
                .write_all(input.as_bytes())
                .map_err(|e| AppError::Ssh(format!("write stdin: {e}")))?;
            channel
                .send_eof()
                .map_err(|e| AppError::Ssh(format!("send eof: {e}")))?;
        }

        let mut stdout = String::new();
        channel
            .read_to_string(&mut stdout)
            .map_err(|e| AppError::Ssh(format!("read stdout: {e}")))?;

        let mut stderr = String::new();
        channel
            .stderr()
            .read_to_string(&mut stderr)
            .map_err(|e| AppError::Ssh(format!("read stderr: {e}")))?;

        channel
            .wait_close()
            .map_err(|e| AppError::Ssh(format!("wait_close: {e}")))?;
        let exit_code = channel
            .exit_status()
            .map_err(|e| AppError::Ssh(format!("exit_status: {e}")))?;

        Ok(CommandOutput {
            stdout,
            stderr,
            exit_code,
        })
    }

    pub fn alive(&self) -> bool {
        self.session.authenticated()
    }
}

trait SocketAddrExt {
    fn to_socket_addrs_one(&self) -> AppResult<std::net::SocketAddr>;
}

impl SocketAddrExt for str {
    fn to_socket_addrs_one(&self) -> AppResult<std::net::SocketAddr> {
        use std::net::ToSocketAddrs;
        self.to_socket_addrs()
            .map_err(|e| AppError::Ssh(format!("resolve {self}: {e}")))?
            .next()
            .ok_or_else(|| AppError::Ssh(format!("no address for {self}")))
    }
}

impl SocketAddrExt for String {
    fn to_socket_addrs_one(&self) -> AppResult<std::net::SocketAddr> {
        self.as_str().to_socket_addrs_one()
    }
}

#[derive(Default)]
pub struct SessionPool {
    inner: Mutex<HashMap<String, Arc<Mutex<SshSession>>>>,
}

impl SessionPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn connect(&self, device: &Device) -> AppResult<()> {
        let session = SshSession::connect(device)?;
        let mut g = self.inner.lock();
        g.insert(device.id.clone(), Arc::new(Mutex::new(session)));
        Ok(())
    }

    pub fn disconnect(&self, id: &str) {
        self.inner.lock().remove(id);
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.inner
            .lock()
            .get(id)
            .map(|s| s.lock().alive())
            .unwrap_or(false)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Mutex<SshSession>>> {
        self.inner.lock().get(id).cloned()
    }
}

/// Run a shell command on a device. For localhost devices this shells out
/// locally with `sh -c`; for remote devices it uses the pooled SSH session.
///
/// When `device.use_sudo` is true, the command is wrapped with
/// `sudo -S -p '' sh -c '<cmd>'` and the sudo password is read from the
/// keychain and piped to stdin. If no sudo password is stored, this returns
/// `AppError::SudoPasswordRequired` so the frontend can prompt and retry.
pub fn run_command(pool: &SessionPool, device: &Device, cmd: &str) -> AppResult<CommandOutput> {
    let raw = if let Some(prefix) = device.sudo_prefix.as_deref() {
        format!("{prefix} {cmd}")
    } else {
        cmd.to_string()
    };

    let (final_cmd, stdin) = if device.use_sudo {
        let pw = secrets::get_sudo(&device.id)?
            .ok_or_else(|| AppError::SudoPasswordRequired(device.id.clone()))?;
        // sudo reads the password from stdin (via -S) followed by a newline.
        // We wrap the original command in `sh -c` and quote it safely so
        // shell metacharacters (pipes, redirects) work as written. The
        // password is piped *only* on stdin; sudo consumes one line and the
        // rest of stdin is forwarded to the wrapped process.
        let escaped = shell_single_quote(&raw);
        let wrapped = format!("sudo -S -p '' sh -c {escaped}");
        (wrapped, Some(format!("{pw}\n")))
    } else {
        (raw, None)
    };

    let out = if device.is_localhost {
        run_local(&final_cmd, stdin.as_deref())?
    } else {
        let sess = pool
            .get(&device.id)
            .ok_or_else(|| AppError::Ssh("device not connected".into()))?;
        let mut guard = sess.lock();
        guard.run_with_stdin(&final_cmd, stdin.as_deref())?
    };

    if device.use_sudo && is_sudo_auth_failure(&out) {
        // Stored password was rejected — clear it so the next call prompts.
        secrets::delete_sudo(&device.id).ok();
        return Err(AppError::SudoPasswordRequired(device.id.clone()));
    }
    Ok(out)
}

fn run_local(cmd: &str, stdin: Option<&str>) -> AppResult<CommandOutput> {
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Ssh(format!("local exec: {e}")))?;

    if let Some(input) = stdin {
        if let Some(mut c_stdin) = child.stdin.take() {
            c_stdin
                .write_all(input.as_bytes())
                .map_err(|e| AppError::Ssh(format!("local stdin: {e}")))?;
        }
    }

    let out = child
        .wait_with_output()
        .map_err(|e| AppError::Ssh(format!("local wait: {e}")))?;

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        exit_code: out.status.code().unwrap_or(-1),
    })
}

/// Wrap a string in POSIX-safe single quotes. `'` becomes `'\''`.
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn is_sudo_auth_failure(out: &CommandOutput) -> bool {
    // `sudo -S` exits with 1 and writes one of these to stderr when the
    // password is wrong or missing. Different distros vary slightly.
    let s = out.stderr.to_lowercase();
    out.exit_code != 0
        && (s.contains("incorrect password")
            || s.contains("sorry, try again")
            || s.contains("a password is required")
            || s.contains("3 incorrect password attempts"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_simple() {
        assert_eq!(shell_single_quote("docker ps"), "'docker ps'");
    }

    #[test]
    fn quotes_with_apostrophe() {
        assert_eq!(shell_single_quote("a'b"), "'a'\\''b'");
    }
}

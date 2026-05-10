use parking_lot::Mutex;
use serde::Serialize;
use ssh2::Session;
use std::collections::HashMap;
use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
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
        let tcp = TcpStream::connect_timeout(
            &addr.to_socket_addrs_one()?,
            Duration::from_secs(8),
        )
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
                    .userauth_pubkey_file(
                        &device.username,
                        None,
                        &key_path,
                        passphrase.as_deref(),
                    )
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
                return Err(AppError::Invalid(
                    "localhost devices do not use SSH".into(),
                ));
            }
        }

        if !session.authenticated() {
            return Err(AppError::Ssh("authentication failed".into()));
        }

        Ok(Self { session })
    }

    pub fn run(&mut self, cmd: &str) -> AppResult<CommandOutput> {
        let mut channel = self
            .session
            .channel_session()
            .map_err(|e| AppError::Ssh(format!("channel: {e}")))?;
        channel
            .exec(cmd)
            .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

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
pub fn run_command(
    pool: &SessionPool,
    device: &Device,
    cmd: &str,
) -> AppResult<CommandOutput> {
    let cmd = if let Some(prefix) = device.sudo_prefix.as_deref() {
        format!("{prefix} {cmd}")
    } else {
        cmd.to_string()
    };

    if device.is_localhost {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .map_err(|e| AppError::Ssh(format!("local exec: {e}")))?;
        return Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            exit_code: out.status.code().unwrap_or(-1),
        });
    }

    let sess = pool
        .get(&device.id)
        .ok_or_else(|| AppError::Ssh("device not connected".into()))?;
    let mut guard = sess.lock();
    guard.run(&cmd)
}

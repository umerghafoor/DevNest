use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;

use crate::devices::{AuthType, Device};
use crate::error::{AppError, AppResult};
use crate::secrets;

pub enum TermInput {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// Handle to a running terminal. Cheap to clone, backed by an Arc.
#[derive(Clone)]
pub struct TermHandle {
    pub tx: mpsc::SyncSender<TermInput>,
}

impl TermHandle {
    pub fn write(&self, data: Vec<u8>) -> AppResult<()> {
        self.tx
            .send(TermInput::Data(data))
            .map_err(|_| AppError::Ssh("terminal closed".into()))
    }

    pub fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.tx
            .send(TermInput::Resize(cols, rows))
            .map_err(|_| AppError::Ssh("terminal closed".into()))
    }

    pub fn close(&self) {
        let _ = self.tx.send(TermInput::Close);
    }
}

/// Spawn a local PTY shell. Returns a handle (for input) and starts a thread
/// that reads output and calls `on_output` for each chunk.
pub fn spawn_local<F>(cols: u32, rows: u32, on_output: F) -> AppResult<TermHandle>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    use portable_pty::{native_pty_system, PtySize};

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Ssh(format!("openpty: {e}")))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = portable_pty::CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    pair.slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Ssh(format!("spawn shell: {e}")))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Ssh(format!("clone reader: {e}")))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Ssh(format!("take writer: {e}")))?;
    let master = pair.master;

    let (tx, rx) = mpsc::sync_channel::<TermInput>(256);

    // Read thread
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => on_output(buf[..n].to_vec()),
            }
        }
    });

    // Write/control thread
    std::thread::spawn(move || {
        for msg in rx {
            match msg {
                TermInput::Data(data) => {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                }
                TermInput::Resize(cols, rows) => {
                    let _ = master.resize(portable_pty::PtySize {
                        rows: rows as u16,
                        cols: cols as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                TermInput::Close => break,
            }
        }
    });

    Ok(TermHandle { tx })
}

/// Parameters needed to open an SSH connection, fully owned so they can be
/// sent across thread boundaries (ssh2::Session is not Send).
struct RemoteParams {
    host: String,
    port: u16,
    username: String,
    auth_type: AuthType,
    key_path: Option<String>,
    passphrase: Option<String>,
}

/// Spawn a remote SSH shell. The entire SSH session + channel is created
/// inside the worker thread because ssh2::Session is not Send.
pub fn spawn_remote<F>(device: &Device, cols: u32, rows: u32, on_output: F) -> AppResult<TermHandle>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    let params = RemoteParams {
        host: device.host.clone(),
        port: device.port,
        username: device.username.clone(),
        auth_type: device.auth_type,
        key_path: device.key_path.clone(),
        passphrase: secrets::get(&device.id).ok(),
    };

    let (tx, rx) = mpsc::sync_channel::<TermInput>(256);

    // Return an error channel so the thread can report connection failures.
    let (err_tx, err_rx) = mpsc::channel::<Option<AppError>>();

    std::thread::spawn(move || {
        // Build session inside the thread — ssh2::Session is !Send.
        let session = match open_ssh_session(&params, cols, rows) {
            Ok(s) => {
                let _ = err_tx.send(None); // signal success
                s
            }
            Err(e) => {
                let _ = err_tx.send(Some(e));
                return;
            }
        };

        // channel_session + pty + shell
        let mut channel = match session.channel_session() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("terminal channel_session: {e}");
                return;
            }
        };
        if let Err(e) = channel.request_pty("xterm-256color", None, Some((cols, rows, 0, 0))) {
            tracing::error!("terminal request_pty: {e}");
            return;
        }
        if let Err(e) = channel.shell() {
            tracing::error!("terminal shell: {e}");
            return;
        }

        session.set_blocking(false);

        let mut buf = [0u8; 4096];
        loop {
            // Drain pending input
            loop {
                match rx.try_recv() {
                    Ok(TermInput::Data(data)) => {
                        if channel.write_all(&data).is_err() {
                            return;
                        }
                    }
                    Ok(TermInput::Resize(c, r)) => {
                        let _ = channel.request_pty_size(c, r, None, None);
                    }
                    Ok(TermInput::Close) => return,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            }

            match channel.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => on_output(buf[..n].to_vec()),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(_) => break,
            }

            if channel.eof() {
                break;
            }
        }
    });

    // Wait for connection result (up to 15s — same as connect timeout + handshake).
    match err_rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(None) => Ok(TermHandle { tx }),
        Ok(Some(e)) => Err(e),
        Err(_) => Err(AppError::Ssh("terminal connect timed out".into())),
    }
}

fn open_ssh_session(params: &RemoteParams, _cols: u32, _rows: u32) -> AppResult<ssh2::Session> {
    use std::net::TcpStream;
    use std::net::ToSocketAddrs;
    use std::time::Duration;

    let addr = format!("{}:{}", params.host, params.port);
    let sock_addr = addr
        .to_socket_addrs()
        .map_err(|e| AppError::Ssh(format!("resolve {addr}: {e}")))?
        .next()
        .ok_or_else(|| AppError::Ssh(format!("no address for {addr}")))?;

    let tcp = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(8))
        .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;
    tcp.set_read_timeout(Some(Duration::from_secs(3600))).ok();

    let mut session = ssh2::Session::new().map_err(|e| AppError::Ssh(e.to_string()))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| AppError::Ssh(format!("handshake: {e}")))?;

    match params.auth_type {
        AuthType::Key => {
            let key_path: std::path::PathBuf = params
                .key_path
                .clone()
                .ok_or_else(|| AppError::Invalid("key_path missing".into()))?
                .into();
            session
                .userauth_pubkey_file(
                    &params.username,
                    None,
                    &key_path,
                    params.passphrase.as_deref(),
                )
                .map_err(|e| AppError::Ssh(format!("pubkey auth: {e}")))?;
        }
        AuthType::Password => {
            let pw = params
                .passphrase
                .as_deref()
                .ok_or_else(|| AppError::Ssh("no stored password".into()))?;
            session
                .userauth_password(&params.username, pw)
                .map_err(|e| AppError::Ssh(format!("password auth: {e}")))?;
        }
        AuthType::Localhost => {
            return Err(AppError::Invalid("localhost uses local PTY".into()));
        }
    }

    if !session.authenticated() {
        return Err(AppError::Ssh("auth failed".into()));
    }

    Ok(session)
}

// ── Pool ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct TerminalPool {
    inner: Mutex<HashMap<String, TermHandle>>,
}

impl TerminalPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, id: String, handle: TermHandle) {
        self.inner.lock().insert(id, handle);
    }

    pub fn get(&self, id: &str) -> Option<TermHandle> {
        self.inner.lock().get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        if let Some(h) = self.inner.lock().remove(id) {
            h.close();
        }
    }
}

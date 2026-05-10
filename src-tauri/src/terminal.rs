use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;

use crate::devices::Device;
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

/// Spawn a remote SSH shell. Returns a handle (for input) and starts threads
/// that pump stdin/stdout through the SSH channel.
pub fn spawn_remote<F>(device: &Device, cols: u32, rows: u32, on_output: F) -> AppResult<TermHandle>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("{}:{}", device.host, device.port);
    let tcp = TcpStream::connect_timeout(&resolve_addr(&addr)?, Duration::from_secs(8))
        .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;
    tcp.set_read_timeout(Some(Duration::from_secs(3600))).ok();

    let mut session = ssh2::Session::new().map_err(|e| AppError::Ssh(e.to_string()))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| AppError::Ssh(format!("handshake: {e}")))?;

    match device.auth_type {
        crate::devices::AuthType::Key => {
            let key_path: std::path::PathBuf = device
                .key_path
                .clone()
                .ok_or_else(|| AppError::Invalid("key_path missing".into()))?
                .into();
            let pass = secrets::get(&device.id).ok();
            session
                .userauth_pubkey_file(&device.username, None, &key_path, pass.as_deref())
                .map_err(|e| AppError::Ssh(format!("pubkey auth: {e}")))?;
        }
        crate::devices::AuthType::Password => {
            let pw =
                secrets::get(&device.id).map_err(|e| AppError::Ssh(format!("no password: {e}")))?;
            session
                .userauth_password(&device.username, &pw)
                .map_err(|e| AppError::Ssh(format!("password auth: {e}")))?;
        }
        crate::devices::AuthType::Localhost => {
            return Err(AppError::Invalid("localhost uses local PTY".into()));
        }
    }

    if !session.authenticated() {
        return Err(AppError::Ssh("auth failed".into()));
    }

    let mut channel = session
        .channel_session()
        .map_err(|e| AppError::Ssh(format!("channel: {e}")))?;
    channel
        .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
        .map_err(|e| AppError::Ssh(format!("request pty: {e}")))?;
    channel
        .shell()
        .map_err(|e| AppError::Ssh(format!("shell: {e}")))?;

    let (tx, rx) = mpsc::sync_channel::<TermInput>(256);

    // Single thread owns both session + channel (session must outlive channel).
    session.set_blocking(true);
    std::thread::spawn(move || {
        // Keep session alive in this thread — channel borrows from it.
        let _session = session;
        let mut buf = [0u8; 4096];
        loop {
            // Drain any pending input first (non-blocking check)
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

            // Read with a short timeout so we can process pending writes.
            match channel.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => on_output(buf[..n].to_vec()),
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
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

    Ok(TermHandle { tx })
}

fn resolve_addr(addr: &str) -> AppResult<std::net::SocketAddr> {
    use std::net::ToSocketAddrs;
    addr.to_socket_addrs()
        .map_err(|e| AppError::Ssh(format!("resolve {addr}: {e}")))?
        .next()
        .ok_or_else(|| AppError::Ssh(format!("no addr for {addr}")))
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

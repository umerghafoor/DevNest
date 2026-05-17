use parking_lot::Mutex;
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::devices::{AuthType, Device};
use crate::error::{AppError, AppResult};
use crate::secrets;

/// Active SSH local-port forwards. Keyed by a tunnel id chosen by the caller.
#[derive(Default)]
pub struct TunnelPool {
    inner: Mutex<HashMap<String, Tunnel>>,
}

struct Tunnel {
    stop: Arc<AtomicBool>,
}

impl TunnelPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open an SSH local-port forward through the given device. Returns the
    /// local 127.0.0.1 port the caller should connect to. The tunnel runs on
    /// background threads and lives until `close()` is called or the device
    /// session dies.
    pub fn open(
        &self,
        id: &str,
        device: &Device,
        remote_host: String,
        remote_port: u16,
    ) -> AppResult<u16> {
        if self.inner.lock().contains_key(id) {
            return Err(AppError::Invalid(format!("tunnel {id} already open")));
        }

        // Dedicated SSH session for the tunnel so it doesn't contend with the
        // device's main session (which serves command execution).
        let session = open_session(device)?;
        let session = Arc::new(Mutex::new(session));

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| AppError::Ssh(format!("tunnel bind: {e}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| AppError::Ssh(format!("tunnel addr: {e}")))?
            .port();
        listener
            .set_nonblocking(false)
            .map_err(|e| AppError::Ssh(format!("tunnel nonblock: {e}")))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let id_str = id.to_string();

        thread::spawn(move || {
            // Use a short accept timeout so we can poll the stop flag.
            listener
                .set_nonblocking(true)
                .expect("set tunnel listener nonblocking");
            loop {
                if stop_for_thread.load(Ordering::Relaxed) {
                    break;
                }
                match listener.accept() {
                    Ok((sock, _)) => {
                        let sess = session.clone();
                        let stop = stop_for_thread.clone();
                        let remote_host = remote_host.clone();
                        thread::spawn(move || {
                            if let Err(e) =
                                bridge(sess, sock, &remote_host, remote_port, stop)
                            {
                                tracing::warn!("tunnel bridge ended: {e}");
                            }
                        });
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => {
                        tracing::warn!("tunnel {id_str} accept error: {e}");
                        break;
                    }
                }
            }
            tracing::info!("tunnel {id_str} listener stopped");
        });

        self.inner.lock().insert(
            id.to_string(),
            Tunnel { stop: stop.clone() },
        );
        Ok(local_port)
    }

    pub fn close(&self, id: &str) {
        if let Some(t) = self.inner.lock().remove(id) {
            t.stop.store(true, Ordering::Relaxed);
        }
    }
}

fn open_session(device: &Device) -> AppResult<Session> {
    use std::net::ToSocketAddrs;
    let addr = format!("{}:{}", device.host, device.port);
    let sock_addr = addr
        .to_socket_addrs()
        .map_err(|e| AppError::Ssh(format!("resolve {addr}: {e}")))?
        .next()
        .ok_or_else(|| AppError::Ssh(format!("no address for {addr}")))?;
    let tcp = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(8))
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
            let key_path = device
                .key_path
                .clone()
                .ok_or_else(|| AppError::Invalid("key_path missing".into()))?;
            let passphrase = secrets::get(&device.id).ok();
            session
                .userauth_pubkey_file(
                    &device.username,
                    None,
                    std::path::Path::new(&key_path),
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
                "localhost devices do not need SSH tunnels".into(),
            ));
        }
    }

    if !session.authenticated() {
        return Err(AppError::Ssh("tunnel authentication failed".into()));
    }
    Ok(session)
}

/// Bridge bytes between a local accepted TCP socket and a remote
/// direct-tcpip channel on the SSH session.
fn bridge(
    session: Arc<Mutex<Session>>,
    mut sock: TcpStream,
    remote_host: &str,
    remote_port: u16,
    stop: Arc<AtomicBool>,
) -> AppResult<()> {
    // Opening a channel requires holding the session lock briefly. Once we
    // have the channel we keep it in non-blocking mode and poll it.
    let mut channel = {
        let guard = session.lock();
        guard.set_blocking(true);
        guard
            .channel_direct_tcpip(remote_host, remote_port, None)
            .map_err(|e| AppError::Ssh(format!("direct-tcpip: {e}")))?
    };

    sock.set_nonblocking(true)
        .map_err(|e| AppError::Ssh(format!("sock nonblock: {e}")))?;
    {
        let guard = session.lock();
        guard.set_blocking(false);
    }

    let mut buf_to_remote = [0u8; 32 * 1024];
    let mut buf_to_local = [0u8; 32 * 1024];

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let mut did_work = false;

        // local -> remote
        match sock.read(&mut buf_to_remote) {
            Ok(0) => {
                let _ = channel.send_eof();
                break;
            }
            Ok(n) => {
                let mut written = 0;
                while written < n {
                    match channel.write(&buf_to_remote[written..n]) {
                        Ok(w) => {
                            written += w;
                            did_work = true;
                        }
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => return Err(AppError::Ssh(format!("ch write: {e}"))),
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(AppError::Ssh(format!("sock read: {e}"))),
        }

        // remote -> local
        match channel.read(&mut buf_to_local) {
            Ok(0) => {
                if channel.eof() {
                    break;
                }
            }
            Ok(n) => {
                sock.write_all(&buf_to_local[..n])
                    .map_err(|e| AppError::Ssh(format!("sock write: {e}")))?;
                did_work = true;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // EAGAIN — non-blocking channel had no data ready.
            }
            Err(e) => return Err(AppError::Ssh(format!("ch read: {e}"))),
        }

        if !did_work {
            thread::sleep(Duration::from_millis(5));
        }
    }

    let _ = channel.close();
    Ok(())
}

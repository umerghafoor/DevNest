//! SSH-over-WebRTC transport.
//!
//! `ssh2` (libssh2) does the socket I/O itself through a **real OS file
//! descriptor** — `set_tcp_stream` requires `AsRawFd`/`AsRawSocket`, and
//! libssh2 never calls a Rust `Read`/`Write` we provide. So we cannot hand it a
//! virtual DataChannel stream directly.
//!
//! Instead we bridge with a **loopback TCP socket pair**:
//!
//! ```text
//!   ssh2  ──►  TcpStream A  ⇄ (127.0.0.1) ⇄  TcpStream B  ──►  pump ⇄ DataChannel ──► device sshd
//! ```
//!
//! [`connect`] creates the pair, hands **end A** back to the caller (who gives
//! it to `ssh2::set_tcp_stream` — a genuine fd, so libssh2 is satisfied), and
//! spawns a Tokio runtime that owns the `RTCPeerConnection` and copies bytes
//! between **end B** and the `ssh:<tag>` DataChannel. As far as ssh2 knows it's
//! talking to an ordinary socket; the bytes actually ride WebRTC.
//!
//! All of `ssh.rs` / `terminal.rs` / `sftp.rs` stay unchanged — only how the
//! `TcpStream` is created differs.
//!
//! Signaling (SDP offer/answer + ICE) is abstracted in [`signaling`]; adapt it
//! to the signaling server you already run for HTTP/WS. The device side bridges
//! the `ssh:` DataChannel to its local `127.0.0.1:22` — see
//! `docs/codebase/ssh-over-webrtc.md`.

use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;

use crate::devices::WebRtcConfig;
use crate::error::{AppError, AppResult};

pub mod signaling;

/// How long to wait for the DataChannel to open before giving up.
/// Generous timeout: ICE + TURN allocation + DataChannel open can take 10-15s.
const OPEN_TIMEOUT: Duration = Duration::from_secs(60);
/// Stop pulling from the loopback socket while the channel has more than this
/// many bytes buffered, so a flood of SSH output can't balloon memory.
const SEND_HIGH_WATER: usize = 1024 * 1024;

/// Build the `RTCIceServer` list from config, sanitizing as we go:
/// - trim whitespace and drop blank URLs (a stray textarea line shouldn't kill
///   the whole connection);
/// - reject a URL whose scheme isn't stun/stuns/turn/turns with a message that
///   names the offending URL (webrtc-rs's own error is just "unknown scheme
///   type" with no context);
/// - skip an entry entirely if it has no usable URLs left.
fn build_ice_servers(cfg: &WebRtcConfig) -> AppResult<Vec<RTCIceServer>> {
    let mut out = Vec::new();
    for s in &cfg.ice_servers {
        let urls: Vec<String> = s
            .urls
            .iter()
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .collect();
        for u in &urls {
            let scheme = u.split(':').next().unwrap_or("");
            if !matches!(scheme, "stun" | "stuns" | "turn" | "turns") {
                return Err(AppError::Invalid(format!(
                    "ICE server URL {u:?} has an unsupported scheme — must start with \
                     stun:, stuns:, turn:, or turns: (no // and no spaces)"
                )));
            }
        }
        if urls.is_empty() {
            continue;
        }
        out.push(RTCIceServer {
            urls,
            username: s.username.clone().unwrap_or_default(),
            credential: s.credential.clone().unwrap_or_default(),
            ..Default::default()
        });
    }
    Ok(out)
}

/// Handle returned to the caller. Holds the `ssh2`-facing `TcpStream` (end A)
/// plus ownership of the WebRTC runtime thread; dropping it tears the
/// connection down. Get the stream with [`WebRtcConn::stream`].
pub struct WebRtcConn {
    stream: TcpStream,
    _runtime: RuntimeHandle,
}

impl WebRtcConn {
    /// The `TcpStream` to hand to `ssh2::Session::set_tcp_stream`. The runtime
    /// handle is kept alive inside `WebRtcConn`, so keep the `WebRtcConn`
    /// around for the session's lifetime (e.g. move it into the worker thread).
    pub fn stream(&self) -> &TcpStream {
        &self.stream
    }
}

/// Owns the Tokio runtime thread. When dropped, the runtime shuts down and the
/// peer connection (moved onto it) is closed.
struct RuntimeHandle {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Drop for RuntimeHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Establish a WebRTC DataChannel to the device agent and return a real
/// `TcpStream` (loopback) wired to it, ready for `ssh2`. Blocks until the
/// channel is open or [`OPEN_TIMEOUT`] elapses.
///
/// `session_tag` is folded into the channel label (`<prefix>:<tag>`) so the
/// agent — and your logs — can tell sessions apart.
pub fn connect(cfg: &WebRtcConfig, session_tag: &str) -> AppResult<WebRtcConn> {
    // Loopback pair: A is returned to ssh2, B is owned by the pump task.
    let (stream_a, stream_b) = loopback_pair()?;
    // The pump task runs on Tokio, so it needs the std socket in nonblocking
    // mode to convert into a tokio TcpStream.
    stream_b
        .set_nonblocking(true)
        .map_err(|e| AppError::Ssh(format!("set_nonblocking: {e}")))?;

    let (open_tx, open_rx) = std::sync::mpsc::channel::<AppResult<()>>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let cfg = cfg.clone();
    let label = format!("{}:{}", cfg.channel_label, session_tag);

    let join = std::thread::Builder::new()
        .name("webrtc-ssh".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = open_tx.send(Err(AppError::Ssh(format!("tokio runtime: {e}"))));
                    return;
                }
            };
            rt.block_on(async move {
                if let Err(e) = run_peer(cfg, label, stream_b, &open_tx, shutdown_rx).await {
                    let _ = open_tx.send(Err(e));
                }
            });
        })
        .map_err(|e| AppError::Ssh(format!("spawn webrtc thread: {e}")))?;

    match open_rx.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(AppError::Ssh("webrtc connect timed out".into())),
    }

    Ok(WebRtcConn {
        stream: stream_a,
        _runtime: RuntimeHandle {
            shutdown: Some(shutdown_tx),
            join: Some(join),
        },
    })
}

/// Create a connected pair of loopback TCP sockets. Returns `(A, B)` where both
/// are fully connected to each other over `127.0.0.1`. Cross-platform (unlike
/// Unix `socketpair`), and both ends are real `AsRawFd`/`AsRawSocket` sockets.
fn loopback_pair() -> AppResult<(TcpStream, TcpStream)> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::Ssh(format!("loopback bind: {e}")))?;
    let addr = listener
        .local_addr()
        .map_err(|e| AppError::Ssh(format!("loopback addr: {e}")))?;

    // Connect end A to the listener; accept end B.
    let a =
        TcpStream::connect(addr).map_err(|e| AppError::Ssh(format!("loopback connect: {e}")))?;
    let (b, _) = listener
        .accept()
        .map_err(|e| AppError::Ssh(format!("loopback accept: {e}")))?;
    a.set_nodelay(true).ok();
    b.set_nodelay(true).ok();
    Ok((a, b))
}

/// Build the peer connection, open the data channel, run signaling, and pump
/// bytes between the loopback socket (`stream_b`) and the channel until
/// shutdown. Runs entirely on the runtime thread.
async fn run_peer(
    cfg: WebRtcConfig,
    label: String,
    stream_b: TcpStream,
    open_tx: &std::sync::mpsc::Sender<AppResult<()>>,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) -> AppResult<()> {
    let api = {
        let mut m = MediaEngine::default();
        m.register_default_codecs()
            .map_err(|e| AppError::Ssh(format!("register codecs: {e}")))?;
        let registry = register_default_interceptors(Registry::new(), &mut m)
            .map_err(|e| AppError::Ssh(format!("interceptors: {e}")))?;
        APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .build()
    };

    let ice_servers = build_ice_servers(&cfg)?;

    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers,
            ..Default::default()
        })
        .await
        .map_err(|e| AppError::Ssh(format!("new peer connection: {e}")))?,
    );

    // Reliable, ordered channel — SSH requires a lossless ordered byte stream.
    let dc = pc
        .create_data_channel(
            &label,
            Some(RTCDataChannelInit {
                ordered: Some(true),
                ..Default::default()
            }),
        )
        .await
        .map_err(|e| AppError::Ssh(format!("create data channel: {e}")))?;

    // Inbound (DataChannel -> loopback socket): the on_message callback feeds a
    // channel that the socket-writer half of the pump drains.
    let (inbound_tx, inbound_rx) = mpsc::channel::<Bytes>(256);
    wire_data_channel(&dc, inbound_tx, open_tx.clone());

    // Signaling: create offer, exchange SDP + ICE with the server.
    signaling::negotiate(&pc, &cfg)
        .await
        .map_err(|e| AppError::Ssh(format!("signaling: {e}")))?;

    // Convert the loopback socket to tokio and run the bidirectional pump.
    let tokio_sock = tokio::net::TcpStream::from_std(stream_b)
        .map_err(|e| AppError::Ssh(format!("loopback to tokio: {e}")))?;

    pump(tokio_sock, dc.clone(), inbound_rx, shutdown_rx).await;

    let _ = pc.close().await;
    Ok(())
}

/// Copy bytes both ways between the loopback socket and the DataChannel until
/// either side closes or shutdown is requested.
async fn pump(
    sock: tokio::net::TcpStream,
    dc: Arc<RTCDataChannel>,
    mut inbound_rx: mpsc::Receiver<Bytes>,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let (mut sock_rd, mut sock_wr) = sock.into_split();

    // socket -> DataChannel (outbound SSH bytes)
    let dc_out = dc.clone();
    let outbound = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match sock_rd.read(&mut buf).await {
                Ok(0) | Err(_) => break, // ssh2 closed its end
                Ok(n) => {
                    // Backpressure: let the channel drain before sending more.
                    while dc_out.buffered_amount().await > SEND_HIGH_WATER {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    if dc_out
                        .send(&Bytes::copy_from_slice(&buf[..n]))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    // DataChannel -> socket (inbound SSH bytes)
    let inbound = tokio::spawn(async move {
        while let Some(bytes) = inbound_rx.recv().await {
            if sock_wr.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = sock_wr.shutdown().await;
    });

    // Whichever finishes first (or shutdown) ends the session; abort the rest.
    tokio::select! {
        _ = outbound => {}
        _ = inbound => {}
        _ = &mut shutdown_rx => {}
    }
}

/// Attach on_open / on_message / on_close handlers. `on_message` forwards bytes
/// to the inbound channel; `on_open` unblocks the `connect` caller.
fn wire_data_channel(
    dc: &Arc<RTCDataChannel>,
    inbound_tx: mpsc::Sender<Bytes>,
    open_tx: std::sync::mpsc::Sender<AppResult<()>>,
) {
    let open_once = Arc::new(std::sync::Mutex::new(Some(open_tx)));

    let open_signal = open_once.clone();
    dc.on_open(Box::new(move || {
        if let Some(tx) = open_signal.lock().unwrap().take() {
            let _ = tx.send(Ok(()));
        }
        Box::pin(async {})
    }));

    let tx_msg = inbound_tx.clone();
    dc.on_message(Box::new(move |msg| {
        let tx = tx_msg.clone();
        Box::pin(async move {
            // If the pump's receiver is gone the session is over; drop quietly.
            let _ = tx.send(msg.data).await;
        })
    }));

    dc.on_error(Box::new(move |e| {
        tracing::debug!("webrtc dc error: {e}");
        Box::pin(async {})
    }));
}

//! WebSocket ↔ TCP bridge used by the VNC panel.
//!
//! noVNC speaks raw RFB inside WebSocket binary frames. We can't open a raw
//! TCP socket from a browser, so we run a tiny localhost-only WS server per
//! VNC connection that proxies bytes through to the actual VNC server.
//!
//! Lifecycle:
//!   1. Frontend calls `vnc_open(profile)` → returns `ws://127.0.0.1:<port>/`.
//!   2. noVNC connects there with a binary WebSocket.
//!   3. We open a TCP stream to `target_host:target_port` and bridge.
//!   4. On disconnect (either side), the WS server tears down.
//!   5. Frontend calls `vnc_close(id)` to stop the listener.
//!
//! When the connection should tunnel through SSH, the caller composes by
//! first opening an `ssh_tunnel` and pointing this proxy at the resulting
//! local forwarded port.

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct WsProxyPool {
    inner: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl WsProxyPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a localhost-only WebSocket server that bridges any accepted
    /// connection to a TCP socket on `target_host:target_port`. Returns the
    /// local port the frontend should connect to.
    ///
    /// `id` is the caller's key (typically the VNC profile id). Re-using an
    /// id closes the previous proxy first.
    pub async fn open(
        &self,
        id: String,
        target_host: String,
        target_port: u16,
    ) -> AppResult<u16> {
        self.close(&id);

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| AppError::Ssh(format!("ws proxy bind: {e}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| AppError::Ssh(format!("ws proxy addr: {e}")))?
            .port();

        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let id_for_thread = id.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => {
                        tracing::info!("ws-proxy {id_for_thread} stopped");
                        break;
                    }
                    accept = listener.accept() => {
                        match accept {
                            Ok((sock, _)) => {
                                let host = target_host.clone();
                                let port = target_port;
                                tokio::spawn(async move {
                                    if let Err(e) = handle_connection(sock, host, port).await {
                                        tracing::warn!("ws-proxy connection ended: {e}");
                                    }
                                });
                            }
                            Err(e) => {
                                tracing::warn!("ws-proxy accept error: {e}");
                                break;
                            }
                        }
                    }
                }
            }
        });

        self.inner.lock().insert(id, stop_tx);
        Ok(local_port)
    }

    pub fn close(&self, id: &str) {
        if let Some(tx) = self.inner.lock().remove(id) {
            let _ = tx.send(());
        }
    }
}

async fn handle_connection(
    sock: TcpStream,
    target_host: String,
    target_port: u16,
) -> AppResult<()> {
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;

    let peer = sock
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "?".into());
    tracing::info!("ws-proxy: accepted ws connection from {peer}, target {target_host}:{target_port}");

    // Accept the WebSocket handshake.
    let ws = tokio_tungstenite::accept_async(sock).await.map_err(|e| {
        tracing::warn!("ws-proxy: handshake failed from {peer}: {e}");
        AppError::Ssh(format!("ws handshake: {e}"))
    })?;
    tracing::info!("ws-proxy: handshake ok from {peer}");
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Open the backend TCP connection to the actual VNC server. If this
    // fails (typical case: VNC server not running, bound to localhost
    // only, blocked by firewall) we send the reason back through the WS
    // close frame so noVNC's `disconnect` event surfaces it in detail.reason,
    // which the frontend already shows in the panel's error banner.
    let backend = match TcpStream::connect((target_host.as_str(), target_port)).await {
        Ok(b) => {
            tracing::info!(
                "ws-proxy: backend tcp connect ok to {target_host}:{target_port}"
            );
            b
        }
        Err(e) => {
            let reason = format!("VNC connect {target_host}:{target_port}: {e}");
            tracing::warn!("{reason}");
            let _ = ws_tx
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Error,
                    reason: reason.clone().into(),
                })))
                .await;
            let _ = ws_tx.close().await;
            return Err(AppError::Ssh(reason));
        }
    };
    backend
        .set_nodelay(true)
        .map_err(|e| AppError::Ssh(format!("set_nodelay: {e}")))?;
    let (mut backend_rx, mut backend_tx) = backend.into_split();

    // backend → ws (TCP bytes → WebSocket binary frames)
    let to_ws = tokio::spawn(async move {
        let mut buf = vec![0u8; 32 * 1024];
        let mut total = 0usize;
        loop {
            match backend_rx.read(&mut buf).await {
                Ok(0) => {
                    tracing::info!("ws-proxy: backend EOF after {total} bytes");
                    break;
                }
                Ok(n) => {
                    total += n;
                    if let Err(e) = ws_tx
                        .send(Message::Binary(buf[..n].to_vec().into()))
                        .await
                    {
                        tracing::warn!(
                            "ws-proxy: ws send failed after {total} bytes: {e}"
                        );
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!("ws-proxy: backend read error after {total} bytes: {e}");
                    break;
                }
            }
        }
        let _ = ws_tx.close().await;
    });

    // ws → backend (WebSocket frames → TCP bytes). Ignore Text/Ping/Pong
    // wrappers we don't care about; close on disconnect.
    let to_backend = tokio::spawn(async move {
        let mut total = 0usize;
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    total += data.len();
                    if let Err(e) = backend_tx.write_all(&data).await {
                        tracing::warn!(
                            "ws-proxy: backend write failed after {total} bytes: {e}"
                        );
                        break;
                    }
                }
                Ok(Message::Close(frame)) => {
                    tracing::info!(
                        "ws-proxy: ws closed by client after {total} bytes: {:?}",
                        frame
                    );
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("ws-proxy: ws recv error after {total} bytes: {e}");
                    break;
                }
            }
        }
        let _ = backend_tx.shutdown().await;
    });

    let _ = tokio::join!(to_ws, to_backend);
    tracing::info!("ws-proxy: connection done {target_host}:{target_port}");
    Ok(())
}

//! WebRTC signaling — matched to the BeetleOps/P2P gateway protocol.
//!
//! DevDash is the **client** (offerer); the device agent is the **answerer**.
//! Over a WebSocket (`cfg.signaling_url`) we speak this JSON protocol:
//!
//! ```text
//!   Client → Server: { "type":"register", "device_id":"<client_id>", "secret":"<secret>" }
//!   Server → Client: { "type":"registered" }
//!   Client → Server: { "type":"offer",  "to":"<peer_id>",  "sdp":"...", "sdp_type":"offer" }
//!   Server → Client: { "type":"answer", "from":"<peer_id>", "sdp":"...", "sdp_type":"answer" }
//!   Client → Server: { "type":"ice",    "to":"<peer_id>",   "candidate":{...} }
//!   Server → Client: { "type":"ice",    "from":"<peer_id>",  "candidate":{...} }
//!   Server → Client: { "type":"disconnect", "from":"<peer_id>" }
//! ```
//!
//! `peer_id` is the **target device** (`cfg.peer_id`, your `P2P_DEVICE_ID` such
//! as `edge-device-2`). We register as `cfg.client_id` (or a random
//! `devdash-<uuid>`), present `cfg.secret`, and route to the device via `to`.
//!
//! If your server's framing differs, edit the [`SignalMsg`] enum and
//! [`negotiate`] — nothing outside this file changes.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

/// Parse an ICE candidate from the signaling server's message.
/// The device (Python aioice) sends `"candidate"` as an object with separate
/// fields; the WebRTC spec / browser sends it as a SDP candidate string.
/// We handle both by inspecting the raw value.
fn parse_ice_candidate(raw: &serde_json::Value) -> Option<RTCIceCandidateInit> {
    match raw.get("candidate") {
        // Already a string — standard browser/webrtc-rs format.
        Some(serde_json::Value::String(s)) => Some(RTCIceCandidateInit {
            candidate: s.clone(),
            sdp_mid: raw
                .get("sdpMid")
                .or_else(|| raw.get("sdp_mid"))
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            sdp_mline_index: raw
                .get("sdpMLineIndex")
                .or_else(|| raw.get("sdp_mline_index"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u16),
            ..Default::default()
        }),
        // Object with fields — aioice format. Build the SDP candidate string.
        Some(serde_json::Value::Object(obj)) => {
            // aioice sends: {"component":1,"foundation":"...","ip":"...",
            //   "port":N,"priority":N,"protocol":"udp","type":"host",...}
            // We reconstruct the `candidate:` SDP attribute line.
            let foundation = obj.get("foundation")?.as_str()?;
            let component = obj.get("component")?.as_u64().unwrap_or(1);
            let protocol = obj.get("protocol")?.as_str()?;
            let priority = obj.get("priority")?.as_u64().unwrap_or(0);
            let ip = obj.get("ip")?.as_str()?;
            let port = obj.get("port")?.as_u64()?;
            let type_ = obj.get("type")?.as_str()?;
            let candidate = format!(
                "candidate:{foundation} {component} {protocol} {priority} {ip} {port} typ {type_}"
            );
            // Optional raddr/rport for relay/srflx candidates.
            let candidate = if let (Some(raddr), Some(rport)) =
                (obj.get("relatedAddress"), obj.get("relatedPort"))
            {
                if let (Some(ra), Some(rp)) = (raddr.as_str(), rport.as_u64()) {
                    format!("{candidate} raddr {ra} rport {rp}")
                } else {
                    candidate
                }
            } else {
                candidate
            };
            Some(RTCIceCandidateInit {
                candidate,
                sdp_mid: Some("0".to_owned()),
                ..Default::default()
            })
        }
        _ => {
            tracing::debug!("signaling: unrecognized ICE candidate format: {raw}");
            None
        }
    }
}

use crate::devices::WebRtcConfig;

type SignalResult<T> = Result<T, String>;

/// Inbound messages we care about from the server. Unknown types are ignored.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Inbound {
    Registered,
    Answer {
        #[allow(dead_code)]
        #[serde(default)]
        from: Option<String>,
        sdp: String,
    },
    Ice {
        #[allow(dead_code)]
        #[serde(default)]
        from: Option<String>,
        /// Raw value — may be a SDP string or an aioice object. Parsed by
        /// `parse_ice_candidate`.
        candidate: serde_json::Value,
    },
    Disconnect {
        #[allow(dead_code)]
        #[serde(default)]
        from: Option<String>,
    },
    Error {
        message: String,
    },
    /// Catch-all so deserialization never fails on unknown types.
    #[serde(other)]
    Other,
}

/// Outbound `register`. Offers and ICE are built with `json!` since they carry
/// the `to` routing field + `sdp_type`.
#[derive(Debug, Serialize)]
struct Register<'a> {
    r#type: &'static str,
    device_id: &'a str,
    secret: &'a str,
}

/// Run the client-side handshake: register, offer, apply the answer, trickle
/// ICE. Returns once the answer is applied; remaining ICE is drained in a
/// detached task until the socket closes.
pub async fn negotiate(pc: &Arc<RTCPeerConnection>, cfg: &WebRtcConfig) -> SignalResult<()> {
    let ws = connect_following_redirects(&cfg.signaling_url).await?;
    let (sink, mut stream) = ws.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));

    let client_id = cfg
        .client_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("devdash-{}", uuid::Uuid::new_v4()));
    let peer_id = cfg.peer_id.clone();
    let secret = cfg.secret.clone().unwrap_or_default();

    // 1. Register with the server (device_id = our client id + shared secret).
    let reg_msg = serde_json::to_string(&Register {
        r#type: "register",
        device_id: &client_id,
        secret: &secret,
    })
    .map_err(|e| format!("encode register: {e}"))?;
    tracing::debug!("signaling tx: {reg_msg}");
    send_text(&sink, &reg_msg).await?;

    // Trickle our local ICE candidates to the device (routed via `to`).
    let ice_sink = sink.clone();
    let ice_peer = peer_id.clone();
    pc.on_ice_candidate(Box::new(move |cand| {
        let ice_sink = ice_sink.clone();
        let ice_peer = ice_peer.clone();
        Box::pin(async move {
            if let Some(c) = cand {
                if let Ok(init) = c.to_json() {
                    let msg = json!({ "type": "ice", "to": ice_peer, "candidate": init });
                    let _ = send_text(&ice_sink, &msg.to_string()).await;
                }
            }
        })
    }));

    // 2. Wait for `registered`, then send the offer. We block on registration
    //    so the server has us routed before the offer arrives.
    wait_for_registered(&mut stream).await?;

    let offer = pc
        .create_offer(None)
        .await
        .map_err(|e| format!("create offer: {e}"))?;
    pc.set_local_description(offer.clone())
        .await
        .map_err(|e| format!("set local desc: {e}"))?;
    let offer_msg = json!({
        "type": "offer",
        "device_id": peer_id,
        "sdp": offer.sdp,
        "sdp_type": "offer",
    });
    tracing::debug!("signaling tx offer to={peer_id}");
    send_text(&sink, &offer_msg.to_string()).await?;

    // 3. Read until we've applied the answer; apply any ICE that arrives.
    let mut answered = false;
    while let Some(item) = stream.next().await {
        let text = match item {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        tracing::debug!("signaling rx: {text}");
        match serde_json::from_str::<Inbound>(&text) {
            Ok(Inbound::Answer { sdp, .. }) => {
                tracing::debug!("signaling: applying answer");
                let answer =
                    RTCSessionDescription::answer(sdp).map_err(|e| format!("parse answer: {e}"))?;
                pc.set_remote_description(answer)
                    .await
                    .map_err(|e| format!("set remote desc: {e}"))?;
                tracing::debug!("signaling: answer applied, waiting for DataChannel open");
                answered = true;
            }
            Ok(Inbound::Ice { candidate, .. }) => {
                tracing::debug!("signaling: ICE candidate raw: {candidate}");
                if let Some(init) = parse_ice_candidate(&candidate) {
                    tracing::debug!("signaling: adding remote ICE candidate: {}", init.candidate);
                    if let Err(e) = pc.add_ice_candidate(init).await {
                        tracing::debug!("add remote ice: {e}");
                    }
                }
            }
            Ok(Inbound::Disconnect { .. }) => {
                return Err("device disconnected during signaling".into());
            }
            Ok(Inbound::Error { message }) => {
                return Err(format!("signaling server: {message}"));
            }
            Ok(_) => {}
            Err(e) => tracing::debug!("signaling: unrecognized message: {e}"),
        }
        if answered {
            spawn_ice_drainer(pc.clone(), stream);
            return Ok(());
        }
    }

    if answered {
        Ok(())
    } else {
        Err("signaling closed before answer".into())
    }
}

/// Block until the server confirms `registered` (or errors/closes).
async fn wait_for_registered<S>(stream: &mut S) -> SignalResult<()>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(item) = stream.next().await {
        let text = match item {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        tracing::debug!("signaling rx: {text}");
        match serde_json::from_str::<Inbound>(&text) {
            Ok(Inbound::Registered) => return Ok(()),
            Ok(Inbound::Disconnect { .. }) => return Err("disconnected before register".into()),
            _ => {} // ignore anything else until registered
        }
    }
    Err("signaling closed before register confirmation".into())
}

/// Keep applying remote ICE after `negotiate` returns, until the socket closes.
fn spawn_ice_drainer<S>(pc: Arc<RTCPeerConnection>, mut stream: S)
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin
        + Send
        + 'static,
{
    tokio::spawn(async move {
        while let Some(item) = stream.next().await {
            let text = match item {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => continue,
            };
            if let Ok(Inbound::Ice { candidate, .. }) = serde_json::from_str::<Inbound>(&text) {
                if let Some(init) = parse_ice_candidate(&candidate) {
                    let _ = pc.add_ice_candidate(init).await;
                }
            }
        }
    });
}

// ── small helpers ───────────────────────────────────────────────────────────

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

type WsSink = futures_util::stream::SplitSink<WsStream, Message>;

/// Connect to the signaling WebSocket. If the server returns a 3xx redirect
/// (e.g. Render/Cloudflare forcing ws:// → wss://) we upgrade the scheme and
/// retry once, so both `ws://` and `wss://` URLs work transparently.
async fn connect_following_redirects(url: &str) -> SignalResult<WsStream> {
    match tokio_tungstenite::connect_async(url).await {
        Ok((ws, _)) => Ok(ws),
        Err(tokio_tungstenite::tungstenite::Error::Http(ref resp))
            if resp.status().is_redirection() =>
        {
            // Upgrade scheme: ws → wss (the only redirect this server sends).
            let upgraded = url
                .strip_prefix("ws://")
                .map(|rest| format!("wss://{rest}"))
                .unwrap_or_else(|| url.to_string());
            tracing::debug!("signaling: {url} → {upgraded} (redirect)");
            tokio_tungstenite::connect_async(&upgraded)
                .await
                .map(|(ws, _)| ws)
                .map_err(|e| format!("connect {upgraded}: {e}"))
        }
        Err(e) => Err(format!("connect {url}: {e}")),
    }
}

async fn send_text(sink: &Arc<tokio::sync::Mutex<WsSink>>, text: &str) -> SignalResult<()> {
    sink.lock()
        .await
        .send(Message::Text(text.into()))
        .await
        .map_err(|e| format!("ws send: {e}"))
}

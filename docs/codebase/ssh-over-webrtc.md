# SSH over WebRTC

How DevDash reaches a remote shell when the device is **only** reachable
over an existing WebRTC link (the same peer connection you already use
for HTTP I/O and WebSockets), instead of a routable `host:port`.

The remote device already runs `sshd`. We do **not** tunnel SSH through
the public internet or open port 22 to the world. Instead we carry the
raw SSH byte stream over a WebRTC **DataChannel** to the device, where a
small forwarder hands it to the local `sshd` on `127.0.0.1:22`.

```text
DevDash (Tauri/Rust)                         Remote device
┌─────────────────────────────┐            ┌──────────────────────────┐
│ ssh2::Session (UNCHANGED)   │            │  WebRTC agent            │
│   set_tcp_stream(loopback A) │            │                          │
│        │                    │            │                          │
│   loopback B ⇄ pump  ◄──────┼────────────┼─ DataChannel "ssh:<id>"  │
│        │            WebRTC   │  DataChannel│      │  (NEW handler)   │
│        ▼                    │            │      ▼                   │
│  ssh.rs / terminal.rs       │            │  TCP 127.0.0.1:22        │
│  (auth, PTY, SFTP — reused) │            │      │                   │
└─────────────────────────────┘            │      ▼                   │
                                           │    sshd ──► your shell   │
                                           └──────────────────────────┘
```

The key insight — with one important caveat. `ssh2` (libssh2) does the
socket I/O **itself** through a real OS file descriptor:
`Session::set_tcp_stream` requires `AsRawFd`/`AsRawSocket`, and libssh2
never calls a Rust `Read`/`Write` you provide. So you **cannot** hand it
a virtual DataChannel-backed stream directly.

We bridge with a **loopback TCP socket pair** instead:

```text
ssh2 ─► TcpStream A ⇄ 127.0.0.1 ⇄ TcpStream B ─► pump ⇄ DataChannel ─► device sshd
```

`ssh2` gets end A (a genuine fd, so libssh2 is happy); a Tokio task owns
the peer connection and copies bytes between end B and the `ssh:`
DataChannel. As far as `ssh2` knows it's talking to an ordinary socket.
This keeps **all** of [`ssh.rs`](../../src-tauri/src/ssh.rs),
[`terminal.rs`](../../src-tauri/src/terminal.rs),
[`sftp.rs`](../../src-tauri/src/sftp.rs) and
[`ssh_tunnel.rs`](../../src-tauri/src/ssh_tunnel.rs) intact — the only
thing that changes is how the underlying `TcpStream` is created. The
implementation lives in
[`webrtc_transport.rs`](../../src-tauri/src/webrtc_transport.rs).

---

## What the remote device needs

| Requirement                          | Why                                                             |
| ------------------------------------ | --------------------------------------------------------------- |
| `sshd` running and reachable locally | Terminates SSH (auth, PTY, SFTP). `ssh 127.0.0.1` must succeed. |
| Your existing WebRTC agent           | Owns the peer connection + signaling you already built.         |
| **One new DataChannel handler**      | Pipes a `ssh:*` channel raw to `127.0.0.1:22`. See below.       |

You do **not** need a new daemon, a new open port, or a second auth
system. The new code is a forwarder, not a server.

### Confirm sshd is reachable from the agent

Run this **on the remote device**:

```bash
systemctl is-active sshd 2>/dev/null || systemctl is-active ssh
ss -tlnp | grep ':22'                 # sshd should be LISTEN on 127.0.0.1:22 (or 0.0.0.0:22)
ssh -o StrictHostKeyChecking=accept-new $USER@127.0.0.1 true && echo "local ssh OK"
```

If `sshd` is not installed:

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y openssh-server
sudo systemctl enable --now ssh

# Fedora/RHEL
sudo dnf install -y openssh-server
sudo systemctl enable --now sshd
```

You can keep `sshd` bound to loopback only (`ListenAddress 127.0.0.1`)
since the only thing that ever connects to it is the local forwarder —
the WebRTC link is your network exposure, not port 22.

---

## Adding the forwarder to your EXISTING agent

Your agent today is HTTP/WS-aware: it parses those protocols. SSH is a
raw byte stream, so the SSH forwarder is actually **simpler** than your
HTTP handler — it does no parsing. It just copies bytes both directions.

The integration is the same regardless of language:

1. **Pick a channel naming convention.** When DevDash wants an SSH
   session it opens (or requests, via your signaling) a DataChannel
   whose label starts with `ssh:` — e.g. `ssh:<sessionId>`. Your agent
   already routes channels by label/path for HTTP vs WS; add one branch.

2. **On a `ssh:` channel, open a TCP socket to `127.0.0.1:22`.**

3. **Pipe both ways, with no interpretation:**
   - DataChannel `message` → `socket.write(bytes)`
   - socket `data` → `dataChannel.send(bytes)`
   - either side closing → close the other.

4. **Respect backpressure** (the one real gotcha — see
   [Flow control](#flow-control-the-one-real-gotcha)).

### Node.js (`wrtc` / `werift` / `node-datachannel`)

If your agent dispatches incoming DataChannels by `channel.label`, add a
branch:

```js
import net from "node:net";

// Where you already handle incoming data channels:
peer.ondatachannel = (event) => {
  const ch = event.channel;

  if (ch.label === "http" || ch.label.startsWith("ws:")) {
    handleExistingChannel(ch); // your current logic
    return;
  }

  if (ch.label.startsWith("ssh:")) {
    bridgeSsh(ch); // NEW
    return;
  }
};

function bridgeSsh(ch) {
  ch.binaryType = "arraybuffer";
  const sock = net.connect(22, "127.0.0.1");

  // Backpressure: stop reading the socket when the channel buffer is full.
  ch.bufferedAmountLowThreshold = 256 * 1024; // 256 KiB
  const HIGH_WATER = 1 * 1024 * 1024; // 1 MiB

  sock.on("data", (buf) => {
    ch.send(buf);
    if (ch.bufferedAmount > HIGH_WATER) sock.pause();
  });
  ch.onbufferedamountlow = () => sock.resume();

  ch.onmessage = (e) => {
    const ok = sock.write(Buffer.from(e.data));
    if (!ok) {
      // socket buffer full: stop pulling from the channel until it drains
      // (DataChannel has no pause(); rely on the peer's own backpressure)
    }
  };

  const close = () => {
    try {
      sock.destroy();
    } catch {}
    try {
      ch.close();
    } catch {}
  };
  sock.on("error", close);
  sock.on("close", close);
  ch.onclose = close;
  ch.onerror = close;
}
```

That is the entire device-side addition. No SSH library, no PTY, no auth
— `sshd` does all of it.

### Go (Pion)

```go
import (
    "io"
    "net"
    "strings"
    "github.com/pion/webrtc/v4"
)

peer.OnDataChannel(func(dc *webrtc.DataChannel) {
    if !strings.HasPrefix(dc.Label(), "ssh:") {
        handleExistingChannel(dc) // your current logic
        return
    }

    dc.OnOpen(func() {
        sock, err := net.Dial("tcp", "127.0.0.1:22")
        if err != nil {
            dc.Close()
            return
        }
        // Detach gives an io.ReadWriteCloser, so we can use io.Copy and let
        // Pion handle SCTP backpressure for us.
        raw, err := dc.Detach()
        if err != nil {
            sock.Close()
            return
        }
        go func() { io.Copy(sock, raw); sock.Close() }()
        go func() { io.Copy(raw, sock); raw.Close() }()
    })
})
```

> Pion note: call `s := webrtc.SettingEngine{}; s.DetachDataChannels()`
> when you build the API, so `dc.Detach()` works.

### Python (aiortc)

```python
import asyncio

@peer.on("datachannel")
def on_datachannel(channel):
    if not channel.label.startswith("ssh:"):
        handle_existing_channel(channel)   # your current logic
        return

    reader_writer = {}

    @channel.on("open")
    async def on_open():
        reader, writer = await asyncio.open_connection("127.0.0.1", 22)
        reader_writer["r"], reader_writer["w"] = reader, writer

        async def pump_socket_to_channel():
            try:
                while True:
                    data = await reader.read(32 * 1024)
                    if not data:
                        break
                    channel.send(data)
            finally:
                channel.close()

        asyncio.ensure_future(pump_socket_to_channel())

    @channel.on("message")
    def on_message(message):
        w = reader_writer.get("w")
        if w:
            w.write(message)

    @channel.on("close")
    def on_close():
        w = reader_writer.get("w")
        if w:
            w.close()
```

---

## If you're starting the agent from scratch

If you don't yet have an agent and want a minimal standalone one whose
_only_ job is SSH-over-WebRTC, it's the same forwarder plus a peer +
signaling. Reuse whatever signaling transport you already run (the
WebSocket signaling server you use for HTTP/WS). A from-scratch Node
agent is roughly:

```js
import { RTCPeerConnection } from "wrtc"; // or node-datachannel/werift
import net from "node:net";

// 1. Build the peer with your ICE servers (the STUN/TURN you provide).
const peer = new RTCPeerConnection({
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:turn.example.com:3478", username: "u", credential: "p" },
  ],
});

// 2. Bridge any ssh:* data channel to local sshd (same bridgeSsh as above).
peer.ondatachannel = (e) => {
  if (e.channel.label.startsWith("ssh:")) bridgeSsh(e.channel);
};

// 3. Signaling: receive offer, set remote, create answer, trickle ICE —
//    over your existing signaling channel. (Same code you already wrote
//    for HTTP/WS; nothing SSH-specific here.)
```

The point: signaling and the peer lifecycle are **identical** to what
you already do. SSH adds exactly one thing — the `bridgeSsh` forwarder.

---

## The DevDash (Rust) side

Implemented in [`webrtc_transport.rs`](../../src-tauri/src/webrtc_transport.rs)
(+ [`webrtc_transport/signaling.rs`](../../src-tauri/src/webrtc_transport/signaling.rs)).
Documented here so both halves live together.

Because libssh2 needs a real fd (see the top of this doc), the transport
is a **loopback TCP socket pair**, not a fake stream. `connect()`:

1. Creates a connected pair of `127.0.0.1` sockets (`loopback_pair`).
   End **A** goes to `ssh2`; end **B** is owned by the runtime.
2. Spawns a current-thread Tokio runtime that builds the
   `RTCPeerConnection` from the device's `WebRtcConfig` (STUN/TURN), opens
   a `ssh:<deviceId>` DataChannel, and runs [signaling](#signaling).
3. Once the channel is open, `tokio` pumps bytes both ways between end B
   and the DataChannel (with `bufferedAmount` backpressure).
4. Returns a [`WebRtcConn`] holding end A plus the runtime handle.

```rust
// webrtc_transport.rs
pub struct WebRtcConn {
    stream: TcpStream,      // end A — hand stream() to ssh2::set_tcp_stream
    _runtime: RuntimeHandle // owns the peer connection; drop = teardown
}

pub fn connect(cfg: &WebRtcConfig, session_tag: &str) -> AppResult<WebRtcConn>;
```

`terminal.rs::open_ssh_session` branches on `device.transport`:

```rust
match params.transport {
    Transport::Tcp    => { /* existing TcpStream::connect_timeout path */ }
    Transport::Webrtc => {
        let conn = webrtc_transport::connect(cfg, &params.session_tag)?;
        session.set_tcp_stream(conn.stream().try_clone()?); // a REAL fd
        webrtc_guard = Some(conn); // keep the runtime alive for the session
    }
}
session.handshake()?;
authenticate(&session, params)?; // identical key/password block for both
```

The returned `WebRtcConn` is held in the terminal worker thread for the
session's lifetime; when the pane closes and the thread ends, the conn
drops, which shuts down the runtime and closes the peer connection.

Everything downstream — `request_pty`, `shell`, resize, read/write — is
unchanged because it operates on the `Session`, not the transport.

The same `transport` branch is wired into the other two SSH entry points,
so a WebRTC device works everywhere:

- [`ssh.rs`](../../src-tauri/src/ssh.rs) `SshSession::connect` — the
  Connect button, status/`ALIVE` badge, and every command path
  (Docker, metrics, systemd, …). `SshSession` holds the `WebRtcConn` in
  a `_webrtc` field for the session's life.
- [`sftp.rs`](../../src-tauri/src/sftp.rs) `open_sftp` — the file
  browser. Returns an `SftpConn` (derefs to `ssh2::Sftp`) that bundles
  the guard.

> **SFTP caveat:** `open_sftp` opens a fresh connection per call, so each
> file-browser operation runs a full WebRTC peer + signaling handshake
> (seconds), versus a millisecond TCP connect. Fine for occasional use;
> pool the connection if it becomes a pain. `ssh_tunnel.rs` (SQL
> port-forwards) is still TCP-only.

### Signaling

`signaling::negotiate` is the piece matched to **your** signaling server.
It's wired to the BeetleOps / P2P gateway protocol: JSON over a WebSocket,
with DevDash as the **client/offerer** and the device as the **answerer**.

| Step | Direction       | Message                                                                |
| ---- | --------------- | ---------------------------------------------------------------------- |
| 1    | client → server | `{"type":"register","device_id":"<clientId>","secret":"<sec>"}`        |
| 2    | server → client | `{"type":"registered"}`                                                |
| 3    | client → server | `{"type":"offer","device_id":"<peerId>","sdp":"…","sdp_type":"offer"}` |
| 4    | server → client | `{"type":"answer","from":"<peerId>","sdp":"…"}`                        |
| 5    | both            | `{"type":"ice","device_id":"…","candidate":{…}}` (trickle)             |

`peerId` is the **target device** (the agent's `P2P_DEVICE_ID`, e.g.
`edge-device-2`); `clientId` is who DevDash registers as (random
`devdash-<uuid>` if left blank); `secret` is the agent's
`P2P_DEVICE_SECRET`. If your server's framing changes, edit the `Inbound`
enum and `negotiate()` in `signaling.rs` — nothing outside that file
changes.

### Configuring a WebRTC device

A device uses this transport when its `transport` column is `"webrtc"`
and `webrtc_config` holds the JSON config. The config shape
([`WebRtcConfig`](../../src-tauri/src/devices.rs)) maps directly to your
agent's env vars:

```jsonc
{
  // ws:// works — we follow the 301 redirect that hosts like Render/Cloudflare
  // use to push to HTTPS, so ws:// is auto-upgraded to wss://. wss:// is fine too.
  "signalingUrl": "ws://p2p-server-01kd.onrender.com/ws", // P2P_SIGNALING_URL — must match agent
  "peerId": "edge-device-2", // target agent's P2P_DEVICE_ID
  "secret": "test-secret-local", // P2P_DEVICE_SECRET
  "clientId": "devdash-laptop", // optional; blank = random devdash-<uuid>
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302"] }, // P2P_STUN_SERVERS
    {
      "urls": ["turn:turn.beetleops.com:3478"], // P2P_TURN_URL
      "username": "edge-user", // P2P_TURN_USERNAME
      "credential": "StrongPasswordHere", // P2P_TURN_CREDENTIAL
    },
  ],
  "channelLabel": "ssh", // optional; default "ssh"
}
```

`host`/`port`/`username`/`authType`/`keyPath` are still used: the
`username` plus key/password authenticate to the device's `sshd` exactly
as for a TCP device (DevDash reads the secret from the keychain via
[`secrets.rs`](../../src-tauri/src/secrets.rs)). Only `host`/`port` are
ignored at the transport layer — the agent bridges to its own
`127.0.0.1:22`.

---

## Flow control (the one real gotcha)

A DataChannel is not an infinite pipe. A burst of SSH output (`cat` a big
file, `journalctl`, `top` redrawing) can outrun the channel and either
balloon memory or get dropped on an unreliable channel.

- **Use a reliable, ordered DataChannel** (the default — do _not_ set
  `maxRetransmits`/`maxPacketLifeTime`). SSH assumes a reliable, ordered
  byte stream; an unreliable channel will corrupt the SSH session.
- **Honor `bufferedAmount`.** When the channel's buffered bytes exceed a
  high-water mark, stop reading from the TCP socket until
  `onbufferedamountlow` fires (shown in the Node sample). Pion's
  `Detach()` + `io.Copy` gets you SCTP backpressure for free.
- **Forward terminal resize** out-of-band (a small JSON control message
  on a separate channel, or via DevDash's existing `terminal.resize`
  path) — don't try to multiplex it into the raw SSH byte stream.

---

## Security notes

- **The WebRTC link is the trust boundary.** Anyone who can open a
  `ssh:` DataChannel to the agent can reach `127.0.0.1:22`. Gate channel
  creation behind the same authn/authz your HTTP/WS channels already use
  — don't blindly bridge every `ssh:` channel from any peer.
- **Keep sshd's own auth.** You still authenticate to `sshd` with the
  device's key/password (DevDash already manages these via
  [`secrets.rs`](../../src-tauri/src/secrets.rs)). The WebRTC layer is
  transport, not a replacement for SSH auth. Defense in depth.
- **Bind sshd to loopback** (`ListenAddress 127.0.0.1`) so port 22 is
  never exposed on any real interface — the forwarder is the only client.
- **TURN credentials are sensitive.** The STUN/TURN config you provide
  carries relay credentials; store them the same way DevDash stores other
  device secrets, not in plaintext config.

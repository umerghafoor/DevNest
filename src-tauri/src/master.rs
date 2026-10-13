/// Master agent: DevNest's own MCP server for the host device.
///
/// The Master panel runs an ordinary ACP agent (Claude Code, …) and hands it
/// this server in `session/new`'s `mcpServers`. The server listens on
/// 127.0.0.1 with a random bearer token and speaks MCP over streamable HTTP
/// (plain JSON responses). Agents that only do stdio MCP get the bridge
/// instead: this same executable started with `--mcp-bridge` (see `bridge`).
///
/// Tools act on the host by default, or on any DevNest device by name
/// (over SSH). Read-only tools run straight away;
/// anything that changes the machine emits `master:approval` and blocks until
/// the user answers in the panel (`master_resolve`), so the gate holds no
/// matter which permission mode the agent itself is in. `show_widget` emits
/// `master:widget`; the panel renders a live widget in the transcript.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::devices::{self, Device};
use crate::error::{AppError, AppResult};
use crate::ssh::{self, shell_single_quote as q, CommandOutput};
use crate::state::AppState;
use crate::{docker, local_fs, sftp, tailscale};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT: usize = 30_000;
const MAX_BODY: usize = 8 * 1024 * 1024;
pub const BRIDGE_FLAG: &str = "--mcp-bridge";
pub const ENV_URL: &str = "DEVNEST_MCP_URL";
pub const ENV_TOKEN: &str = "DEVNEST_MCP_TOKEN";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub url: String,
    pub token: String,
    /// Stdio bridge for agents without HTTP MCP support.
    pub bridge_command: String,
    pub bridge_args: Vec<String>,
}

#[derive(Default)]
pub struct MasterHub {
    endpoint: Mutex<Option<Endpoint>>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<bool>>>>,
}

impl MasterHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start the server once; later calls return the same endpoint.
    fn start(&self, app: AppHandle) -> AppResult<Endpoint> {
        let mut guard = self.endpoint.lock();
        if let Some(ep) = guard.as_ref() {
            return Ok(ep.clone());
        }
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let exe = std::env::current_exe()?;
        let ep = Endpoint {
            url: format!("http://127.0.0.1:{port}/mcp"),
            token: token.clone(),
            bridge_command: exe.to_string_lossy().into_owned(),
            bridge_args: vec![BRIDGE_FLAG.into()],
        };
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                let token = token.clone();
                thread::spawn(move || {
                    if let Err(e) = serve(stream, &token, |m| handle(&app, m)) {
                        tracing::debug!("master mcp connection: {e}");
                    }
                });
            }
        });
        *guard = Some(ep.clone());
        Ok(ep)
    }

    fn ask(
        &self,
        app: &AppHandle,
        tool: &str,
        device: &str,
        title: String,
        detail: String,
    ) -> bool {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id.clone(), tx);
        let _ = app.emit(
            "master:approval",
            json!({ "id": id, "tool": tool, "device": device, "title": title, "detail": detail }),
        );
        let ok = rx.recv_timeout(APPROVAL_TIMEOUT).unwrap_or(false);
        self.pending.lock().remove(&id);
        ok
    }

    fn resolve(&self, id: &str, allow: bool) {
        if let Some(tx) = self.pending.lock().remove(id) {
            let _ = tx.send(allow);
        }
    }

    fn deny_all(&self) {
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(false);
        }
    }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

/// One request per connection (`Connection: close`) — enough for loopback.
fn serve(
    stream: TcpStream,
    token: &str,
    handle: impl Fn(Value) -> Option<Value>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut out = stream;

    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let authorized = headers
        .get("authorization")
        .map(|v| v == &format!("Bearer {token}"))
        .unwrap_or(false);
    if !authorized {
        return respond(&mut out, 401, "Unauthorized", None);
    }
    if path.split('?').next() != Some("/mcp") {
        return respond(&mut out, 404, "Not Found", None);
    }
    match method.as_str() {
        "POST" => {}
        // No server-initiated stream; session teardown is a no-op.
        "DELETE" => return respond(&mut out, 200, "OK", None),
        _ => return respond(&mut out, 405, "Method Not Allowed", None),
    }

    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return respond(&mut out, 413, "Payload Too Large", None);
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            let err = rpc_error(Value::Null, -32700, &format!("parse error: {e}"));
            return respond(&mut out, 400, "Bad Request", Some(&err));
        }
    };

    let reply = match msg {
        Value::Array(batch) => {
            let replies: Vec<Value> = batch.into_iter().filter_map(&handle).collect();
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        m => handle(m),
    };
    match reply {
        Some(v) => respond(&mut out, 200, "OK", Some(&v)),
        None => respond(&mut out, 202, "Accepted", None),
    }
}

fn respond(
    out: &mut TcpStream,
    code: u16,
    reason: &str,
    body: Option<&Value>,
) -> std::io::Result<()> {
    let body = body.map(|v| v.to_string()).unwrap_or_default();
    let ctype = if body.is_empty() {
        ""
    } else {
        "Content-Type: application/json\r\n"
    };
    write!(
        out,
        "HTTP/1.1 {code} {reason}\r\n{ctype}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    out.flush()
}

// ─── MCP ──────────────────────────────────────────────────────────────────────

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Reply to one JSON-RPC message; None for notifications.
fn handle(app: &AppHandle, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-03-26");
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "devnest", "version": env!("CARGO_PKG_VERSION") },
                "instructions": instructions(app),
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_defs() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(app, name, &args) {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            }
        }
        _ => {
            return Some(rpc_error(
                id,
                -32601,
                &format!("method not found: {method}"),
            ))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn instructions(app: &AppHandle) -> String {
    let host = run_host("hostname", Duration::from_secs(5))
        .map(|o| o.stdout.trim().to_string())
        .unwrap_or_default();
    let user = std::env::var("USER").unwrap_or_default();
    let home = dirs::home_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let devices = all_devices(app)
        .map(|ds| {
            ds.iter()
                .map(|d| {
                    if d.is_localhost {
                        format!("- \"{}\" (this computer, the default)", d.name)
                    } else {
                        format!("- \"{}\" ({}@{}, over SSH)", d.name, d.username, d.host)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    format!(
        "You are DevNest's Master agent. You run on the user's own computer (the host): \
hostname {host}, {os}/{arch}, user {user}, home {home}. You are not working in a project \
folder: you help the user inspect and operate their machines.\n\
\n\
Devices in DevNest (call list_devices for the current list):\n{devices}\n\
Every devnest tool takes an optional `device` (a device name from that list). Leave it out \
for the host. When the user names another machine, ALWAYS pass it as `device`; never show \
or report the host's data for a device the user asked about. If you can't tell which device \
they mean, call list_devices and ask.\n\
\n\
- Read-only tools (list_devices, host_info, system_stats, list_processes, listening_ports, \
list_directory, read_file, tailscale_status, docker_containers) run immediately.\n\
- Tools that change a machine (run_command, write_file, kill_process, \
tailscale_set_exit_node, docker_action) pause until the user approves them in DevNest. \
Always fill in `reason` with one plain sentence. If the user denies, do not retry the same \
action another way; ask what they want instead. Prefer these over any built-in shell or edit \
tool you have, so every change goes through DevNest's approval.\n\
- When the user wants to see or watch something (system load, processes, Tailscale, Docker), \
call show_widget with the right `device`: it shows a live widget in the chat, so don't repeat \
its numbers unless asked.\n\
Commands run non-interactively with a {timeout}s timeout and no TTY: never start editors, \
pagers or anything that waits for input; sudo cannot prompt for a password.",
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        timeout = COMMAND_TIMEOUT.as_secs(),
    )
}

/// Adds the optional `device` argument to a tool's input schema.
fn with_device(mut schema: Value) -> Value {
    schema["properties"]["device"] = json!({
        "type": "string",
        "description": "Device name from list_devices. Omit for the host (this computer)."
    });
    schema
}

fn tool_defs() -> Value {
    let reason = json!({ "type": "string", "description": "One sentence shown to the user explaining why." });
    let empty = || json!({ "type": "object", "properties": {} });
    let mut tools = json!([
        { "name": "host_info", "description": "OS, hostname, user, CPU, memory and uptime of a device.", "inputSchema": empty() },
        { "name": "system_stats", "description": "Current CPU %, memory, load, disk and network totals of a device.", "inputSchema": empty() },
        { "name": "list_processes", "description": "Top processes on a device.", "inputSchema": {
            "type": "object", "properties": {
                "sort": { "type": "string", "enum": ["cpu", "memory"] },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 } } } },
        { "name": "listening_ports", "description": "TCP ports listening on a device and the process behind each.", "inputSchema": empty() },
        { "name": "list_directory", "description": "List a directory on a device.", "inputSchema": {
            "type": "object", "properties": { "path": { "type": "string", "description": "Absolute path, or ~/..." } }, "required": ["path"] } },
        { "name": "read_file", "description": "Read a text file on a device (truncated to max_bytes).", "inputSchema": {
            "type": "object", "properties": {
                "path": { "type": "string" },
                "max_bytes": { "type": "integer", "minimum": 1 } }, "required": ["path"] } },
        { "name": "tailscale_status", "description": "Tailscale status of a device: self, peers, exit node.", "inputSchema": empty() },
        { "name": "docker_containers", "description": "Docker containers on a device.", "inputSchema": empty() },
        { "name": "run_command", "description": "Run a shell command on a device (user approval required). Non-interactive, login shell, 120s timeout.", "inputSchema": {
            "type": "object", "properties": {
                "command": { "type": "string" },
                "cwd": { "type": "string", "description": "Working directory (default: home)." },
                "reason": reason }, "required": ["command", "reason"] } },
        { "name": "write_file", "description": "Create or overwrite a text file on a device (user approval required).", "inputSchema": {
            "type": "object", "properties": {
                "path": { "type": "string" }, "content": { "type": "string" }, "reason": reason },
            "required": ["path", "content", "reason"] } },
        { "name": "kill_process", "description": "Send a signal to a process on a device (user approval required).", "inputSchema": {
            "type": "object", "properties": {
                "pid": { "type": "integer" },
                "signal": { "type": "string", "enum": ["TERM", "KILL", "INT", "HUP"] },
                "reason": reason }, "required": ["pid", "reason"] } },
        { "name": "tailscale_set_exit_node", "description": "Use a Tailscale exit node on a device, or clear it with an empty string (user approval required).", "inputSchema": {
            "type": "object", "properties": {
                "exit_node": { "type": "string", "description": "Peer hostname or IP; empty to clear." }, "reason": reason },
            "required": ["exit_node", "reason"] } },
        { "name": "docker_action", "description": "Start, stop or restart a Docker container on a device (user approval required).", "inputSchema": {
            "type": "object", "properties": {
                "container": { "type": "string", "description": "Container id or name." },
                "action": { "type": "string", "enum": ["start", "stop", "restart"] }, "reason": reason },
            "required": ["container", "action", "reason"] } },
        { "name": "show_widget", "description": "Show a live, self-updating widget for a device in the chat. The user can open it as a full DevNest panel.", "inputSchema": {
            "type": "object", "properties": {
                "widget": { "type": "string", "enum": ["system_monitor", "processes", "tailscale", "docker"] },
                "title": { "type": "string" } }, "required": ["widget"] } },
    ]);
    let list = tools.as_array_mut().expect("array");
    for t in list.iter_mut() {
        t["inputSchema"] = with_device(t["inputSchema"].take());
    }
    // A widget is always about one machine: make the agent say which, so it
    // can't silently show the host when the user meant another device.
    if let Some(w) = list.iter_mut().find(|t| t["name"] == "show_widget") {
        w["inputSchema"]["required"] = json!(["widget", "device"]);
        w["inputSchema"]["properties"]["device"]["description"] =
            json!("Device name from list_devices, or \"host\" for this computer.");
    }
    list.insert(
        0,
        json!({ "name": "list_devices", "description": "Devices the user has in DevNest: the host (this computer) and SSH machines.", "inputSchema": empty() }),
    );
    tools
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing argument: {key}"))
}

fn expand_home(path: &str) -> String {
    match (path.strip_prefix('~'), dirs::home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            format!("{}{rest}", home.display())
        }
        _ => path.to_string(),
    }
}

/// `~/x` for SFTP, which resolves relative paths against the login directory.
fn sftp_path(path: &str) -> String {
    match path.strip_prefix('~') {
        Some("") => ".".into(),
        Some(rest) if rest.starts_with('/') => rest.trim_start_matches('/').to_string(),
        _ => path.to_string(),
    }
}

fn all_devices(app: &AppHandle) -> Result<Vec<Device>, String> {
    devices::list(&app.state::<AppState>().db).map_err(|e| e.to_string())
}

/// Lowercase letters and digits only, so "Beetle Eye" matches "beetle-eye".
fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The device a tool call targets: `want` by name / host / id, else the host.
fn pick_device(all: Vec<Device>, want: &str) -> Result<Device, String> {
    let want = want.trim();
    let n = norm(want);
    if n.is_empty() || ["host", "local", "localhost", "thiscomputer"].contains(&n.as_str()) {
        return all
            .into_iter()
            .find(|d| d.is_localhost)
            .ok_or_else(|| "no host device".into());
    }
    if let Some(d) = all
        .iter()
        .find(|d| d.id == want || norm(&d.name) == n || norm(&d.host) == n)
    {
        return Ok(d.clone());
    }
    let partial: Vec<&Device> = all
        .iter()
        .filter(|d| {
            let name = norm(&d.name);
            !name.is_empty() && (name.contains(&n) || n.contains(&name))
        })
        .collect();
    if let [d] = partial.as_slice() {
        return Ok((*d).clone());
    }
    let names: Vec<&str> = all.iter().map(|d| d.name.as_str()).collect();
    Err(format!(
        "No single device matches \"{want}\". Devices: {}. Ask the user which one they mean.",
        names.join(", ")
    ))
}

fn target(app: &AppHandle, args: &Value) -> Result<Device, String> {
    let want = args.get("device").and_then(Value::as_str).unwrap_or("");
    pick_device(all_devices(app)?, want)
}

fn device_label(d: &Device) -> String {
    if d.is_localhost {
        format!("{} (this computer)", d.name)
    } else {
        d.name.clone()
    }
}

/// Run `cmd` on `device` through a login shell. Local runs are killed after
/// `timeout`; remote ones use `timeout(1)` when the machine has it.
fn exec(
    app: &AppHandle,
    device: &Device,
    cmd: &str,
    cwd: Option<&str>,
    timeout: Duration,
    sudo: bool,
) -> AppResult<CommandOutput> {
    if device.is_localhost {
        let cwd = cwd.map(expand_home);
        return run_host_in(cmd, cwd.as_deref(), timeout);
    }
    let line = remote_line(cmd, cwd, timeout);
    let pool = &app.state::<AppState>().pool;
    if sudo {
        ssh::run_command(pool, device, &line)
    } else {
        ssh::run_command_no_sudo(pool, device, &line)
    }
}

fn remote_line(cmd: &str, cwd: Option<&str>, timeout: Duration) -> String {
    let shell = format!("\"${{SHELL:-/bin/sh}}\" -lc {}", q(cmd));
    let secs = timeout.as_secs();
    let line = format!(
        "if command -v timeout >/dev/null 2>&1; then timeout {secs} {shell}; else {shell}; fi"
    );
    match cwd {
        None => line,
        Some(dir) => {
            let cd = match dir.strip_prefix('~') {
                Some("") => "cd \"$HOME\"".to_string(),
                Some(rest) if rest.starts_with('/') => format!("cd \"$HOME\"{}", q(rest)),
                _ => format!("cd {}", q(dir)),
            };
            format!("{cd} && {line}")
        }
    }
}

/// Same script for macOS and Linux targets: pick the branch on the device.
fn by_os(mac: &str, linux: &str) -> String {
    format!("if [ \"$(uname)\" = Darwin ]; then\n{mac}\nelse\n{linux}\nfi")
}

fn pretty<T: Serialize>(v: &T) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn format_output(o: &CommandOutput) -> String {
    let mut s = format!("exit code: {}\n", o.exit_code);
    if !o.stdout.is_empty() {
        s.push_str(&format!("stdout:\n{}\n", truncate(&o.stdout, MAX_OUTPUT)));
    }
    if !o.stderr.is_empty() {
        s.push_str(&format!(
            "stderr:\n{}\n",
            truncate(&o.stderr, MAX_OUTPUT / 3)
        ));
    }
    s
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [truncated, {} bytes total]", &s[..end], s.len())
}

fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Result<String, String> {
    let state = app.state::<AppState>();
    if name == "list_devices" {
        let list: Vec<Value> = all_devices(app)?
            .iter()
            .map(|d| {
                json!({
                    "name": d.name,
                    "host": d.host,
                    "user": d.username,
                    "isHost": d.is_localhost,
                    "connected": d.is_localhost || state.pool.is_connected(&d.id),
                })
            })
            .collect();
        return Ok(pretty(&list));
    }

    let device = target(app, args)?;
    let on = device_label(&device);
    let hub = &state.master;
    let gate = |title: String, detail: String| -> Result<(), String> {
        if hub.ask(app, name, &on, title, detail) {
            Ok(())
        } else {
            Err("The user denied this action.".into())
        }
    };
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let read = |cmd: &str| exec(app, &device, cmd, None, COMMAND_TIMEOUT, false);
    let header = |body: String| format!("[device: {on}]\n{body}");

    match name {
        "host_info" => {
            let script = by_os(
                "echo \"host: $(hostname)\"; sw_vers; uname -mr; echo \"cpu: $(sysctl -n machdep.cpu.brand_string)\"; \
                 echo \"cores: $(sysctl -n hw.ncpu)\"; echo \"memory_bytes: $(sysctl -n hw.memsize)\"; uptime",
                "echo \"host: $(hostname)\"; grep -E '^(NAME|VERSION)=' /etc/os-release 2>/dev/null; uname -mr; \
                 grep -m1 'model name' /proc/cpuinfo; echo \"cores: $(nproc)\"; grep MemTotal /proc/meminfo; uptime",
            );
            read(&script)
                .map(|o| header(o.stdout))
                .map_err(|e| e.to_string())
        }
        "system_stats" => stats_for(app, &device)
            .map(|s| header(pretty(&s)))
            .map_err(|e| e.to_string()),
        "list_processes" => {
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .min(200);
            let by_mem = args.get("sort").and_then(Value::as_str) == Some("memory");
            let script = by_os(
                &format!(
                    "ps -Ao pid,pcpu,pmem,rss,user,comm {} | head -n {}",
                    if by_mem { "-m" } else { "-r" },
                    limit + 1
                ),
                &format!(
                    "ps -eo pid,pcpu,pmem,rss,user,comm --sort={} | head -n {}",
                    if by_mem { "-pmem" } else { "-pcpu" },
                    limit + 1
                ),
            );
            read(&script)
                .map(|o| header(o.stdout))
                .map_err(|e| e.to_string())
        }
        "listening_ports" => {
            let script = by_os(
                "lsof -nP -iTCP -sTCP:LISTEN",
                "ss -ltnp 2>/dev/null || netstat -ltnp",
            );
            read(&script)
                .map(|o| header(format_output(&o)))
                .map_err(|e| e.to_string())
        }
        "list_directory" => {
            let path = str_arg(args, "path")?;
            let entries = if device.is_localhost {
                local_fs::list_dir(&expand_home(path))
            } else {
                sftp::list_dir(&device, &sftp_path(path))
            };
            entries
                .map(|v| header(pretty(&v)))
                .map_err(|e| e.to_string())
        }
        "read_file" => {
            let path = str_arg(args, "path")?;
            let max = args
                .get("max_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(100_000) as usize;
            let text = if device.is_localhost {
                local_fs::read_file(&expand_home(path))
            } else {
                sftp::read_file(&device, &sftp_path(path))
            };
            text.map(|s| header(truncate(&s, max)))
                .map_err(|e| e.to_string())
        }
        "tailscale_status" => tailscale::status(&state.pool, &device)
            .map(|s| header(pretty(&s)))
            .map_err(|e| e.to_string()),
        "docker_containers" => docker::list_containers(&state.pool, &device)
            .map(|s| header(pretty(&s)))
            .map_err(|e| e.to_string()),
        "run_command" => {
            let command = str_arg(args, "command")?;
            let cwd = args.get("cwd").and_then(Value::as_str);
            let detail = match cwd {
                Some(dir) => format!("cd {dir}\n{command}"),
                None => command.to_string(),
            };
            gate(non_empty(&reason, "Run a command"), detail)?;
            exec(app, &device, command, cwd, COMMAND_TIMEOUT, true)
                .map(|o| header(format_output(&o)))
                .map_err(|e| e.to_string())
        }
        "write_file" => {
            let path = str_arg(args, "path")?;
            let content = str_arg(args, "content")?;
            gate(
                non_empty(&reason, "Write a file"),
                format!(
                    "write {path} ({} bytes)\n\n{}",
                    content.len(),
                    truncate(content, 4000)
                ),
            )?;
            let res = if device.is_localhost {
                local_fs::write_file(&expand_home(path), content)
            } else {
                sftp::write_file(&device, &sftp_path(path), content)
            };
            res.map(|_| header(format!("wrote {path}")))
                .map_err(|e| e.to_string())
        }
        "kill_process" => {
            let pid = args
                .get("pid")
                .and_then(Value::as_u64)
                .ok_or("missing argument: pid")?;
            let signal = args.get("signal").and_then(Value::as_str).unwrap_or("TERM");
            if !["TERM", "KILL", "INT", "HUP"].contains(&signal) {
                return Err(format!("unsupported signal: {signal}"));
            }
            let what = exec(
                app,
                &device,
                &format!("ps -o comm= -p {pid}"),
                None,
                Duration::from_secs(10),
                false,
            )
            .map(|o| o.stdout.trim().to_string())
            .unwrap_or_default();
            gate(
                non_empty(&reason, "Stop a process"),
                format!("kill -{signal} {pid}  ({what})"),
            )?;
            exec(
                app,
                &device,
                &format!("kill -{signal} {pid}"),
                None,
                COMMAND_TIMEOUT,
                true,
            )
            .map(|o| header(format_output(&o)))
            .map_err(|e| e.to_string())
        }
        "tailscale_set_exit_node" => {
            let node = str_arg(args, "exit_node")?.trim();
            if !node
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-_:".contains(c))
            {
                return Err("invalid exit node name".into());
            }
            gate(
                non_empty(&reason, "Change the Tailscale exit node"),
                format!("tailscale set --exit-node={node}"),
            )?;
            tailscale::set_exit_node(&state.pool, &device, (!node.is_empty()).then_some(node))
                .map(|_| header("done".to_string()))
                .map_err(|e| e.to_string())
        }
        "docker_action" => {
            let container = str_arg(args, "container")?;
            let action = str_arg(args, "action")?;
            if !["start", "stop", "restart"].contains(&action) {
                return Err(format!("unsupported action: {action}"));
            }
            gate(
                non_empty(&reason, "Change a Docker container"),
                format!("docker {action} {container}"),
            )?;
            docker::action(&state.pool, &device, container, action)
                .map(|o| header(format_output(&o)))
                .map_err(|e| e.to_string())
        }
        "show_widget" => {
            if args.get("device").and_then(Value::as_str).is_none() {
                return Err("Pass `device`: a name from list_devices, or \"host\".".into());
            }
            let widget = str_arg(args, "widget")?;
            if !["system_monitor", "processes", "tailscale", "docker"].contains(&widget) {
                return Err(format!("unknown widget: {widget}"));
            }
            let title = args.get("title").and_then(Value::as_str);
            let _ = app.emit(
                "master:widget",
                json!({
                    "id": uuid::Uuid::new_v4().to_string(),
                    "widget": widget,
                    "title": title,
                    "deviceId": device.id,
                    "deviceName": device.name,
                }),
            );
            Ok(format!(
                "Showing the live {widget} widget for {on} to the user. It keeps \
updating by itself; don't call show_widget again for the same device and widget."
            ))
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn non_empty(s: &str, fallback: &str) -> String {
    if s.trim().is_empty() {
        fallback.to_string()
    } else {
        s.trim().to_string()
    }
}

// ─── Host commands ────────────────────────────────────────────────────────────

fn run_host(cmd: &str, timeout: Duration) -> AppResult<CommandOutput> {
    run_host_in(cmd, None, timeout)
}

/// Run through the user's login shell (so Homebrew / nvm PATHs apply), with
/// no stdin and a hard timeout.
fn run_host_in(cmd: &str, cwd: Option<&str>, timeout: Duration) -> AppResult<CommandOutput> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let dir = match cwd {
        Some(d) => std::path::PathBuf::from(d),
        None => dirs::home_dir().unwrap_or_else(|| "/".into()),
    };
    if !dir.is_dir() {
        return Err(AppError::Invalid(format!(
            "not a directory: {}",
            dir.display()
        )));
    }
    let mut child = Command::new(shell)
        .arg("-lc")
        .arg(cmd)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let read = |mut r: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read(Box::new(child.stdout.take().expect("piped")));
    let err = read(Box::new(child.stderr.take().expect("piped")));

    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break Some(s);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = out.join().unwrap_or_default();
    let mut stderr = err.join().unwrap_or_default();
    let exit_code = match status {
        Some(s) => s.code().unwrap_or(-1),
        None => {
            stderr.push_str(&format!("\n[killed after {}s timeout]", timeout.as_secs()));
            -1
        }
    };
    Ok(CommandOutput {
        stdout,
        stderr,
        exit_code,
    })
}

// ─── Host stats (live widgets) ────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProcess {
    pub pid: u32,
    pub cpu: f32,
    pub mem: f32,
    pub name: String,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStats {
    pub cpu_percent: f32,
    pub cores: u32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub load: [f32; 3],
    pub disk_used: u64,
    pub disk_total: u64,
    /// Cumulative bytes since boot; the UI turns them into rates.
    pub net_rx: u64,
    pub net_tx: u64,
    pub uptime_secs: u64,
    pub top: Vec<HostProcess>,
    pub timestamp_ms: i64,
}

const MAC_STATS: &str = r#"
echo "cores=$(sysctl -n hw.ncpu)"
top -l 2 -n 0 -s 1 | grep 'CPU usage' | tail -n1 | awk '{gsub("%","",$7); print "idle=" $7}'
echo "memtotal=$(sysctl -n hw.memsize)"
ps_=$(sysctl -n hw.pagesize)
vm_stat | awk -v ps="$ps_" '/Pages active/ {a=$3} /Pages wired/ {w=$4} /occupied by compressor/ {c=$5} END {gsub("\\.","",a); gsub("\\.","",w); gsub("\\.","",c); print "memused=" (a+w+c)*ps}'
sysctl -n vm.loadavg | awk '{print "load=" $2 " " $3 " " $4}'
(df -k /System/Volumes/Data 2>/dev/null || df -k /) | tail -n1 | awk '{print "disk=" $2*1024 " " $3*1024}'
netstat -ibn | awk 'NF == 11 && $3 ~ /Link/ && $1 !~ /^lo/ {rx+=$7; tx+=$10} END {print "net=" rx+0 " " tx+0}'
boot=$(sysctl -n kern.boottime | sed -n 's/^{ sec = \([0-9]*\),.*/\1/p'); echo "uptime=$(( $(date +%s) - boot ))"
ps -Ao pid=,pcpu=,pmem=,comm= -r | head -n 8 | awk '{n=$4; for(i=5;i<=NF;i++) n=n" "$i; print "proc=" $1 "|" $2 "|" $3 "|" n}'
"#;

const LINUX_STATS: &str = r#"
echo "cores=$(nproc)"
a=$(head -n1 /proc/stat); sleep 0.5; b=$(head -n1 /proc/stat)
echo "$a
$b" | awk '{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; if (NR==1) {i1=idle; t1=tot} else {print "idle=" (t1==tot ? 100 : 100*(idle-i1)/(tot-t1))}}'
awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print "memtotal=" t*1024; print "memused=" (t-a)*1024}' /proc/meminfo
awk '{print "load=" $1 " " $2 " " $3}' /proc/loadavg
df -k / | tail -n1 | awk '{print "disk=" $2*1024 " " $3*1024}'
awk -F'[: ]+' 'NR>2 && $2 != "lo" {rx+=$3; tx+=$11} END {print "net=" rx+0 " " tx+0}' /proc/net/dev
awk '{print "uptime=" int($1)}' /proc/uptime
ps -eo pid=,pcpu=,pmem=,comm= --sort=-pcpu | head -n 8 | awk '{print "proc=" $1 "|" $2 "|" $3 "|" $4}'
"#;

fn stats_for(app: &AppHandle, device: &Device) -> AppResult<HostStats> {
    let out = exec(
        app,
        device,
        &by_os(MAC_STATS, LINUX_STATS),
        None,
        Duration::from_secs(20),
        false,
    )?;
    if out.stdout.trim().is_empty() {
        return Err(AppError::Ssh(format!(
            "no stats from {}: {}",
            device.name,
            out.stderr.trim()
        )));
    }
    Ok(parse_stats(&out.stdout))
}

fn parse_stats(raw: &str) -> HostStats {
    let mut s = HostStats {
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };
    let nums = |v: &str| -> Vec<f64> {
        v.split_whitespace()
            .filter_map(|x| x.parse().ok())
            .collect()
    };
    for line in raw.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let n = nums(v);
        match k {
            "cores" => s.cores = n.first().copied().unwrap_or(0.0) as u32,
            "idle" => {
                s.cpu_percent =
                    (100.0 - n.first().copied().unwrap_or(100.0)).clamp(0.0, 100.0) as f32
            }
            "memtotal" => s.mem_total = n.first().copied().unwrap_or(0.0) as u64,
            "memused" => s.mem_used = n.first().copied().unwrap_or(0.0) as u64,
            "load" if n.len() >= 3 => s.load = [n[0] as f32, n[1] as f32, n[2] as f32],
            "disk" if n.len() >= 2 => {
                s.disk_total = n[0] as u64;
                s.disk_used = n[1] as u64;
            }
            "net" if n.len() >= 2 => {
                s.net_rx = n[0] as u64;
                s.net_tx = n[1] as u64;
            }
            "uptime" => s.uptime_secs = n.first().copied().unwrap_or(0.0) as u64,
            "proc" => {
                let f: Vec<&str> = v.splitn(4, '|').collect();
                if f.len() == 4 {
                    let name = f[3].trim();
                    s.top.push(HostProcess {
                        pid: f[0].trim().parse().unwrap_or(0),
                        cpu: f[1].trim().parse().unwrap_or(0.0),
                        mem: f[2].trim().parse().unwrap_or(0.0),
                        name: name.rsplit('/').next().unwrap_or(name).to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    s
}

// ─── Stdio bridge ─────────────────────────────────────────────────────────────

/// `devnest --mcp-bridge`: relay stdio MCP (one JSON message per line) to the
/// HTTP endpoint in `DEVNEST_MCP_URL`, authenticating with
/// `DEVNEST_MCP_TOKEN`. For agents that can't speak HTTP MCP.
pub fn bridge() {
    let url = std::env::var(ENV_URL).unwrap_or_default();
    let token = std::env::var(ENV_TOKEN).unwrap_or_default();
    let Some(rest) = url.strip_prefix("http://") else {
        eprintln!("devnest mcp bridge: {ENV_URL} must be an http:// URL");
        std::process::exit(2);
    };
    let (addr, path) = match rest.split_once('/') {
        Some((a, p)) => (a.to_string(), format!("/{p}")),
        None => (rest.to_string(), "/".to_string()),
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match post(&addr, &path, &token, &line) {
            Ok(body) if !body.trim().is_empty() => {
                // Batches come back as an array; stdio wants one message per line.
                match serde_json::from_str::<Value>(&body) {
                    Ok(Value::Array(items)) => {
                        for it in items {
                            let _ = writeln!(stdout, "{it}");
                        }
                    }
                    _ => {
                        let _ = writeln!(stdout, "{}", body.trim());
                    }
                }
                let _ = stdout.flush();
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("devnest mcp bridge: {e}");
                // Answer requests so the agent doesn't hang on a dead app.
                if let Some(id) = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|m| m.get("id").cloned())
                {
                    let _ = writeln!(
                        stdout,
                        "{}",
                        rpc_error(id, -32603, &format!("DevNest unreachable: {e}"))
                    );
                    let _ = stdout.flush();
                }
            }
        }
    }
}

fn post(addr: &str, path: &str, token: &str, body: &str) -> std::io::Result<String> {
    let mut s = TcpStream::connect(addr)?;
    write!(
        s,
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\n\
Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    s.flush()?;
    let mut resp = String::new();
    s.read_to_string(&mut resp)?;
    let (head, rest) = resp.split_once("\r\n\r\n").unwrap_or((&resp, ""));
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if !status.starts_with('2') {
        return Err(std::io::Error::other(format!("HTTP {status}")));
    }
    Ok(rest.to_string())
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn master_start(app: AppHandle, state: tauri::State<'_, AppState>) -> AppResult<Endpoint> {
    state.master.start(app)
}

#[tauri::command]
pub fn master_resolve(state: tauri::State<'_, AppState>, id: String, allow: bool) {
    state.master.resolve(&id, allow);
}

/// Deny every pending approval (turn cancelled, agent stopped).
#[tauri::command]
pub fn master_deny_all(state: tauri::State<'_, AppState>) {
    state.master.deny_all();
}

/// Live stats for a widget; `device_id` defaults to the host.
#[tauri::command(async)]
pub fn host_stats(app: AppHandle, device_id: Option<String>) -> AppResult<HostStats> {
    let all = devices::list(&app.state::<AppState>().db)?;
    let device = pick_device(all, device_id.as_deref().unwrap_or("")).map_err(AppError::Invalid)?;
    stats_for(&app, &device)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stats() {
        let s = parse_stats(
            "cores=8\nidle=75.5\nmemtotal=17179869184\nmemused=8589934592\nload=1.5 2.0 2.5\n\
disk=1000 400\nnet=123 456\nuptime=3600\nproc=42|12.5|1.0|/usr/bin/Google Chrome Helper\n",
        );
        assert_eq!(s.cores, 8);
        assert!((s.cpu_percent - 24.5).abs() < 0.01);
        assert_eq!(s.mem_used, 8589934592);
        assert_eq!(s.load, [1.5, 2.0, 2.5]);
        assert_eq!((s.disk_total, s.disk_used), (1000, 400));
        assert_eq!((s.net_rx, s.net_tx), (123, 456));
        assert_eq!(s.top[0].pid, 42);
        assert_eq!(s.top[0].name, "Google Chrome Helper");
    }

    #[test]
    fn expands_home() {
        let home = dirs::home_dir().unwrap().display().to_string();
        assert_eq!(expand_home("~/x"), format!("{home}/x"));
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("/etc"), "/etc");
        assert_eq!(expand_home("~bob/x"), "~bob/x");
    }

    /// The HTTP server and the stdio bridge's client, over a real socket.
    #[test]
    fn http_round_trip() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = serve(stream, "secret", |m| {
                    let id = m.get("id").cloned()?;
                    Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "echo": m["method"] } }))
                });
            }
        });

        let body = post(
            &addr,
            "/mcp",
            "secret",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["echo"], "tools/list");

        // Notifications: 202, no body.
        let body = post(
            &addr,
            "/mcp",
            "secret",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .unwrap();
        assert!(body.is_empty());

        // Batches answer every request in one array.
        let body = post(
            &addr,
            "/mcp",
            "secret",
            r#"[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]"#,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);

        // Wrong token and wrong path are refused.
        assert!(post(&addr, "/mcp", "nope", "{}").is_err());
        assert!(post(&addr, "/other", "secret", "{}").is_err());
    }

    #[test]
    fn tool_schemas_are_objects() {
        let defs = tool_defs();
        let defs = defs.as_array().unwrap();
        assert!(defs.len() >= 10);
        for d in defs {
            assert!(d["name"].is_string());
            assert_eq!(d["inputSchema"]["type"], "object", "{}", d["name"]);
        }
        let widget = defs.iter().find(|d| d["name"] == "show_widget").unwrap();
        assert_eq!(
            widget["inputSchema"]["required"],
            json!(["widget", "device"])
        );
    }

    fn dev(name: &str, host: &str, local: bool) -> Device {
        Device {
            id: format!("id-{name}"),
            name: name.into(),
            host: host.into(),
            port: 22,
            username: "u".into(),
            auth_type: if local {
                devices::AuthType::Localhost
            } else {
                devices::AuthType::Key
            },
            key_path: None,
            is_localhost: local,
            sudo_prefix: None,
            use_sudo: false,
            keep_alive: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn picks_devices_by_loose_name() {
        let all = || {
            vec![
                dev("MacBook", "localhost", true),
                dev("Beetle-Eye", "100.64.0.7", false),
                dev("nas", "nas.local", false),
                dev("nas-backup", "10.0.0.9", false),
            ]
        };
        let pick = |w: &str| pick_device(all(), w).map(|d| d.name);
        assert_eq!(pick("").unwrap(), "MacBook");
        assert_eq!(pick("host").unwrap(), "MacBook");
        assert_eq!(pick("beetle eye").unwrap(), "Beetle-Eye");
        assert_eq!(pick("BEETLEEYE").unwrap(), "Beetle-Eye");
        assert_eq!(pick("beetle").unwrap(), "Beetle-Eye");
        assert_eq!(pick("100.64.0.7").unwrap(), "Beetle-Eye");
        assert_eq!(pick("id-nas").unwrap(), "nas");
        // Exact name wins over a longer partial match.
        assert_eq!(pick("nas").unwrap(), "nas");
        // Unknown names fail instead of falling back to the host.
        let err = pick("raspberry").unwrap_err();
        assert!(err.contains("Beetle-Eye"), "{err}");
    }

    #[test]
    fn remote_lines_quote_and_cd() {
        let l = remote_line("echo 'hi'", Some("~/app"), Duration::from_secs(5));
        assert!(l.starts_with("cd \"$HOME\"'/app' && "), "{l}");
        assert!(l.contains("timeout 5 "), "{l}");
        assert!(l.contains(&q("echo 'hi'")), "{l}");
    }
}

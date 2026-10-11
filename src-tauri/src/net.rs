//! Ping monitor and internet speed test, run *on the device* (so a remote
//! device measures its own connection, not the machine running DevNest).
//!
//! Ping uses the system `ping`; the speed test uses `curl` against
//! Cloudflare's public speed-test endpoints (`speed.cloudflare.com`).

use serde::Serialize;

use crate::devices::Device;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, shell_single_quote, SessionPool};

const SPEED_HOST: &str = "https://speed.cloudflare.com";
/// Cloudflare rejects larger `__down` requests (403 at 100 MB).
const MAX_DOWN_BYTES: u64 = 50_000_000;
/// Larger `__up` bodies get cut off around 20 MB.
const MAX_UP_BYTES: u64 = 15_000_000;
const MAX_STREAMS: u32 = 8;
const MAX_HOSTS: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub host: String,
    /// Round-trip time; `None` when the packet was lost (or on error).
    pub rtt_ms: Option<f64>,
    /// Set when ping itself failed (unknown host, not permitted, …).
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedProbe {
    pub ip: Option<String>,
    /// Cloudflare data centre (IATA airport code, e.g. "FRA").
    pub colo: Option<String>,
    /// Country code of the client.
    pub loc: Option<String>,
    pub latency_ms: f64,
    pub jitter_ms: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeedSample {
    pub bytes: u64,
    pub seconds: f64,
    pub mbps: f64,
}

/// Hostnames / IPv4 / IPv6 only, so they're safe to drop into a script.
fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
}

fn run(pool: &SessionPool, device: &Device, script: &str) -> AppResult<ssh::CommandOutput> {
    // Wrap in `sh -c` so a device sudo prefix applies to the whole script.
    ssh::run_command_no_sudo(
        pool,
        device,
        &format!("sh -c {}", shell_single_quote(script)),
    )
}

// ─── Ping ────────────────────────────────────────────────────────────────────

/// One ping per host, all in parallel, each waiting at most ~2 s.
pub fn ping(pool: &SessionPool, device: &Device, hosts: &[String]) -> AppResult<Vec<PingResult>> {
    if hosts.len() > MAX_HOSTS {
        return Err(AppError::Invalid(format!("at most {MAX_HOSTS} hosts")));
    }
    if let Some(bad) = hosts.iter().find(|h| !valid_host(h)) {
        return Err(AppError::Invalid(format!("not a valid host: {bad}")));
    }
    if hosts.is_empty() {
        return Ok(vec![]);
    }
    let out = run(pool, device, &ping_script(hosts))?;
    Ok(parse_ping(&out.stdout, hosts))
}

fn ping_script(hosts: &[String]) -> String {
    // macOS: -t is the overall timeout in seconds; Linux/busybox: -W.
    let mut script = String::from(
        r#"os=$(uname)
p() {
  if [ "$os" = Darwin ]; then o=$(ping -c1 -t2 "$1" 2>&1); else o=$(ping -c1 -W2 "$1" 2>&1); fi
  t=$(printf '%s\n' "$o" | sed -n 's/.*time[=<] *\([0-9.]*\).*/\1/p' | head -n1)
  if [ -n "$t" ]; then printf '%s\tok\t%s\n' "$1" "$t"
  elif [ -z "$o" ] || printf '%s' "$o" | grep -q 'packet loss'; then printf '%s\tlost\n' "$1"
  else printf '%s\terr\t%s\n' "$1" "$(printf '%s\n' "$o" | head -n1)"; fi
}
"#,
    );
    for h in hosts {
        script.push_str(&format!("p {} &\n", shell_single_quote(h)));
    }
    script.push_str("wait\n");
    script
}

/// Parse `host\tok\t<ms>` / `host\tlost` / `host\terr\t<msg>` lines, in the
/// order of `hosts` (the pings finish in any order). Missing hosts are lost.
fn parse_ping(stdout: &str, hosts: &[String]) -> Vec<PingResult> {
    let mut by_host = std::collections::HashMap::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(host), Some(kind)) = (parts.next(), parts.next()) else {
            continue;
        };
        let rest = parts.next().unwrap_or("").trim();
        let (rtt_ms, error) = match kind {
            "ok" => (rest.parse::<f64>().ok(), None),
            "err" => (None, Some(rest.trim_start_matches("ping: ").to_string())),
            _ => (None, None),
        };
        by_host.insert(host.to_string(), (rtt_ms, error));
    }
    hosts
        .iter()
        .map(|h| {
            let (rtt_ms, error) = by_host.remove(h).unwrap_or((None, None));
            PingResult {
                host: h.clone(),
                rtt_ms,
                error,
            }
        })
        .collect()
}

// ─── Speed test ──────────────────────────────────────────────────────────────

const NEED_CURL: &str = "command -v curl >/dev/null 2>&1 || { echo NOCURL; exit 0; }\n";

fn no_curl(out: &ssh::CommandOutput) -> AppResult<()> {
    if out.stdout.trim() == "NOCURL" {
        return Err(AppError::Invalid(
            "curl is not installed on this device".into(),
        ));
    }
    Ok(())
}

/// Server/IP info plus idle latency: the TCP handshake time of fresh
/// connections (one round trip each), ignoring the cold first one.
pub fn speed_probe(pool: &SessionPool, device: &Device) -> AppResult<SpeedProbe> {
    let out = run(pool, device, &probe_script())?;
    no_curl(&out)?;
    parse_probe(&out.stdout).ok_or_else(|| {
        AppError::Ssh(format!(
            "could not reach speed.cloudflare.com: {}",
            out.stderr.lines().next().unwrap_or("no response").trim()
        ))
    })
}

fn probe_script() -> String {
    format!(
        "{NEED_CURL}curl -sS --max-time 5 {SPEED_HOST}/cdn-cgi/trace\necho '--'\n\
         for i in 1 2 3 4 5 6 7; do curl -sS -o /dev/null --max-time 5 \
         -w '%{{time_namelookup}} %{{time_connect}}\\n' '{SPEED_HOST}/__down?bytes=0'; done\n"
    )
}

fn parse_probe(stdout: &str) -> Option<SpeedProbe> {
    let (trace, timings) = stdout.split_once("\n--\n")?;
    let field = |k: &str| {
        trace
            .lines()
            .find_map(|l| l.strip_prefix(k)?.strip_prefix('='))
            .map(str::to_string)
    };
    let rtts: Vec<f64> = timings
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace().map(|v| v.parse::<f64>().ok());
            let (dns, connect) = (it.next()??, it.next()??);
            (connect > 0.0).then(|| (connect - dns).max(0.0) * 1000.0)
        })
        .collect();
    let rtts = if rtts.len() > 2 {
        &rtts[1..]
    } else {
        &rtts[..]
    };
    if rtts.is_empty() {
        return None;
    }
    let mut sorted = rtts.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let latency_ms = sorted[sorted.len() / 2];
    let jitter_ms = if rtts.len() > 1 {
        rtts.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (rtts.len() - 1) as f64
    } else {
        0.0
    };
    Some(SpeedProbe {
        ip: field("ip"),
        colo: field("colo"),
        loc: field("loc"),
        latency_ms,
        jitter_ms,
    })
}

/// One measurement: `streams` parallel transfers of `bytes` each. The
/// frontend runs several, sizing each from the last, so the UI updates live.
pub fn speed_sample(
    pool: &SessionPool,
    device: &Device,
    upload: bool,
    bytes: u64,
    streams: u32,
) -> AppResult<SpeedSample> {
    let out = run(pool, device, &transfer_script(upload, bytes, streams))?;
    no_curl(&out)?;
    parse_transfer(&out.stdout).ok_or_else(|| {
        AppError::Ssh(format!(
            "speed test failed: {}",
            out.stderr
                .lines()
                .next()
                .unwrap_or("no data transferred")
                .trim()
        ))
    })
}

fn transfer_script(upload: bool, bytes: u64, streams: u32) -> String {
    let streams = streams.clamp(1, MAX_STREAMS);
    let bytes = bytes.clamp(100_000, if upload { MAX_UP_BYTES } else { MAX_DOWN_BYTES });
    let one = if upload {
        format!(
            "head -c {bytes} /dev/zero | curl -sS -o /dev/null --max-time 20 \
             -w '%{{http_code}} %{{size_upload}} %{{time_pretransfer}} %{{time_total}}\\n' \
             -X POST -H 'Content-Type: application/octet-stream' -T - '{SPEED_HOST}/__up'"
        )
    } else {
        format!(
            "curl -sS -o /dev/null --max-time 20 \
             -w '%{{http_code}} %{{size_download}} %{{time_pretransfer}} %{{time_total}}\\n' \
             '{SPEED_HOST}/__down?bytes={bytes}'"
        )
    };
    let mut script = NEED_CURL.to_string();
    for _ in 0..streams {
        script.push_str(&format!("{one} &\n"));
    }
    script.push_str("wait\n");
    script
}

/// Parallel streams: total bytes over the longest stream's transfer time
/// (excluding DNS/TCP/TLS setup). A stream cut off by `--max-time` still
/// counts what it moved.
fn parse_transfer(stdout: &str) -> Option<SpeedSample> {
    let mut bytes = 0u64;
    let mut seconds = 0f64;
    for line in stdout.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        let [code, size, pre, total] = f[..] else {
            continue;
        };
        let (Ok(size), Ok(pre), Ok(total)) = (
            size.parse::<f64>(),
            pre.parse::<f64>(),
            total.parse::<f64>(),
        ) else {
            continue;
        };
        // 4xx/5xx bodies are error pages, not payload.
        if size <= 0.0 || code.starts_with('4') || code.starts_with('5') {
            continue;
        }
        bytes += size as u64;
        seconds = seconds.max(total - pre);
    }
    if bytes == 0 || seconds <= 0.0 {
        return None;
    }
    Some(SpeedSample {
        bytes,
        seconds,
        mbps: bytes as f64 * 8.0 / seconds / 1_000_000.0,
    })
}

// ─── Commands ────────────────────────────────────────────────────────────────

fn device(state: &crate::state::AppState, id: String) -> AppResult<Device> {
    crate::devices::get(&state.db, &id)?.ok_or(AppError::NotFound(id))
}

#[tauri::command(async)]
pub fn net_ping(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    hosts: Vec<String>,
) -> AppResult<Vec<PingResult>> {
    let device = device(&state, device_id)?;
    ping(&state.pool, &device, &hosts)
}

#[tauri::command(async)]
pub fn net_speed_probe(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
) -> AppResult<SpeedProbe> {
    let device = device(&state, device_id)?;
    speed_probe(&state.pool, &device)
}

#[tauri::command(async)]
pub fn net_speed_sample(
    state: tauri::State<'_, crate::state::AppState>,
    device_id: String,
    upload: bool,
    bytes: u64,
    streams: u32,
) -> AppResult<SpeedSample> {
    let device = device(&state, device_id)?;
    speed_sample(&state.pool, &device, upload, bytes, streams)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_hosts() {
        assert!(valid_host("1.1.1.1"));
        assert!(valid_host("google.com"));
        assert!(valid_host("fe80::1"));
        assert!(!valid_host("-c9"));
        assert!(!valid_host("a;rm -rf /"));
        assert!(!valid_host("$(id)"));
        assert!(!valid_host(""));
    }

    #[test]
    fn parses_ping_in_host_order() {
        let hosts: Vec<String> = ["1.1.1.1", "10.0.0.9", "bad.invalid", "gone"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let out = "bad.invalid\terr\tping: bad.invalid: Name or service not known\n\
                   1.1.1.1\tok\t26.756\n10.0.0.9\tlost\n";
        let r = parse_ping(out, &hosts);
        assert_eq!(r[0].rtt_ms, Some(26.756));
        assert_eq!(r[1].rtt_ms, None);
        assert_eq!(r[1].error, None);
        assert_eq!(
            r[2].error.as_deref(),
            Some("bad.invalid: Name or service not known")
        );
        assert_eq!(r[3].host, "gone");
        assert_eq!(r[3].rtt_ms, None);
    }

    #[test]
    fn parses_probe() {
        let out = "fl=1\nip=203.0.113.7\ncolo=FRA\nloc=DE\n\n--\n\
                   0.002 0.150\n0.003 0.030\n0.003 0.032\n0.003 0.028\n";
        let p = parse_probe(out).unwrap();
        assert_eq!(p.colo.as_deref(), Some("FRA"));
        assert_eq!(p.ip.as_deref(), Some("203.0.113.7"));
        // Cold first connection dropped; median of 27, 29, 25 ms.
        assert!((p.latency_ms - 27.0).abs() < 0.01);
        assert!((p.jitter_ms - 3.0).abs() < 0.01);
    }

    #[test]
    fn parses_parallel_transfer() {
        let out = "200 5000000 0.29 1.29\n200 5000000 0.20 1.70\n403 120 0.1 0.2\n";
        let s = parse_transfer(out).unwrap();
        assert_eq!(s.bytes, 10_000_000);
        assert!((s.seconds - 1.5).abs() < 1e-9);
        assert!((s.mbps - 53.333).abs() < 0.01);
        assert!(parse_transfer("000 0 0 0\n").is_none());
    }

    fn sh(script: &str) -> String {
        let out = crate::local_shell::sh(script).output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Runs the real scripts against this machine and the network:
    /// `cargo test --lib net::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live() {
        let hosts: Vec<String> = [
            "1.1.1.1",
            "10.255.255.1",
            "nonexistent.invalid",
            "localhost",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let raw = sh(&ping_script(&hosts));
        println!("ping raw:\n{raw}");
        println!("{:?}", parse_ping(&raw, &hosts));
        println!("{:?}", parse_probe(&sh(&probe_script())));
        println!(
            "down {:?}",
            parse_transfer(&sh(&transfer_script(false, 5_000_000, 4)))
        );
        println!(
            "up {:?}",
            parse_transfer(&sh(&transfer_script(true, 2_000_000, 4)))
        );
    }
}

use serde::Serialize;

use crate::devices::Device;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, SessionPool};

// ─── Snapshot (polled) ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub timestamp_ms: i64,
    /// Aggregate CPU% computed from /proc/stat aggregate row deltas — but the
    /// frontend gets raw counters too and computes its own.
    pub cpu_percent: f32,
    /// Per-core cumulative jiffies. Frontend computes deltas across polls.
    pub cpu_cores: Vec<CpuCoreTicks>,
    pub mem: MemInfo,
    pub swap: SwapInfo,
    pub load: LoadAvg,
    /// Seconds the system has been up.
    pub uptime_seconds: u64,
    /// Total processes / running tasks. (running, total)
    pub processes: ProcessCounts,
    pub disks: Vec<DiskUsage>,
    /// Cumulative network counters per interface (bytes + packets).
    pub net: Vec<NetInterface>,
    pub temperatures: Vec<ThermalZone>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuCoreTicks {
    pub core: u32,
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
}

impl CpuCoreTicks {
    fn total(&self) -> u64 {
        self.user + self.nice + self.system + self.idle + self.iowait + self.irq + self.softirq + self.steal
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemInfo {
    pub total_mb: u64,
    pub free_mb: u64,
    pub available_mb: u64,
    pub used_mb: u64,
    pub buffers_mb: u64,
    pub cached_mb: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub total_mb: u64,
    pub used_mb: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAvg {
    pub one: f32,
    pub five: f32,
    pub fifteen: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCounts {
    pub running: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub mount: String,
    pub total: String,
    pub used: String,
    pub use_percent: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInterface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThermalZone {
    pub name: String,
    pub celsius: f32,
}

// ─── Static CPU info (one-shot) ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub model: String,
    pub vendor: String,
    pub physical_cores: u32,
    pub logical_cores: u32,
    pub mhz: f32,
    pub cache_kb: u64,
    pub governor: Option<String>,
    pub architecture: String,
}

// ─── DIMM info (one-shot, needs sudo) ────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DimmModule {
    pub locator: String,
    pub size: String,
    pub kind: String,
    pub speed: String,
    pub manufacturer: String,
    pub part_number: String,
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/// Sentinels mark section boundaries in the combined shell output so we don't
/// have to invoke six separate SSH commands per poll.
const SECTIONS: &[&str] = &["STAT", "MEM", "LOAD", "UPTIME", "DF", "NET", "THERMAL"];

pub fn snapshot(pool: &SessionPool, device: &Device) -> AppResult<MetricsSnapshot> {
    // Build a single shell script. `for f in /sys/class/thermal/thermal_zone*` runs
    // a small loop to print "<type> <millideg>" for each zone (empty if none).
    let cmd = r#"
echo '##STAT##'; cat /proc/stat
echo '##MEM##'; cat /proc/meminfo
echo '##LOAD##'; cat /proc/loadavg
echo '##UPTIME##'; cat /proc/uptime
echo '##DF##'; df -h --output=target,size,used,pcent -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -h
echo '##NET##'; cat /proc/net/dev
echo '##THERMAL##'
for f in /sys/class/thermal/thermal_zone*; do
  [ -d "$f" ] || continue
  t=$(cat "$f/type" 2>/dev/null)
  m=$(cat "$f/temp" 2>/dev/null)
  [ -n "$t" ] && [ -n "$m" ] && echo "$t $m"
done
"#;
    let out = ssh::run_command(pool, device, cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Ssh(format!(
            "metrics exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }

    let sections = split_named_sections(&out.stdout, SECTIONS);
    let stat_s = sections.get("STAT").copied().unwrap_or("");
    let mem_s = sections.get("MEM").copied().unwrap_or("");
    let load_s = sections.get("LOAD").copied().unwrap_or("");
    let uptime_s = sections.get("UPTIME").copied().unwrap_or("");
    let df_s = sections.get("DF").copied().unwrap_or("");
    let net_s = sections.get("NET").copied().unwrap_or("");
    let thermal_s = sections.get("THERMAL").copied().unwrap_or("");

    let (cpu_aggregate, cpu_cores, procs) = parse_proc_stat(stat_s);
    let (mem, swap) = parse_meminfo(mem_s);
    let load = parse_loadavg(load_s);
    let uptime_seconds = parse_uptime(uptime_s);
    let disks = parse_df(df_s);
    let net = parse_net_dev(net_s);
    let temperatures = parse_thermal(thermal_s);

    // We don't have a "previous" snapshot to compute a real CPU% — the frontend
    // does that from per-core counters. As a courtesy, return idle-vs-total
    // ratio of the aggregate cumulative row (not very meaningful long-term).
    let cpu_percent = if let Some(agg) = cpu_aggregate {
        let total = agg.total();
        if total > 0 {
            let busy = total - agg.idle - agg.iowait;
            (busy as f32 / total as f32) * 100.0
        } else {
            0.0
        }
    } else {
        0.0
    };

    Ok(MetricsSnapshot {
        timestamp_ms: now_ms(),
        cpu_percent,
        cpu_cores,
        mem,
        swap,
        load,
        uptime_seconds,
        processes: procs,
        disks,
        net,
        temperatures,
    })
}

pub fn cpu_info(pool: &SessionPool, device: &Device) -> AppResult<CpuInfo> {
    let cmd = r#"
echo '##CPUINFO##'; cat /proc/cpuinfo
echo '##GOV##'; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null
echo '##ARCH##'; uname -m
"#;
    let out = ssh::run_command(pool, device, cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Ssh(format!(
            "cpu_info exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }
    let sections = split_named_sections(&out.stdout, &["CPUINFO", "GOV", "ARCH"]);
    let cpuinfo = sections.get("CPUINFO").copied().unwrap_or("");
    let governor = sections
        .get("GOV")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let architecture = sections
        .get("ARCH")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    Ok(parse_cpuinfo(cpuinfo, governor, architecture))
}

pub fn dimms(pool: &SessionPool, device: &Device) -> AppResult<Vec<DimmModule>> {
    // dmidecode requires root. The frontend gates this behind device.use_sudo
    // and our ssh::run_command already handles sudo wrapping.
    let out = ssh::run_command(pool, device, "dmidecode -t memory")?;
    if out.exit_code != 0 {
        return Err(AppError::Invalid(format!(
            "dmidecode failed (needs sudo): {}",
            out.stderr.trim()
        )));
    }
    Ok(parse_dmidecode_memory(&out.stdout))
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

fn split_named_sections<'a>(
    s: &'a str,
    names: &[&str],
) -> std::collections::HashMap<String, &'a str> {
    let mut map = std::collections::HashMap::new();
    let mut marker_positions: Vec<(usize, String)> = Vec::new();
    for name in names {
        let marker = format!("##{name}##");
        let mut start = 0;
        while let Some(i) = s[start..].find(&marker) {
            marker_positions.push((start + i, (*name).to_string()));
            start += i + marker.len();
        }
    }
    marker_positions.sort_by_key(|(i, _)| *i);
    for (idx, (pos, name)) in marker_positions.iter().enumerate() {
        let body_start = pos + format!("##{name}##").len();
        let body_end = marker_positions
            .get(idx + 1)
            .map(|(p, _)| *p)
            .unwrap_or(s.len());
        if body_start <= body_end {
            map.insert(
                name.clone(),
                s[body_start..body_end].trim_matches('\n'),
            );
        }
    }
    map
}

fn parse_proc_stat(s: &str) -> (Option<CpuCoreTicks>, Vec<CpuCoreTicks>, ProcessCounts) {
    let mut aggregate: Option<CpuCoreTicks> = None;
    let mut cores: Vec<CpuCoreTicks> = Vec::new();
    let mut procs_running = 0u32;
    let mut procs_total = 0u32;
    for line in s.lines() {
        let line = line.trim();
        if line.starts_with("cpu") {
            // "cpu" or "cpuN" followed by jiffies.
            let mut it = line.split_whitespace();
            let label = it.next().unwrap_or("");
            let nums: Vec<u64> = it.filter_map(|t| t.parse::<u64>().ok()).collect();
            if nums.len() < 8 {
                continue;
            }
            let ticks = CpuCoreTicks {
                core: if label == "cpu" {
                    u32::MAX
                } else {
                    label.trim_start_matches("cpu").parse::<u32>().unwrap_or(0)
                },
                user: nums[0],
                nice: nums[1],
                system: nums[2],
                idle: nums[3],
                iowait: nums[4],
                irq: nums[5],
                softirq: nums[6],
                steal: nums[7],
            };
            if label == "cpu" {
                aggregate = Some(ticks);
            } else {
                cores.push(ticks);
            }
        } else if let Some(v) = line.strip_prefix("procs_running ") {
            procs_running = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("processes ") {
            procs_total = v.trim().parse().unwrap_or(0);
        }
    }
    cores.sort_by_key(|c| c.core);
    (
        aggregate,
        cores,
        ProcessCounts {
            running: procs_running,
            total: procs_total,
        },
    )
}

fn parse_meminfo(s: &str) -> (MemInfo, SwapInfo) {
    let mut total = 0;
    let mut free = 0;
    let mut available = 0;
    let mut buffers = 0;
    let mut cached = 0;
    let mut swap_total = 0;
    let mut swap_free = 0;
    for line in s.lines() {
        let line = line.trim();
        let (key, rest) = match line.split_once(':') {
            Some(p) => p,
            None => continue,
        };
        // value is e.g. "  15843432 kB"
        let kb = rest
            .split_whitespace()
            .next()
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0);
        match key {
            "MemTotal" => total = kb,
            "MemFree" => free = kb,
            "MemAvailable" => available = kb,
            "Buffers" => buffers = kb,
            "Cached" => cached = kb,
            "SwapTotal" => swap_total = kb,
            "SwapFree" => swap_free = kb,
            _ => {}
        }
    }
    let kb_to_mb = |kb: u64| kb / 1024;
    // "Used" mirrors free's calculation: total - available is the modern way.
    let used = total.saturating_sub(available);
    let mem = MemInfo {
        total_mb: kb_to_mb(total),
        free_mb: kb_to_mb(free),
        available_mb: kb_to_mb(available),
        used_mb: kb_to_mb(used),
        buffers_mb: kb_to_mb(buffers),
        cached_mb: kb_to_mb(cached),
    };
    let swap = SwapInfo {
        total_mb: kb_to_mb(swap_total),
        used_mb: kb_to_mb(swap_total.saturating_sub(swap_free)),
    };
    (mem, swap)
}

fn parse_loadavg(s: &str) -> LoadAvg {
    let line = s.lines().next().unwrap_or("").trim();
    let mut it = line.split_whitespace();
    let one = it.next().and_then(|n| n.parse().ok()).unwrap_or(0.0);
    let five = it.next().and_then(|n| n.parse().ok()).unwrap_or(0.0);
    let fifteen = it.next().and_then(|n| n.parse().ok()).unwrap_or(0.0);
    LoadAvg { one, five, fifteen }
}

fn parse_uptime(s: &str) -> u64 {
    s.split_whitespace()
        .next()
        .and_then(|n| n.parse::<f64>().ok())
        .map(|f| f as u64)
        .unwrap_or(0)
}

fn parse_df(s: &str) -> Vec<DiskUsage> {
    let mut out = Vec::new();
    for (i, line) in s.lines().enumerate() {
        if i == 0 {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }
        let (mount, total, used, pct_str) = if cols.len() == 4 {
            (cols[0], cols[1], cols[2], cols[3])
        } else if cols.len() >= 6 {
            (cols[5], cols[1], cols[2], cols[4])
        } else {
            continue;
        };
        let pct = pct_str.trim_end_matches('%').parse::<f32>().unwrap_or(0.0);
        out.push(DiskUsage {
            mount: mount.to_string(),
            total: total.to_string(),
            used: used.to_string(),
            use_percent: pct,
        });
    }
    out
}

fn parse_net_dev(s: &str) -> Vec<NetInterface> {
    // /proc/net/dev format:
    // Inter-|   Receive ...                              | Transmit
    //  face | bytes packets errs drop fifo frame compressed multicast | bytes packets ...
    //   eth0:  12345     67    0    0    0     0          0        0    9876     54 ...
    let mut out = Vec::new();
    for line in s.lines().skip(2) {
        let line = line.trim();
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let nums: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|t| t.parse::<u64>().ok())
            .collect();
        if nums.len() < 16 {
            continue;
        }
        out.push(NetInterface {
            name: name.trim().to_string(),
            rx_bytes: nums[0],
            rx_packets: nums[1],
            tx_bytes: nums[8],
            tx_packets: nums[9],
        });
    }
    out
}

fn parse_thermal(s: &str) -> Vec<ThermalZone> {
    let mut out = Vec::new();
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // "<type> <milli-degrees>"
        let mut it = line.rsplitn(2, char::is_whitespace);
        let m = it.next().unwrap_or("");
        let kind = it.next().unwrap_or("").trim();
        let Ok(milli) = m.parse::<i32>() else { continue };
        if kind.is_empty() {
            continue;
        }
        out.push(ThermalZone {
            name: kind.to_string(),
            celsius: milli as f32 / 1000.0,
        });
    }
    out
}

fn parse_cpuinfo(s: &str, governor: Option<String>, architecture: String) -> CpuInfo {
    let mut model = String::new();
    let mut vendor = String::new();
    let mut mhz = 0.0;
    let mut cache_kb = 0;
    let mut logical = 0;
    let mut cores_total = 0;
    let mut siblings_total = 0;
    let mut seen_physical_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut physical_cores_sum = 0u32;
    for block in s.split("\n\n") {
        let mut block_physical_id: Option<String> = None;
        let mut block_cores: u32 = 0;
        let mut block_siblings: u32 = 0;
        let mut had_processor = false;
        for line in block.lines() {
            let Some((k, v)) = line.split_once(':') else {
                continue;
            };
            let k = k.trim();
            let v = v.trim();
            match k {
                "processor" => {
                    logical += 1;
                    had_processor = true;
                }
                "model name" if model.is_empty() => model = v.to_string(),
                "vendor_id" if vendor.is_empty() => vendor = v.to_string(),
                "cpu MHz" => {
                    let f: f32 = v.parse().unwrap_or(0.0);
                    if f > mhz {
                        mhz = f;
                    }
                }
                "cache size" => {
                    // "8192 KB"
                    let n: u64 = v
                        .split_whitespace()
                        .next()
                        .and_then(|n| n.parse().ok())
                        .unwrap_or(0);
                    cache_kb = cache_kb.max(n);
                }
                "physical id" => block_physical_id = Some(v.to_string()),
                "cpu cores" => block_cores = v.parse().unwrap_or(0),
                "siblings" => block_siblings = v.parse().unwrap_or(0),
                _ => {}
            }
        }
        if had_processor {
            if let Some(pid) = block_physical_id {
                if seen_physical_ids.insert(pid) {
                    physical_cores_sum += block_cores;
                    cores_total += block_cores;
                    siblings_total += block_siblings;
                }
            }
        }
    }
    let _ = siblings_total;
    let physical = if physical_cores_sum > 0 {
        physical_cores_sum
    } else if cores_total > 0 {
        cores_total
    } else {
        logical
    };
    CpuInfo {
        model,
        vendor,
        physical_cores: physical,
        logical_cores: logical,
        mhz,
        cache_kb,
        governor,
        architecture,
    }
}

fn parse_dmidecode_memory(s: &str) -> Vec<DimmModule> {
    let mut out = Vec::new();
    let mut current: Option<DimmModule> = None;
    let mut in_block = false;
    for line in s.lines() {
        let trimmed = line.trim_end();
        if trimmed.starts_with("Memory Device") || trimmed.contains("Memory Device") {
            // Flush previous.
            if let Some(d) = current.take() {
                push_if_populated(&mut out, d);
            }
            current = Some(DimmModule {
                locator: String::new(),
                size: String::new(),
                kind: String::new(),
                speed: String::new(),
                manufacturer: String::new(),
                part_number: String::new(),
            });
            in_block = true;
            continue;
        }
        if !in_block {
            continue;
        }
        let Some(c) = current.as_mut() else { continue };
        let t = trimmed.trim();
        if let Some(v) = t.strip_prefix("Size:") {
            c.size = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("Locator:") {
            c.locator = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("Type:") {
            c.kind = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("Speed:") {
            // Prefer the first non-empty Speed (there's also Configured Memory Speed later).
            if c.speed.is_empty() || c.speed.to_lowercase().contains("unknown") {
                c.speed = v.trim().to_string();
            }
        } else if let Some(v) = t.strip_prefix("Manufacturer:") {
            c.manufacturer = v.trim().to_string();
        } else if let Some(v) = t.strip_prefix("Part Number:") {
            c.part_number = v.trim().to_string();
        }
    }
    if let Some(d) = current.take() {
        push_if_populated(&mut out, d);
    }
    out
}

fn push_if_populated(out: &mut Vec<DimmModule>, d: DimmModule) {
    // Skip empty slots (Size = "No Module Installed" / "0 GB").
    let empty = d.size.is_empty()
        || d.size.to_lowercase().contains("no module")
        || d.size == "0"
        || d.size.to_lowercase() == "0 mb";
    if !empty {
        out.push(d);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_stat() {
        let s = "cpu  100 0 50 800 10 0 5 0 0 0
cpu0 30 0 20 200 5 0 2 0 0 0
cpu1 70 0 30 600 5 0 3 0 0 0
intr 12345
procs_running 3
processes 999
";
        let (agg, cores, p) = parse_proc_stat(s);
        let agg = agg.expect("aggregate row");
        assert_eq!(agg.user, 100);
        assert_eq!(cores.len(), 2);
        assert_eq!(cores[0].core, 0);
        assert_eq!(cores[1].user, 70);
        assert_eq!(p.running, 3);
        assert_eq!(p.total, 999);
    }

    #[test]
    fn parses_meminfo() {
        let s = "MemTotal:       16000000 kB
MemFree:        2000000 kB
MemAvailable:   8000000 kB
Buffers:         100000 kB
Cached:         5000000 kB
SwapTotal:      4000000 kB
SwapFree:       3500000 kB
";
        let (m, sw) = parse_meminfo(s);
        assert_eq!(m.total_mb, 16000000 / 1024);
        assert_eq!(m.used_mb, (16000000 - 8000000) / 1024);
        assert_eq!(sw.total_mb, 4000000 / 1024);
        assert_eq!(sw.used_mb, (4000000 - 3500000) / 1024);
    }

    #[test]
    fn parses_loadavg() {
        let l = parse_loadavg("0.50 0.75 1.00 2/123 4567");
        assert!((l.one - 0.5).abs() < 0.001);
        assert!((l.fifteen - 1.0).abs() < 0.001);
    }

    #[test]
    fn parses_net_dev() {
        let s = "Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0:  12345     67    0    0    0     0          0        0    9876     54    0    0    0     0       0          0
    lo:    100      1    0    0    0     0          0        0     100      1    0    0    0     0       0          0
";
        let n = parse_net_dev(s);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].name, "eth0");
        assert_eq!(n[0].rx_bytes, 12345);
        assert_eq!(n[0].tx_bytes, 9876);
    }

    #[test]
    fn parses_thermal() {
        let s = "x86_pkg_temp 62000\nacpitz 48500\n";
        let t = parse_thermal(s);
        assert_eq!(t.len(), 2);
        assert!((t[0].celsius - 62.0).abs() < 0.01);
        assert_eq!(t[1].name, "acpitz");
    }

    #[test]
    fn parses_dmidecode() {
        let s = r#"
Memory Device
	Total Width: 64 bits
	Size: 8 GB
	Locator: ChannelA-DIMM0
	Type: DDR4
	Speed: 3200 MT/s
	Manufacturer: Samsung
	Part Number: M471A1K43DB1-CTD
	Configured Memory Speed: 3200 MT/s

Memory Device
	Size: No Module Installed
	Locator: ChannelB-DIMM0
"#;
        let d = parse_dmidecode_memory(s);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].size, "8 GB");
        assert_eq!(d[0].manufacturer, "Samsung");
        assert_eq!(d[0].part_number, "M471A1K43DB1-CTD");
    }
}

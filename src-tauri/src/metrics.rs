use serde::Serialize;

use crate::devices::Device;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, SessionPool};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub cpu_percent: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub disks: Vec<DiskUsage>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub mount: String,
    pub total: String,
    pub used: String,
    pub use_percent: f32,
}

pub fn snapshot(pool: &SessionPool, device: &Device) -> AppResult<MetricsSnapshot> {
    // One round-trip: collect everything in a single shell command, parse locally.
    let cmd = "echo '##CPUMEM##'; top -bn1 -w512 | head -5; echo '##DF##'; df -h --output=target,size,used,pcent -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -h";
    let out = ssh::run_command(pool, device, cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Ssh(format!(
            "metrics exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }

    let (cpu_section, df_section) = split_sections(&out.stdout);
    let (cpu_percent, mem_used_mb, mem_total_mb) = parse_cpu_mem(cpu_section);
    let disks = parse_df(df_section);

    Ok(MetricsSnapshot {
        cpu_percent,
        mem_used_mb,
        mem_total_mb,
        disks,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    })
}

fn split_sections(s: &str) -> (&str, &str) {
    let cpu_start = s.find("##CPUMEM##").map(|i| i + "##CPUMEM##".len()).unwrap_or(0);
    let df_marker = s.find("##DF##").unwrap_or(s.len());
    let df_start = df_marker + "##DF##".len();
    let cpu = &s[cpu_start..df_marker.min(s.len())];
    let df = if df_start <= s.len() {
        &s[df_start..]
    } else {
        ""
    };
    (cpu, df)
}

/// Parse the first 5 lines of `top -bn1`. Looks for the "Cpu(s)" line and the
/// "MiB Mem" / "KiB Mem" line. Tolerant of locale variations.
fn parse_cpu_mem(s: &str) -> (f32, u64, u64) {
    let mut cpu = 0.0;
    let mut used = 0u64;
    let mut total = 0u64;

    for line in s.lines() {
        let l = line.trim();
        if l.starts_with("%Cpu(s):") || l.starts_with("Cpu(s):") {
            // Format: "%Cpu(s):  3.1 us,  1.4 sy,  0.0 ni, 95.4 id, ..."
            // We compute 100 - idle.
            if let Some(idle) = extract_field(l, "id") {
                cpu = (100.0 - idle).clamp(0.0, 100.0);
            }
        } else if l.starts_with("MiB Mem") || l.starts_with("MiB Memory") {
            // "MiB Mem :  15843.4 total,   2104.3 free,   8410.5 used, ..."
            total = extract_field(l, "total").map(|v| v as u64).unwrap_or(0);
            used = extract_field(l, "used").map(|v| v as u64).unwrap_or(0);
        } else if l.starts_with("KiB Mem") {
            total = extract_field(l, "total").map(|v| (v / 1024.0) as u64).unwrap_or(0);
            used = extract_field(l, "used").map(|v| (v / 1024.0) as u64).unwrap_or(0);
        }
    }

    (cpu, used, total)
}

/// Extract a number that appears immediately before `label` in a line like
/// "  3.1 us, 95.4 id, ...". Returns None if not found.
fn extract_field(line: &str, label: &str) -> Option<f32> {
    let idx = line.find(label)?;
    let prefix = &line[..idx];
    let token = prefix
        .split(|c: char| c == ',' || c.is_whitespace())
        .rfind(|s| !s.is_empty())?;
    token.parse::<f32>().ok()
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
        // Either "Mounted on Size Used Use%" (custom output) or full df:
        // Filesystem Size Used Avail Use% Mounted on
        let (mount, total, used, pct_str) = if cols.len() == 4 {
            (cols[0], cols[1], cols[2], cols[3])
        } else if cols.len() >= 6 {
            (cols[5], cols[1], cols[2], cols[4])
        } else {
            continue;
        };
        let pct = pct_str
            .trim_end_matches('%')
            .parse::<f32>()
            .unwrap_or(0.0);
        out.push(DiskUsage {
            mount: mount.to_string(),
            total: total.to_string(),
            used: used.to_string(),
            use_percent: pct,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_top_cpu_idle() {
        let sample = "%Cpu(s):  3.1 us,  1.4 sy,  0.0 ni, 95.4 id,  0.0 wa,  0.0 hi,  0.1 si,  0.0 st";
        let (cpu, _, _) = parse_cpu_mem(sample);
        assert!((cpu - 4.6).abs() < 0.1, "got {cpu}");
    }

    #[test]
    fn parses_top_mem_mib() {
        let sample = "MiB Mem :  15843.4 total,   2104.3 free,   8410.5 used,   5328.6 buff/cache";
        let (_, used, total) = parse_cpu_mem(sample);
        assert_eq!(total, 15843);
        assert_eq!(used, 8410);
    }

    #[test]
    fn parses_df_custom_output() {
        let sample = "Mounted on Size Used Use%\n/ 100G 60G 60%\n/home 200G 80G 40%";
        let disks = parse_df(sample);
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[0].mount, "/");
        assert!((disks[0].use_percent - 60.0).abs() < 0.01);
    }
}

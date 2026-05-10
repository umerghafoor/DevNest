use serde::{Deserialize, Serialize};

use crate::devices::Device;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, SessionPool};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailnetPeer {
    pub tailscale_ips: Vec<String>,
    pub host_name: String,
    pub dns_name: String,
    pub online: bool,
    pub is_exit_node: bool,
    pub is_self: bool,
    pub os: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailnetStatus {
    pub self_node: Option<TailnetPeer>,
    pub peers: Vec<TailnetPeer>,
    pub current_exit_node: Option<String>,
    pub available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawStatus {
    #[serde(rename = "Self")]
    self_node: Option<RawPeer>,
    peer: Option<std::collections::HashMap<String, RawPeer>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPeer {
    tailscale_i_ps: Option<Vec<String>>,
    host_name: Option<String>,
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    online: Option<bool>,
    exit_node: Option<bool>,
    exit_node_option: Option<bool>,
    #[serde(rename = "OS")]
    os: Option<String>,
    tags: Option<Vec<String>>,
}

pub fn status(pool: &SessionPool, device: &Device) -> AppResult<TailnetStatus> {
    let out = ssh::run_command(pool, device, "tailscale status --json 2>/dev/null")?;

    if out.exit_code != 0 || out.stdout.trim().is_empty() {
        return Ok(TailnetStatus {
            self_node: None,
            peers: vec![],
            current_exit_node: None,
            available: false,
        });
    }

    let raw: RawStatus = serde_json::from_str(out.stdout.trim())
        .map_err(|e| AppError::Ssh(format!("parse tailscale status: {e}")))?;

    let to_peer = |p: &RawPeer, is_self: bool| TailnetPeer {
        tailscale_ips: p.tailscale_i_ps.clone().unwrap_or_default(),
        host_name: p.host_name.clone().unwrap_or_default(),
        dns_name: p.dns_name.clone().unwrap_or_default(),
        online: p.online.unwrap_or(false),
        is_exit_node: p.exit_node_option.unwrap_or(false),
        is_self,
        os: p.os.clone().unwrap_or_default(),
        tags: p.tags.clone().unwrap_or_default(),
    };

    let self_node = raw.self_node.as_ref().map(|p| to_peer(p, true));

    let mut peers = Vec::new();
    let mut current_exit_node: Option<String> = None;

    if let Some(peer_map) = &raw.peer {
        for p in peer_map.values() {
            if p.exit_node.unwrap_or(false) {
                current_exit_node = p.host_name.clone();
            }
            peers.push(to_peer(p, false));
        }
    }

    peers.sort_by(|a, b| a.host_name.cmp(&b.host_name));

    Ok(TailnetStatus {
        self_node,
        peers,
        current_exit_node,
        available: true,
    })
}

pub fn set_exit_node(
    pool: &SessionPool,
    device: &Device,
    exit_node: Option<&str>,
) -> AppResult<()> {
    let target = exit_node.unwrap_or("");
    let cmd = format!("tailscale set --exit-node={target}");
    let out = ssh::run_command(pool, device, &cmd)?;
    if out.exit_code != 0 {
        return Err(AppError::Ssh(format!(
            "tailscale set exit-node: {}",
            out.stderr.trim()
        )));
    }
    Ok(())
}

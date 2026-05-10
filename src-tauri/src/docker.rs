use serde::{Deserialize, Serialize};

use crate::devices::Device;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, CommandOutput, SessionPool};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created: String,
}

#[derive(Debug, Deserialize)]
struct DockerPsLine {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names")]
    names: String,
    #[serde(rename = "Image")]
    image: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "Ports")]
    ports: String,
    #[serde(rename = "CreatedAt")]
    created: String,
}

pub fn list_containers(pool: &SessionPool, device: &Device) -> AppResult<Vec<ContainerSummary>> {
    let out = ssh::run_command(
        pool,
        device,
        "docker ps -a --no-trunc --format '{{json .}}'",
    )?;
    if out.exit_code != 0 {
        return Err(AppError::Ssh(format!(
            "docker ps exit {}: {}",
            out.exit_code,
            out.stderr.trim()
        )));
    }

    let mut containers = Vec::new();
    for line in out.stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: DockerPsLine = serde_json::from_str(trimmed)
            .map_err(|e| AppError::Ssh(format!("parse docker ps line: {e}")))?;
        containers.push(ContainerSummary {
            id: parsed.id,
            name: parsed.names,
            image: parsed.image,
            state: parsed.state,
            status: parsed.status,
            ports: parsed.ports,
            created: parsed.created,
        });
    }
    Ok(containers)
}

pub fn action(
    pool: &SessionPool,
    device: &Device,
    container_id: &str,
    action: &str,
) -> AppResult<CommandOutput> {
    let action = match action {
        "start" | "stop" | "restart" => action,
        "remove" => "rm -f",
        other => return Err(AppError::Invalid(format!("unknown action {other}"))),
    };
    if !is_safe_id(container_id) {
        return Err(AppError::Invalid("invalid container id".into()));
    }
    let cmd = format!("docker {action} {container_id}");
    ssh::run_command(pool, device, &cmd)
}

pub fn logs(
    pool: &SessionPool,
    device: &Device,
    container_id: &str,
    tail: u32,
) -> AppResult<String> {
    if !is_safe_id(container_id) {
        return Err(AppError::Invalid("invalid container id".into()));
    }
    let cmd = format!("docker logs --tail {tail} {container_id} 2>&1");
    let out = ssh::run_command(pool, device, &cmd)?;
    Ok(out.stdout)
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

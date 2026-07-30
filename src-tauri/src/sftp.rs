use serde::Serialize;
use std::net::TcpStream;
use std::time::Duration;

use crate::devices::Device;
use crate::error::{AppError, AppResult};
use crate::secrets;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub permissions: String,
}

fn open_sftp(device: &Device) -> AppResult<ssh2::Sftp> {
    let addr = format!("{}:{}", device.host, device.port);
    let tcp = TcpStream::connect_timeout(
        &{
            use std::net::ToSocketAddrs;
            addr.to_socket_addrs()
                .map_err(|e| AppError::Ssh(format!("resolve: {e}")))?
                .next()
                .ok_or_else(|| AppError::Ssh(format!("no addr for {addr}")))?
        },
        Duration::from_secs(8),
    )
    .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;

    let mut session = ssh2::Session::new().map_err(|e| AppError::Ssh(e.to_string()))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| AppError::Ssh(format!("handshake: {e}")))?;

    match device.auth_type {
        crate::devices::AuthType::Key => {
            let key: std::path::PathBuf = device
                .key_path
                .clone()
                .ok_or_else(|| AppError::Invalid("key_path missing".into()))?
                .into();
            let pass = secrets::get(&device.id).ok();
            session
                .userauth_pubkey_file(&device.username, None, &key, pass.as_deref())
                .map_err(|e| AppError::Ssh(format!("pubkey auth: {e}")))?;
        }
        crate::devices::AuthType::Password => {
            let pw =
                secrets::get(&device.id).map_err(|e| AppError::Ssh(format!("no password: {e}")))?;
            session
                .userauth_password(&device.username, &pw)
                .map_err(|e| AppError::Ssh(format!("password auth: {e}")))?;
        }
        crate::devices::AuthType::Localhost => {
            return Err(AppError::Invalid(
                "SFTP not available for localhost — use local fs".into(),
            ));
        }
    }

    session
        .sftp()
        .map_err(|e| AppError::Ssh(format!("sftp subsystem: {e}")))
}

pub fn list_dir(device: &Device, path: &str) -> AppResult<Vec<FileEntry>> {
    let sftp = open_sftp(device)?;
    let entries = sftp
        .readdir(std::path::Path::new(path))
        .map_err(|e| AppError::Ssh(format!("readdir {path}: {e}")))?;

    let mut out: Vec<FileEntry> = entries
        .into_iter()
        .map(|(p, stat)| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let perms = format!("{:o}", stat.perm.unwrap_or(0) & 0o777);
            FileEntry {
                path: p.to_string_lossy().into_owned(),
                name,
                is_dir: stat.is_dir(),
                size: stat.size.unwrap_or(0),
                modified: stat.mtime.map(|t| t as i64).unwrap_or(0),
                permissions: perms,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub fn read_file(device: &Device, path: &str) -> AppResult<String> {
    let sftp = open_sftp(device)?;
    let mut f = sftp
        .open(std::path::Path::new(path))
        .map_err(|e| AppError::Ssh(format!("open {path}: {e}")))?;
    let mut buf = Vec::new();
    use std::io::Read;
    f.read_to_end(&mut buf)
        .map_err(|e| AppError::Ssh(format!("read {path}: {e}")))?;

    if buf.len() > 2 * 1024 * 1024 {
        return Err(AppError::Invalid("file too large (>2 MB)".into()));
    }
    String::from_utf8(buf).map_err(|_| AppError::Invalid("file is not valid UTF-8".into()))
}

pub fn write_file(device: &Device, path: &str, content: &str) -> AppResult<()> {
    let sftp = open_sftp(device)?;
    let mut f = sftp
        .create(std::path::Path::new(path))
        .map_err(|e| AppError::Ssh(format!("create {path}: {e}")))?;
    use std::io::Write;
    f.write_all(content.as_bytes())
        .map_err(|e| AppError::Ssh(format!("write {path}: {e}")))
}

pub fn mkdir(device: &Device, path: &str) -> AppResult<()> {
    let sftp = open_sftp(device)?;
    sftp.mkdir(std::path::Path::new(path), 0o755)
        .map_err(|e| AppError::Ssh(format!("mkdir {path}: {e}")))
}

pub fn rename(device: &Device, from: &str, to: &str) -> AppResult<()> {
    let sftp = open_sftp(device)?;
    sftp.rename(
        std::path::Path::new(from),
        std::path::Path::new(to),
        Some(ssh2::RenameFlags::OVERWRITE),
    )
    .map_err(|e| AppError::Ssh(format!("rename {from} → {to}: {e}")))
}

pub fn delete(device: &Device, path: &str, is_dir: bool) -> AppResult<()> {
    let sftp = open_sftp(device)?;
    if is_dir {
        sftp.rmdir(std::path::Path::new(path))
            .map_err(|e| AppError::Ssh(format!("rmdir {path}: {e}")))?;
    } else {
        sftp.unlink(std::path::Path::new(path))
            .map_err(|e| AppError::Ssh(format!("unlink {path}: {e}")))?;
    }
    Ok(())
}

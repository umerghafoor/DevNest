use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::sftp::FileEntry;

const MAX_READ_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB

#[tauri::command(async)]
pub fn fs_read_text(path: String) -> AppResult<String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| AppError::Invalid(format!("stat {path}: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::Invalid(format!("not a file: {path}")));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(AppError::Invalid(format!(
            "file too large ({} bytes); editor caps at {}",
            meta.len(),
            MAX_READ_BYTES
        )));
    }
    fs::read_to_string(p).map_err(|e| AppError::Invalid(format!("read {path}: {e}")))
}

#[tauri::command(async)]
pub fn fs_write_text(path: String, content: String) -> AppResult<()> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::Invalid(format!(
                "parent does not exist: {}",
                parent.display()
            )));
        }
    }
    fs::write(p, content).map_err(|e| AppError::Invalid(format!("write {path}: {e}")))
}

// ─── File-browser operations (reused by SFTP commands for localhost) ─────────

pub fn list_dir(path: &str) -> AppResult<Vec<FileEntry>> {
    let p = Path::new(path);
    let read = fs::read_dir(p).map_err(|e| AppError::Invalid(format!("readdir {path}: {e}")))?;
    let mut out: Vec<FileEntry> = Vec::new();
    for entry in read.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        // Use symlink_metadata so symlinks themselves are reported (matches SFTP).
        let meta = match fs::symlink_metadata(&entry_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            format!("{:o}", meta.permissions().mode() & 0o777)
        };
        #[cfg(not(unix))]
        let permissions = if meta.permissions().readonly() {
            "444".to_string()
        } else {
            "644".to_string()
        };
        out.push(FileEntry {
            path: entry_path.to_string_lossy().into_owned(),
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
            modified,
            permissions,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub fn read_file(path: &str) -> AppResult<String> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| AppError::Invalid(format!("stat {path}: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::Invalid(format!("not a file: {path}")));
    }
    // Match the SFTP read_file 2 MB cap so the editor stays snappy.
    if meta.len() > 2 * 1024 * 1024 {
        return Err(AppError::Invalid("file too large (>2 MB)".into()));
    }
    let buf = fs::read(p).map_err(|e| AppError::Invalid(format!("read {path}: {e}")))?;
    String::from_utf8(buf).map_err(|_| AppError::Invalid("file is not valid UTF-8".into()))
}

pub fn write_file(path: &str, content: &str) -> AppResult<()> {
    fs::write(path, content).map_err(|e| AppError::Invalid(format!("write {path}: {e}")))
}

pub fn mkdir(path: &str) -> AppResult<()> {
    fs::create_dir_all(path).map_err(|e| AppError::Invalid(format!("mkdir {path}: {e}")))
}

pub fn rename(from: &str, to: &str) -> AppResult<()> {
    fs::rename(from, to).map_err(|e| AppError::Invalid(format!("rename {from} → {to}: {e}")))
}

pub fn delete(path: &str, is_dir: bool) -> AppResult<()> {
    if is_dir {
        fs::remove_dir_all(path).map_err(|e| AppError::Invalid(format!("rmdir {path}: {e}")))
    } else {
        fs::remove_file(path).map_err(|e| AppError::Invalid(format!("unlink {path}: {e}")))
    }
}

// ─── Raw byte transfer & disk usage ─────────────────────────────────────────

use crate::sftp::DiskUsageNode;

pub fn download_file_bytes(path: &str) -> AppResult<Vec<u8>> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| AppError::Invalid(format!("stat {path}: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::Invalid(format!("not a file: {path}")));
    }
    if meta.len() > 100 * 1024 * 1024 {
        return Err(AppError::Invalid("file too large (>100 MB)".into()));
    }
    fs::read(p).map_err(|e| AppError::Invalid(format!("read {path}: {e}")))
}

pub fn upload_file_bytes(path: &str, data: &[u8]) -> AppResult<()> {
    let p = Path::new(path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::Invalid(format!(
                "parent does not exist: {}",
                parent.display()
            )));
        }
    }
    fs::write(p, data).map_err(|e| AppError::Invalid(format!("write {path}: {e}")))
}

pub fn disk_usage(path: &str, max_depth: u32) -> AppResult<DiskUsageNode> {
    let root = Path::new(path);
    let meta =
        fs::symlink_metadata(root).map_err(|e| AppError::Invalid(format!("stat {path}: {e}")))?;
    if !meta.is_dir() {
        return Ok(DiskUsageNode {
            name: root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string()),
            path: path.to_string(),
            size: meta.len(),
            children: Vec::new(),
        });
    }
    scan_dir(root, 0, max_depth)
}

fn scan_dir(dir: &Path, depth: u32, max_depth: u32) -> AppResult<DiskUsageNode> {
    let mut children = Vec::new();
    let mut size: u64 = 0;

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let meta = match fs::symlink_metadata(&entry_path) {
                Ok(m) => m,
                Err(_) => continue,
            };

            if meta.is_dir() && depth < max_depth {
                match scan_dir(&entry_path, depth + 1, max_depth) {
                    Ok(child) => {
                        size += child.size;
                        children.push(child);
                    }
                    Err(_) => continue,
                }
            } else if meta.is_file() {
                let file_size = meta.len();
                size += file_size;
                if depth < max_depth {
                    children.push(DiskUsageNode {
                        name: entry
                            .file_name()
                            .to_string_lossy()
                            .into_owned(),
                        path: entry_path.to_string_lossy().into_owned(),
                        size: file_size,
                        children: Vec::new(),
                    });
                }
            } else {
                // Symlink or other — count size but don't recurse.
                size += meta.len();
            }
        }
    }

    children.sort_by(|a, b| b.size.cmp(&a.size));

    Ok(DiskUsageNode {
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| dir.to_string_lossy().into_owned()),
        path: dir.to_string_lossy().into_owned(),
        size,
        children,
    })
}

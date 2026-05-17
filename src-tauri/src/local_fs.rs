use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::sftp::FileEntry;

const MAX_READ_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB

#[tauri::command]
pub fn fs_read_text(path: String) -> AppResult<String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p)
        .map_err(|e| AppError::Invalid(format!("stat {path}: {e}")))?;
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

#[tauri::command]
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
    let read = fs::read_dir(p)
        .map_err(|e| AppError::Invalid(format!("readdir {path}: {e}")))?;
    let mut out: Vec<FileEntry> = Vec::new();
    for entry in read.flatten() {
        let entry_path = entry.path();
        let name = entry
            .file_name()
            .to_string_lossy()
            .into_owned();
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
    let meta = fs::metadata(p)
        .map_err(|e| AppError::Invalid(format!("stat {path}: {e}")))?;
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
        fs::remove_dir_all(path)
            .map_err(|e| AppError::Invalid(format!("rmdir {path}: {e}")))
    } else {
        fs::remove_file(path)
            .map_err(|e| AppError::Invalid(format!("unlink {path}: {e}")))
    }
}

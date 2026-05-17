use std::fs;
use std::path::Path;

use crate::error::{AppError, AppResult};

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

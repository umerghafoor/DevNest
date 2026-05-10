use crate::error::{AppError, AppResult};

const SERVICE: &str = "devnest";

pub fn set(id: &str, secret: &str) -> AppResult<()> {
    let entry =
        keyring::Entry::new(SERVICE, id).map_err(|e| AppError::Ssh(format!("keyring: {e}")))?;
    entry
        .set_password(secret)
        .map_err(|e| AppError::Ssh(format!("keyring set: {e}")))
}

pub fn get(id: &str) -> AppResult<String> {
    let entry =
        keyring::Entry::new(SERVICE, id).map_err(|e| AppError::Ssh(format!("keyring: {e}")))?;
    entry
        .get_password()
        .map_err(|e| AppError::Ssh(format!("keyring get: {e}")))
}

pub fn delete(id: &str) -> AppResult<()> {
    let entry =
        keyring::Entry::new(SERVICE, id).map_err(|e| AppError::Ssh(format!("keyring: {e}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Ssh(format!("keyring delete: {e}"))),
    }
}

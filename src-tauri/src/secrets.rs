use crate::error::{AppError, AppResult};

const AUTH_SERVICE: &str = "devnest";
const SUDO_SERVICE: &str = "devnest-sudo";
const GITHUB_SERVICE: &str = "devnest-github";
const GITHUB_TOKEN_ID: &str = "oauth-token";
const SQL_SERVICE: &str = "devnest-sql";

fn entry(service: &str, id: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(service, id).map_err(|e| AppError::Ssh(format!("keyring: {e}")))
}

pub fn set(id: &str, secret: &str) -> AppResult<()> {
    entry(AUTH_SERVICE, id)?
        .set_password(secret)
        .map_err(|e| AppError::Ssh(format!("keyring set: {e}")))
}

pub fn get(id: &str) -> AppResult<String> {
    entry(AUTH_SERVICE, id)?
        .get_password()
        .map_err(|e| AppError::Ssh(format!("keyring get: {e}")))
}

pub fn delete(id: &str) -> AppResult<()> {
    delete_from(AUTH_SERVICE, id)?;
    delete_from(SUDO_SERVICE, id)?;
    Ok(())
}

pub fn set_sudo(id: &str, secret: &str) -> AppResult<()> {
    entry(SUDO_SERVICE, id)?
        .set_password(secret)
        .map_err(|e| AppError::Ssh(format!("keyring set sudo: {e}")))
}

pub fn get_sudo(id: &str) -> AppResult<Option<String>> {
    match entry(SUDO_SERVICE, id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Ssh(format!("keyring get sudo: {e}"))),
    }
}

pub fn delete_sudo(id: &str) -> AppResult<()> {
    delete_from(SUDO_SERVICE, id)
}

pub fn set_github_token(token: &str) -> AppResult<()> {
    entry(GITHUB_SERVICE, GITHUB_TOKEN_ID)?
        .set_password(token)
        .map_err(|e| AppError::Ssh(format!("keyring set github: {e}")))
}

pub fn get_github_token() -> AppResult<String> {
    entry(GITHUB_SERVICE, GITHUB_TOKEN_ID)?
        .get_password()
        .map_err(|e| AppError::Ssh(format!("keyring get github: {e}")))
}

pub fn delete_github_token() -> AppResult<()> {
    delete_from(GITHUB_SERVICE, GITHUB_TOKEN_ID)
}

pub fn set_sql(id: &str, secret: &str) -> AppResult<()> {
    entry(SQL_SERVICE, id)?
        .set_password(secret)
        .map_err(|e| AppError::Ssh(format!("keyring set sql: {e}")))
}

pub fn get_sql(id: &str) -> AppResult<Option<String>> {
    match entry(SQL_SERVICE, id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Ssh(format!("keyring get sql: {e}"))),
    }
}

pub fn delete_sql(id: &str) -> AppResult<()> {
    delete_from(SQL_SERVICE, id)
}

fn delete_from(service: &str, id: &str) -> AppResult<()> {
    let e = entry(service, id)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Ssh(format!("keyring delete: {e}"))),
    }
}

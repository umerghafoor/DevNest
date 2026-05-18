use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::secrets;

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeRaw {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GhRepo {
    pub id: u64,
    pub name: String,
    #[serde(rename = "full_name")]
    pub full_name: String,
    pub description: Option<String>,
    pub private: bool,
    #[serde(rename = "html_url")]
    pub html_url: String,
    #[serde(rename = "clone_url")]
    pub clone_url: String,
    #[serde(rename = "ssh_url")]
    pub ssh_url: String,
    #[serde(rename = "default_branch")]
    pub default_branch: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GhUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("DevNest/0.1")
        .build()
        .expect("reqwest client builds")
}

/// Start GitHub device-code flow. Returns the user code and verification URL.
#[tauri::command]
pub async fn github_device_start(client_id: String) -> AppResult<DeviceCodeResponse> {
    if client_id.trim().is_empty() {
        return Err(AppError::Invalid(
            "GitHub client ID is not configured".into(),
        ));
    }
    let res = client()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", "repo read:user")])
        .send()
        .await
        .map_err(|e| AppError::Ssh(format!("github device start: {e}")))?;

    if !res.status().is_success() {
        return Err(AppError::Ssh(format!(
            "github device start returned {}",
            res.status()
        )));
    }
    let raw: DeviceCodeRaw = res
        .json()
        .await
        .map_err(|e| AppError::Ssh(format!("github device start decode: {e}")))?;
    Ok(DeviceCodeResponse {
        device_code: raw.device_code,
        user_code: raw.user_code,
        verification_uri: raw.verification_uri,
        expires_in: raw.expires_in,
        interval: raw.interval,
    })
}

/// Poll for the access token once. Returns:
/// - Ok(Some(token)) when authorized (and stores it in keyring).
/// - Ok(None) when still pending — caller should wait `interval` seconds and retry.
/// - Err on hard failure.
#[tauri::command]
pub async fn github_device_poll(
    client_id: String,
    device_code: String,
) -> AppResult<Option<String>> {
    let res = client()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code",
            ),
        ])
        .send()
        .await
        .map_err(|e| AppError::Ssh(format!("github device poll: {e}")))?;

    let body: TokenResponse = res
        .json()
        .await
        .map_err(|e| AppError::Ssh(format!("github device poll decode: {e}")))?;

    if let Some(token) = body.access_token {
        secrets::set_github_token(&token)?;
        return Ok(Some(token));
    }
    match body.error.as_deref() {
        Some("authorization_pending") | Some("slow_down") => Ok(None),
        Some(other) => Err(AppError::Ssh(format!("github auth: {other}"))),
        None => Err(AppError::Ssh("github auth: unknown response".into())),
    }
}

#[tauri::command]
pub fn github_signed_in() -> AppResult<bool> {
    Ok(secrets::get_github_token().ok().is_some())
}

#[tauri::command]
pub fn github_sign_out() -> AppResult<()> {
    secrets::delete_github_token()
}

#[tauri::command]
pub async fn github_user() -> AppResult<GhUser> {
    let token = secrets::get_github_token()?;
    let res = client()
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Ssh(format!("github user: {e}")))?;

    if !res.status().is_success() {
        return Err(AppError::Ssh(format!(
            "github user returned {}",
            res.status()
        )));
    }
    res.json::<GhUser>()
        .await
        .map_err(|e| AppError::Ssh(format!("github user decode: {e}")))
}

#[tauri::command]
pub async fn github_list_repos() -> AppResult<Vec<GhRepo>> {
    let token = secrets::get_github_token()?;
    let mut all: Vec<GhRepo> = Vec::new();
    let mut page: u32 = 1;
    loop {
        let res = client()
            .get("https://api.github.com/user/repos")
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .query(&[
                ("per_page", "100"),
                ("page", &page.to_string()),
                ("sort", "pushed"),
                ("affiliation", "owner,collaborator,organization_member"),
            ])
            .send()
            .await
            .map_err(|e| AppError::Ssh(format!("github repos: {e}")))?;

        if !res.status().is_success() {
            return Err(AppError::Ssh(format!(
                "github repos returned {}",
                res.status()
            )));
        }
        let batch: Vec<GhRepo> = res
            .json()
            .await
            .map_err(|e| AppError::Ssh(format!("github repos decode: {e}")))?;
        let n = batch.len();
        all.extend(batch);
        if n < 100 || page >= 10 {
            break;
        }
        page += 1;
    }
    Ok(all)
}


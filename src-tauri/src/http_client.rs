/// Pragmatic HTTP request runner. Lets the frontend send arbitrary HTTP
/// requests through Rust (so CORS doesn't apply and the response body is
/// available verbatim).
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestSpec {
    pub method: String,
    pub url: String,
    /// `[name, value]` pairs. Duplicates are allowed.
    pub headers: Vec<(String, String)>,
    /// Raw body. Empty string ⇒ no body.
    pub body: String,
    /// Total request timeout in milliseconds. Defaults to 30_000.
    pub timeout_ms: Option<u64>,
    /// Follow redirects automatically. Defaults to true.
    pub follow_redirects: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// True when the body wasn't valid UTF-8; in that case we hand back a
    /// hex-summary so the UI can show *something* without crashing.
    pub binary: bool,
    pub elapsed_ms: u64,
    pub final_url: String,
}

#[tauri::command(async)]
pub async fn http_request(spec: HttpRequestSpec) -> AppResult<HttpResponse> {
    let timeout = std::time::Duration::from_millis(spec.timeout_ms.unwrap_or(30_000));
    let follow = spec.follow_redirects.unwrap_or(true);

    let client = reqwest::Client::builder()
        .user_agent("DevNest/0.1 (http-runner)")
        .timeout(timeout)
        .redirect(if follow {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        })
        .build()
        .map_err(|e| AppError::Invalid(format!("http client: {e}")))?;

    let method = reqwest::Method::from_bytes(spec.method.to_uppercase().as_bytes())
        .map_err(|_| AppError::Invalid(format!("bad method: {}", spec.method)))?;

    let mut req = client.request(method, &spec.url);
    for (name, value) in &spec.headers {
        if name.trim().is_empty() {
            continue;
        }
        req = req.header(name, value);
    }
    if !spec.body.is_empty() {
        req = req.body(spec.body.clone());
    }

    let started = Instant::now();
    let res = req
        .send()
        .await
        .map_err(|e| AppError::Invalid(format!("http send: {e}")))?;

    let status = res.status();
    let final_url = res.url().to_string();
    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let bytes = res
        .bytes()
        .await
        .map_err(|e| AppError::Invalid(format!("http body: {e}")))?;

    let (body, binary) = match std::str::from_utf8(&bytes) {
        Ok(s) => (s.to_string(), false),
        Err(_) => {
            // Hand back a 2 KB hex preview rather than nothing.
            let preview: String = bytes
                .iter()
                .take(2048)
                .map(|b| format!("{b:02x}"))
                .collect();
            (
                format!("<binary, {} bytes>\nhex: {preview}", bytes.len()),
                true,
            )
        }
    };

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
        binary,
        elapsed_ms: started.elapsed().as_millis() as u64,
        final_url,
    })
}

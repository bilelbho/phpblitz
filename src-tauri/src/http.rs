//! The HTTP Client (.http files): sends one request as written and returns the response as it
//! came. From here rather than the web view, so any header can be set and no CORS rules apply.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};

/// Bodies past this size are cut off (the response viewer would choke on them anyway).
const MAX_BODY: usize = 20 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    /// The body as bytes (a file sent with `< ./photo.png`), base64.
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
    follow_redirects: bool,
    /// Self-signed certificates (a local https dev server).
    insecure: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    http_version: String,
    /// After redirects.
    url: String,
    headers: Vec<(String, String)>,
    /// The body as text, or base64 when it isn't text (`binary`).
    body: String,
    binary: bool,
    truncated: bool,
    size: usize,
    time_ms: u64,
}

/// Clients by (follow redirects, accept any certificate): connections are reused between requests.
#[derive(Default)]
pub struct HttpState {
    clients: Mutex<HashMap<(bool, bool), reqwest::Client>>,
}

impl HttpState {
    fn client(&self, follow: bool, insecure: bool) -> Result<reqwest::Client, String> {
        let mut clients = self.clients.lock().map_err(|e| e.to_string())?;
        if let Some(c) = clients.get(&(follow, insecure)) {
            return Ok(c.clone());
        }
        // reqwest is built without a TLS crypto provider of its own (see ai.rs): ring's.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .redirect(if follow { reqwest::redirect::Policy::limited(10) } else { reqwest::redirect::Policy::none() })
            .danger_accept_invalid_certs(insecure)
            .user_agent(concat!("PHPBlitz/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        clients.insert((follow, insecure), client.clone());
        Ok(client)
    }
}

#[tauri::command]
pub async fn http_send(state: tauri::State<'_, HttpState>, request: HttpRequest) -> Result<HttpResponse, String> {
    let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes()).map_err(|_| format!("Not an HTTP method: {}", request.method))?;
    let url = reqwest::Url::parse(&request.url).map_err(|e| format!("Not a URL: {} ({e})", request.url))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Only http and https URLs can be requested, not {}:", url.scheme()));
    }
    let client = state.client(request.follow_redirects, request.insecure)?;
    let mut builder = client.request(method, url);
    for (name, value) in &request.headers {
        builder = builder.header(name.trim(), value.trim());
    }
    if let Some(b64) = &request.body_base64 {
        builder = builder.body(base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?);
    } else if let Some(body) = request.body {
        builder = builder.body(body);
    }
    builder = builder.timeout(Duration::from_millis(request.timeout_ms.unwrap_or(60_000)));

    let start = Instant::now();
    let mut response = builder.send().await.map_err(describe)?;
    let status = response.status();
    let http_version = format!("{:?}", response.version());
    let final_url = response.url().to_string();
    let headers = response.headers().iter().map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect::<Vec<_>>();
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();

    let mut bytes: Vec<u8> = Vec::new();
    let mut size = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(describe)? {
        size += chunk.len();
        if bytes.len() < MAX_BODY {
            let room = MAX_BODY - bytes.len();
            bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
        }
    }
    let time_ms = start.elapsed().as_millis() as u64;
    let truncated = size > bytes.len();
    // Text when the type says so, or when it's valid UTF-8 without a type that says otherwise.
    let texty = content_type.starts_with("text/")
        || ["json", "xml", "javascript", "html", "x-www-form-urlencoded", "yaml", "csv", "graphql"].iter().any(|t| content_type.contains(t));
    let binary_type =
        ["image/", "audio/", "video/", "font/", "application/pdf", "application/zip", "application/octet-stream"].iter().any(|t| content_type.starts_with(t));
    let (body, binary) = match String::from_utf8(bytes) {
        Ok(text) if texty || !binary_type => (text, false),
        Ok(text) => (base64::engine::general_purpose::STANDARD.encode(text.as_bytes()), true),
        Err(e) if texty => (String::from_utf8_lossy(e.as_bytes()).into_owned(), false),
        Err(e) => (base64::engine::general_purpose::STANDARD.encode(e.as_bytes()), true),
    };
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        http_version,
        url: final_url,
        headers,
        body,
        binary,
        truncated,
        size,
        time_ms,
    })
}

/// reqwest's errors, in words: what failed (connect, timeout, certificate…) and why.
fn describe(e: reqwest::Error) -> String {
    let mut text = if e.is_timeout() {
        "The request timed out".to_string()
    } else if e.is_connect() {
        "Couldn't connect".to_string()
    } else if e.is_redirect() {
        "Too many redirects".to_string()
    } else {
        "The request failed".to_string()
    };
    let mut source = std::error::Error::source(&e);
    let mut causes = Vec::new();
    while let Some(s) = source {
        causes.push(s.to_string());
        source = s.source();
    }
    if let Some(last) = causes.last() {
        text.push_str(": ");
        text.push_str(last);
    }
    if causes.iter().any(|c| c.contains("certificate") || c.contains("UnknownIssuer")) {
        text.push_str(". A self-signed certificate (a local dev server)? Add `# @no-cert-check` above the request.");
    }
    text
}

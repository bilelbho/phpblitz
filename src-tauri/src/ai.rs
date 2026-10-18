// The AI assistant's model calls: Anthropic's Messages API, streamed. The UI builds the prompt (the
// open file, the selection, classes from the index…) and gets the answer's text as it arrives over a
// channel; a request can be cancelled at any time (ghost text cancels on every keystroke).
//
// The API key is the user's own, kept in the system's credential store like database passwords. It
// never goes to the UI: the UI only learns whether one is set and its last characters.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::State;

const API: &str = "https://api.anthropic.com/v1/messages";
const VERSION: &str = "2023-06-01";
const KEYRING_SERVICE: &str = "PHPBlitz";
const KEYRING_USER: &str = "anthropic-api-key";

#[derive(Default)]
pub struct AiState {
    requests: Mutex<HashMap<u64, JoinHandle<()>>>,
    client: Mutex<Option<reqwest::Client>>,
}

impl AiState {
    fn client(&self) -> Result<reqwest::Client, String> {
        let mut slot = self.client.lock().map_err(|e| e.to_string())?;
        if let Some(c) = slot.as_ref() {
            return Ok(c.clone());
        }
        // reqwest is built without a TLS crypto provider of its own (the updater's choice): use ring's.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            // Between two pieces of a streamed answer, not the whole answer.
            .read_timeout(Duration::from_secs(90))
            .user_agent(concat!("PHPBlitz/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        *slot = Some(client.clone());
        Ok(client)
    }
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn api_key() -> Result<String, String> {
    match entry()?.get_password() {
        Ok(k) if !k.trim().is_empty() => Ok(k.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => Err("No Anthropic API key: add yours in Settings ▸ Tools ▸ AI.".into()),
        Err(e) => Err(format!("Couldn't read the API key from the credential store: {e}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    set: bool,
    /// The last characters, to tell keys apart ("…x7Qa").
    hint: String,
}

#[tauri::command(async)]
pub fn ai_key_status() -> KeyStatus {
    match api_key() {
        Ok(k) => KeyStatus { set: true, hint: format!("…{}", k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>()) },
        Err(_) => KeyStatus { set: false, hint: String::new() },
    }
}

/// Saves the key (an empty one removes it).
#[tauri::command(async)]
pub fn ai_set_key(key: String) -> Result<KeyStatus, String> {
    let key = key.trim();
    let e = entry()?;
    if key.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => return Err(err.to_string()),
        }
    } else {
        e.set_password(key).map_err(|err| err.to_string())?;
    }
    Ok(ai_key_status())
}

/// A request as the UI builds it; sent to the API as it is, plus `stream`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    model: String,
    max_tokens: u32,
    /// A string, or content blocks (with `cache_control` on the long, repeated part).
    #[serde(default)]
    system: Option<Value>,
    messages: Value,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    stop_sequences: Option<Vec<String>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    /// The next piece of the answer.
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Done { stop_reason: Option<String>, input_tokens: u64, output_tokens: u64 },
    Error { message: String },
}

/// Streams an answer: `Text` pieces, then `Done` or `Error` (always last).
#[tauri::command]
pub async fn ai_stream(state: State<'_, AiState>, id: u64, request: AiRequest, on_event: Channel<AiEvent>) -> Result<(), String> {
    let client = state.client()?;
    let key = match api_key() {
        Ok(k) => k,
        Err(message) => {
            let _ = on_event.send(AiEvent::Error { message });
            return Ok(());
        }
    };
    let mut body = json!({ "model": request.model, "max_tokens": request.max_tokens, "messages": request.messages, "stream": true });
    if let Some(s) = request.system {
        body["system"] = s;
    }
    if let Some(t) = request.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(stop) = request.stop_sequences.filter(|s| !s.is_empty()) {
        body["stop_sequences"] = json!(stop);
    }
    let events = on_event.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(message) = run(&client, API, &key, body, &events).await {
            let _ = events.send(AiEvent::Error { message });
        }
    });
    if let Ok(mut r) = state.requests.lock() {
        r.retain(|_, t| !t.inner().is_finished());
        r.insert(id, task);
    }
    Ok(())
}

/// Stops a request; its channel gets nothing more.
#[tauri::command(async)]
pub fn ai_cancel(state: State<'_, AiState>, id: u64) {
    if let Some(task) = state.requests.lock().ok().and_then(|mut r| r.remove(&id)) {
        task.abort();
    }
}

async fn run(client: &reqwest::Client, url: &str, key: &str, body: Value, events: &Channel<AiEvent>) -> Result<(), String> {
    let mut resp = client
        .post(url)
        .header("x-api-key", key)
        .header("anthropic-version", VERSION)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Anthropic: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(api_error(status.as_u16(), &text));
    }
    let mut sse = Sse::default();
    let mut usage = (0u64, 0u64);
    let mut stop_reason = None;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("The answer was cut off: {e}"))? {
        for data in sse.feed(&chunk) {
            let Ok(v) = serde_json::from_str::<Value>(&data) else { continue };
            match v["type"].as_str().unwrap_or("") {
                "message_start" => usage.0 = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0) + v["message"]["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0),
                "content_block_delta" => {
                    if let Some(text) = v["delta"]["text"].as_str() {
                        if events.send(AiEvent::Text { text: text.to_string() }).is_err() {
                            return Ok(());
                        }
                    }
                }
                "message_delta" => {
                    stop_reason = v["delta"]["stop_reason"].as_str().map(str::to_string);
                    usage.1 = v["usage"]["output_tokens"].as_u64().unwrap_or(usage.1);
                }
                "error" => return Err(api_error(0, &data)),
                _ => {}
            }
        }
    }
    let _ = events.send(AiEvent::Done { stop_reason, input_tokens: usage.0, output_tokens: usage.1 });
    Ok(())
}

/// A readable message for an API error (status 0: an error event inside the stream).
fn api_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_string)).unwrap_or_else(|| body.chars().take(300).collect());
    match status {
        401 => "Anthropic rejected the API key. Check it in Settings ▸ Tools ▸ AI.".into(),
        403 => format!("This API key isn't allowed to do that: {detail}"),
        404 => format!("Unknown model or endpoint: {detail}"),
        429 => format!("Rate limit reached; try again in a moment. ({detail})"),
        529 => "Anthropic is overloaded right now; try again in a moment.".into(),
        0 => format!("Anthropic: {detail}"),
        _ => format!("Anthropic answered {status}: {detail}"),
    }
}

/// Server-sent events: bytes in, the `data:` of each complete event out.
#[derive(Default)]
struct Sse {
    buf: Vec<u8>,
}

impl Sse {
    fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let end = self.buf.windows(2).position(|w| w == b"\n\n");
            let crlf = self.buf.windows(4).position(|w| w == b"\r\n\r\n");
            let (at, len) = match (end, crlf) {
                (Some(a), Some(b)) if b < a => (b, 4),
                (Some(a), _) => (a, 2),
                (None, Some(b)) => (b, 4),
                (None, None) => break,
            };
            let event: Vec<u8> = self.buf.drain(..at + len).collect();
            let text = String::from_utf8_lossy(&event);
            let data: Vec<&str> = text.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.strip_prefix(' ').unwrap_or(d)).collect();
            if !data.is_empty() {
                out.push(data.join("\n"));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_sent_events_across_chunks() {
        let mut sse = Sse::default();
        assert!(sse.feed(b"event: content_block_delta\ndata: {\"a\":").is_empty());
        assert_eq!(sse.feed(b"1}\n\nevent: ping\ndata: {}\n\nda"), vec!["{\"a\":1}".to_string(), "{}".to_string()]);
        assert_eq!(sse.feed(b"ta: x\r\n\r\n"), vec!["x".to_string()]);
    }

    /// Answers one request like the Messages API would, and returns what the request carried.
    fn fake_api(status: &str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
        let status = status.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            // Headers, then the JSON body (Content-Length).
            loop {
                let n = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length: usize = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let kind = if status.starts_with("200") { "text/event-stream" } else { "application/json" };
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nConnection: close\r\n\r\n{body}").unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        (url, server)
    }

    fn collect() -> (Channel<AiEvent>, std::sync::Arc<Mutex<Vec<Value>>>) {
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, got)
    }

    #[test]
    fn streams_an_answer() {
        let (url, server) = fake_api(
            "200 OK",
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n\
             event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n\
             event: ping\ndata: {\"type\":\"ping\"}\n\n\
             event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n\
             event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n\
             event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let client = AiState::default().client().unwrap();
        let (channel, got) = collect();
        let body = json!({ "model": "m", "max_tokens": 5, "messages": [{ "role": "user", "content": "hi" }], "stream": true });
        tauri::async_runtime::block_on(run(&client, &url, "sk-test", body, &channel)).unwrap();
        let request = server.join().unwrap();
        assert!(request.contains("x-api-key: sk-test"), "{request}");
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert!(request.contains("\"stream\":true"));
        let events = got.lock().unwrap().clone();
        assert_eq!(
            events,
            vec![
                json!({ "kind": "text", "text": "Hel" }),
                json!({ "kind": "text", "text": "lo" }),
                json!({ "kind": "done", "stopReason": "end_turn", "inputTokens": 12, "outputTokens": 2 }),
            ]
        );
    }

    #[test]
    fn reports_api_errors() {
        let (url, server) = fake_api("401 Unauthorized", r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#);
        let client = AiState::default().client().unwrap();
        let (channel, _) = collect();
        let err = tauri::async_runtime::block_on(run(&client, &url, "bad", json!({}), &channel)).unwrap_err();
        server.join().unwrap();
        assert!(err.contains("rejected the API key"), "{err}");
    }

    #[test]
    fn readable_errors() {
        assert!(api_error(401, "{}").contains("rejected the API key"));
        assert_eq!(api_error(404, r#"{"type":"error","error":{"type":"not_found_error","message":"model: nope"}}"#), "Unknown model or endpoint: model: nope");
        assert!(api_error(0, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#).ends_with("Overloaded"));
    }
}

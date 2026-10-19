// The AI assistant's model calls, streamed: Anthropic (Messages API), OpenAI (Chat Completions),
// Google Gemini (streamGenerateContent) and Ollama or another local server (its OpenAI-compatible
// endpoint). The UI builds one provider-neutral request (the open file, the selection, classes from
// the index…) and gets the answer's text as it arrives over a channel; a request can be cancelled at
// any time (ghost text cancels on every keystroke).
//
// API keys are the user's own, one per provider, kept in the system's credential store like database
// passwords. They never go to the UI: it only learns whether one is set and its last characters.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::State;

const ANTHROPIC_VERSION: &str = "2023-06-01";
const KEYRING_SERVICE: &str = "PHPBlitz";
const OLLAMA_URL: &str = "http://localhost:11434";

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Anthropic,
    Openai,
    Gemini,
    Ollama,
}

impl Provider {
    fn name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::Openai => "OpenAI",
            Provider::Gemini => "Gemini",
            Provider::Ollama => "Ollama",
        }
    }

    /// The credential store entry of its key (Ollama runs locally and has none).
    fn key_entry(self) -> Option<&'static str> {
        match self {
            Provider::Anthropic => Some("anthropic-api-key"),
            Provider::Openai => Some("openai-api-key"),
            Provider::Gemini => Some("gemini-api-key"),
            Provider::Ollama => None,
        }
    }
}

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
            // Between two pieces of a streamed answer, not the whole answer (local models can be slow
            // to start).
            .read_timeout(Duration::from_secs(180))
            .user_agent(concat!("PHPBlitz/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        *slot = Some(client.clone());
        Ok(client)
    }
}

fn entry(provider: Provider) -> Result<Option<keyring::Entry>, String> {
    provider.key_entry().map(|user| keyring::Entry::new(KEYRING_SERVICE, user).map_err(|e| e.to_string())).transpose()
}

/// The provider's key; empty for Ollama.
fn api_key(provider: Provider) -> Result<String, String> {
    let Some(e) = entry(provider)? else { return Ok(String::new()) };
    match e.get_password() {
        Ok(k) if !k.trim().is_empty() => Ok(k.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => Err(format!("No {} API key: add yours in Settings ▸ Tools ▸ AI.", provider.name())),
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
pub fn ai_key_status(provider: Option<Provider>) -> KeyStatus {
    let provider = provider.unwrap_or_default();
    if provider.key_entry().is_none() {
        return KeyStatus { set: true, hint: String::new() };
    }
    match api_key(provider) {
        Ok(k) => KeyStatus { set: true, hint: format!("…{}", k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>()) },
        Err(_) => KeyStatus { set: false, hint: String::new() },
    }
}

/// Saves the provider's key (an empty one removes it).
#[tauri::command(async)]
pub fn ai_set_key(provider: Option<Provider>, key: String) -> Result<KeyStatus, String> {
    let provider = provider.unwrap_or_default();
    let Some(e) = entry(provider)? else { return Ok(ai_key_status(Some(provider))) };
    let key = key.trim();
    if key.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => return Err(err.to_string()),
        }
    } else {
        e.set_password(key).map_err(|err| err.to_string())?;
    }
    Ok(ai_key_status(Some(provider)))
}

#[derive(Deserialize, Clone)]
pub struct Message {
    /// "user" or "assistant".
    role: String,
    content: String,
}

/// A request as the UI builds it, the same for every provider.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    #[serde(default)]
    provider: Provider,
    /// Ollama's (or another OpenAI-compatible server's) address.
    #[serde(default)]
    base_url: Option<String>,
    model: String,
    max_tokens: u32,
    #[serde(default)]
    system: Option<String>,
    messages: Vec<Message>,
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
    let key = match api_key(request.provider) {
        Ok(k) => k,
        Err(message) => {
            let _ = on_event.send(AiEvent::Error { message });
            return Ok(());
        }
    };
    let events = on_event.clone();
    let task = tauri::async_runtime::spawn(async move {
        let call = build(&request, &key, None);
        if let Err(message) = run(&client, request.provider, call, &events).await {
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

/// The provider's models, for the Settings page (so it doesn't depend on model names known when
/// PHPBlitz was built): chat models of the API, or the models installed in Ollama.
#[tauri::command]
pub async fn ai_models(state: State<'_, AiState>, provider: Provider, base_url: Option<String>) -> Result<Vec<String>, String> {
    let client = state.client()?;
    let key = api_key(provider)?;
    let (url, req) = match provider {
        Provider::Anthropic => {
            let url = "https://api.anthropic.com/v1/models?limit=100".to_string();
            (url.clone(), client.get(url).header("x-api-key", &key).header("anthropic-version", ANTHROPIC_VERSION))
        }
        Provider::Openai => {
            let url = "https://api.openai.com/v1/models".to_string();
            (url.clone(), client.get(url).bearer_auth(&key))
        }
        Provider::Gemini => {
            let url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000".to_string();
            (url.clone(), client.get(url).header("x-goog-api-key", &key))
        }
        Provider::Ollama => {
            let url = format!("{}/api/tags", ollama_base(base_url.as_deref()));
            (url.clone(), client.get(url))
        }
    };
    let resp = req.send().await.map_err(|e| unreachable(provider, &url, e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(provider, status.as_u16(), &text));
    }
    Ok(model_ids(provider, &serde_json::from_str(&text).map_err(|e| e.to_string())?))
}

fn model_ids(provider: Provider, v: &Value) -> Vec<String> {
    let mut ids: Vec<String> = match provider {
        Provider::Anthropic => v["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string)).collect(),
        Provider::Openai => v["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str())
            // Chat models only: no embeddings, images, speech or moderation.
            .filter(|id| (id.starts_with("gpt-") || id.starts_with('o') || id.starts_with("chatgpt")) && !["audio", "realtime", "image", "tts", "transcribe", "search", "embedding"].iter().any(|x| id.contains(x)))
            .map(str::to_string)
            .collect(),
        Provider::Gemini => v["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["supportedGenerationMethods"].as_array().is_some_and(|a| a.iter().any(|x| x == "generateContent")))
            .filter_map(|m| m["name"].as_str().map(|n| n.trim_start_matches("models/").to_string()))
            .collect(),
        Provider::Ollama => v["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(str::to_string)).collect(),
    };
    ids.sort();
    ids.dedup();
    ids
}

fn ollama_base(base_url: Option<&str>) -> String {
    base_url.map(str::trim).filter(|u| !u.is_empty()).unwrap_or(OLLAMA_URL).trim_end_matches('/').trim_end_matches("/v1").to_string()
}

/// A request ready to send: where, its headers and its JSON body.
struct Call {
    url: String,
    headers: Vec<(&'static str, String)>,
    body: Value,
}

/// Room for the answer: reasoning models (OpenAI's o-series and GPT-5, Gemini 2.5 and later) spend
/// part of the output budget thinking, and a small budget would leave nothing for the answer.
fn thinking_room(max_tokens: u32) -> u32 {
    max_tokens.max(4096)
}

/// `url_override`: the tests' fake server.
fn build(r: &AiRequest, key: &str, url_override: Option<&str>) -> Call {
    let pick = |default: String| url_override.map(str::to_string).unwrap_or(default);
    match r.provider {
        Provider::Anthropic => {
            let mut body = json!({
                "model": r.model,
                "max_tokens": r.max_tokens,
                "stream": true,
                "messages": r.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
            });
            if let Some(s) = &r.system {
                body["system"] = json!(s);
            }
            if let Some(t) = r.temperature {
                body["temperature"] = json!(t);
            }
            if let Some(stop) = r.stop_sequences.as_ref().filter(|s| !s.is_empty()) {
                body["stop_sequences"] = json!(stop);
            }
            Call { url: pick("https://api.anthropic.com/v1/messages".into()), headers: vec![("x-api-key", key.to_string()), ("anthropic-version", ANTHROPIC_VERSION.into())], body }
        }
        Provider::Openai | Provider::Ollama => {
            let mut messages = Vec::new();
            if let Some(s) = &r.system {
                messages.push(json!({ "role": "system", "content": s }));
            }
            messages.extend(r.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })));
            let mut body = json!({ "model": r.model, "messages": messages, "stream": true, "stream_options": { "include_usage": true } });
            if r.provider == Provider::Openai {
                // Reasoning models only take the default temperature and count thinking as output.
                body["max_completion_tokens"] = json!(thinking_room(r.max_tokens));
            } else {
                body["max_tokens"] = json!(r.max_tokens);
                if let Some(t) = r.temperature {
                    body["temperature"] = json!(t);
                }
            }
            if let Some(stop) = r.stop_sequences.as_ref().filter(|s| !s.is_empty()) {
                body["stop"] = json!(stop);
            }
            let (url, headers) = if r.provider == Provider::Openai {
                ("https://api.openai.com/v1/chat/completions".to_string(), vec![("authorization", format!("Bearer {key}"))])
            } else {
                (format!("{}/v1/chat/completions", ollama_base(r.base_url.as_deref())), vec![])
            };
            Call { url: pick(url), headers, body }
        }
        Provider::Gemini => {
            let contents: Vec<Value> = r.messages.iter().map(|m| json!({ "role": if m.role == "assistant" { "model" } else { "user" }, "parts": [{ "text": m.content }] })).collect();
            let mut config = json!({ "maxOutputTokens": thinking_room(r.max_tokens) });
            if let Some(t) = r.temperature {
                config["temperature"] = json!(t);
            }
            if let Some(stop) = r.stop_sequences.as_ref().filter(|s| !s.is_empty()) {
                config["stopSequences"] = json!(stop);
            }
            let mut body = json!({ "contents": contents, "generationConfig": config });
            if let Some(s) = &r.system {
                body["systemInstruction"] = json!({ "parts": [{ "text": s }] });
            }
            let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse", r.model);
            Call { url: pick(url), headers: vec![("x-goog-api-key", key.to_string())], body }
        }
    }
}

/// Token counts and why the answer ended, gathered from the stream.
#[derive(Default)]
struct Totals {
    input: u64,
    output: u64,
    stop: Option<String>,
}

/// One server-sent event of the provider: the text it adds, if any.
fn read_event(provider: Provider, data: &str, totals: &mut Totals) -> Result<Option<String>, String> {
    if data.trim() == "[DONE]" {
        return Ok(None);
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(None) };
    if v.get("error").is_some_and(|e| !e.is_null()) || v["type"] == "error" {
        return Err(api_error(provider, 0, data));
    }
    match provider {
        Provider::Anthropic => match v["type"].as_str().unwrap_or("") {
            "message_start" => totals.input = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0) + v["message"]["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0),
            "content_block_delta" => return Ok(v["delta"]["text"].as_str().map(str::to_string)),
            "message_delta" => {
                totals.stop = v["delta"]["stop_reason"].as_str().map(str::to_string);
                totals.output = v["usage"]["output_tokens"].as_u64().unwrap_or(totals.output);
            }
            _ => {}
        },
        Provider::Openai | Provider::Ollama => {
            if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                totals.input = u["prompt_tokens"].as_u64().unwrap_or(totals.input);
                totals.output = u["completion_tokens"].as_u64().unwrap_or(totals.output);
            }
            let choice = &v["choices"][0];
            if let Some(reason) = choice["finish_reason"].as_str() {
                totals.stop = Some(reason.to_string());
            }
            return Ok(choice["delta"]["content"].as_str().filter(|t| !t.is_empty()).map(str::to_string));
        }
        Provider::Gemini => {
            if let Some(u) = v.get("usageMetadata") {
                totals.input = u["promptTokenCount"].as_u64().unwrap_or(totals.input);
                totals.output = u["candidatesTokenCount"].as_u64().unwrap_or(totals.output);
            }
            let candidate = &v["candidates"][0];
            if let Some(reason) = candidate["finishReason"].as_str() {
                totals.stop = Some(reason.to_lowercase());
            }
            // Thought summaries (when a model sends them) aren't part of the answer.
            let text: String = candidate["content"]["parts"].as_array().into_iter().flatten().filter(|p| p["thought"] != true).filter_map(|p| p["text"].as_str()).collect();
            return Ok((!text.is_empty()).then_some(text));
        }
    }
    Ok(None)
}

async fn run(client: &reqwest::Client, provider: Provider, call: Call, events: &Channel<AiEvent>) -> Result<(), String> {
    let mut req = client.post(&call.url).header("content-type", "application/json").body(call.body.to_string());
    for (name, value) in &call.headers {
        req = req.header(*name, value);
    }
    let mut resp = req.send().await.map_err(|e| unreachable(provider, &call.url, e))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(api_error(provider, status.as_u16(), &text));
    }
    let mut sse = Sse::default();
    let mut totals = Totals::default();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("The answer was cut off: {e}"))? {
        for data in sse.feed(&chunk) {
            if let Some(text) = read_event(provider, &data, &mut totals)? {
                if events.send(AiEvent::Text { text }).is_err() {
                    return Ok(());
                }
            }
        }
    }
    let _ = events.send(AiEvent::Done { stop_reason: totals.stop, input_tokens: totals.input, output_tokens: totals.output });
    Ok(())
}

/// Couldn't connect at all: for Ollama, most likely it isn't running.
fn unreachable(provider: Provider, url: &str, e: reqwest::Error) -> String {
    if provider == Provider::Ollama {
        let base = url.split("/v1/").next().unwrap_or(url).split("/api/").next().unwrap_or(url);
        return format!("Couldn't reach Ollama at {base}. Is it running? ({e})");
    }
    format!("Couldn't reach {}: {e}", provider.name())
}

/// A readable message for an API error (status 0: an error event inside the stream).
fn api_error(provider: Provider, status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    // { "error": { "message" } } for Anthropic, OpenAI and Gemini; { "error": "…" } for Ollama.
    let detail = parsed
        .as_ref()
        .and_then(|v| v["error"]["message"].as_str().or_else(|| v["error"].as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(300).collect());
    let name = provider.name();
    match status {
        401 => format!("{name} rejected the API key. Check it in Settings ▸ Tools ▸ AI."),
        403 => format!("This {name} API key isn't allowed to do that: {detail}"),
        404 => format!("Unknown model or endpoint at {name}: {detail}"),
        429 => format!("{name} rate limit or quota reached; try again in a moment. ({detail})"),
        503 | 529 => format!("{name} is overloaded right now; try again in a moment."),
        0 => format!("{name}: {detail}"),
        _ => format!("{name} answered {status}: {detail}"),
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

    #[test]
    fn readable_errors() {
        assert!(api_error(Provider::Anthropic, 401, "{}").contains("Anthropic rejected the API key"));
        assert_eq!(api_error(Provider::Openai, 404, r#"{"error":{"message":"The model `gpt-x` does not exist"}}"#), "Unknown model or endpoint at OpenAI: The model `gpt-x` does not exist");
        assert!(api_error(Provider::Gemini, 0, r#"{"error":{"code":400,"message":"API key not valid"}}"#).ends_with("API key not valid"));
        assert!(api_error(Provider::Ollama, 404, r#"{"error":"model 'llama9' not found"}"#).ends_with("model 'llama9' not found"));
    }

    fn request(provider: Provider) -> AiRequest {
        AiRequest {
            provider,
            base_url: None,
            model: "m".into(),
            max_tokens: 100,
            system: Some("be brief".into()),
            messages: vec![Message { role: "user".into(), content: "hi".into() }, Message { role: "assistant".into(), content: "hello".into() }, Message { role: "user".into(), content: "and?".into() }],
            temperature: Some(0.0),
            stop_sequences: None,
        }
    }

    #[test]
    fn builds_each_providers_request() {
        let a = build(&request(Provider::Anthropic), "k", None);
        assert_eq!(a.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(a.body["system"], "be brief");
        assert_eq!(a.body["messages"][1]["role"], "assistant");

        let o = build(&request(Provider::Openai), "k", None);
        assert_eq!(o.url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(o.headers, vec![("authorization", "Bearer k".to_string())]);
        assert_eq!(o.body["messages"][0], json!({ "role": "system", "content": "be brief" }));
        assert_eq!(o.body["max_completion_tokens"], 4096, "room for reasoning");
        assert!(o.body.get("temperature").is_none(), "reasoning models only take the default");

        let g = build(&request(Provider::Gemini), "k", None);
        assert!(g.url.ends_with("/models/m:streamGenerateContent?alt=sse"));
        assert_eq!(g.body["contents"][1]["role"], "model");
        assert_eq!(g.body["systemInstruction"]["parts"][0]["text"], "be brief");
        assert_eq!(g.body["generationConfig"]["temperature"], 0.0);

        let mut local = request(Provider::Ollama);
        local.base_url = Some("http://box:11434/v1/".into());
        let l = build(&local, "", None);
        assert_eq!(l.url, "http://box:11434/v1/chat/completions");
        assert!(l.headers.is_empty());
        assert_eq!(l.body["max_tokens"], 100);
    }

    #[test]
    fn lists_chat_models_only() {
        let openai = json!({ "data": [{ "id": "gpt-5" }, { "id": "text-embedding-3-small" }, { "id": "gpt-4o-audio-preview" }, { "id": "o3" }, { "id": "dall-e-3" }] });
        assert_eq!(model_ids(Provider::Openai, &openai), ["gpt-5", "o3"]);
        let gemini = json!({ "models": [{ "name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"] }, { "name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"] }] });
        assert_eq!(model_ids(Provider::Gemini, &gemini), ["gemini-2.5-flash"]);
        assert_eq!(model_ids(Provider::Ollama, &json!({ "models": [{ "name": "qwen2.5-coder:7b" }] })), ["qwen2.5-coder:7b"]);
    }

    /// Answers one request like the provider's API would, and returns what the request carried.
    fn fake_api(status: &str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stream", listener.local_addr().unwrap());
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

    /// Runs a request against the fake server: the request it saw and the events the UI got.
    fn stream(provider: Provider, response: &'static str) -> (String, Vec<Value>) {
        let (url, server) = fake_api("200 OK", response);
        let client = AiState::default().client().unwrap();
        let (channel, got) = collect();
        let call = build(&request(provider), "sk-test", Some(&url));
        tauri::async_runtime::block_on(run(&client, provider, call, &channel)).unwrap();
        let seen = server.join().unwrap();
        let events = got.lock().unwrap().clone();
        (seen, events)
    }

    fn done(stop: &str, input: u64, output: u64) -> Value {
        json!({ "kind": "done", "stopReason": stop, "inputTokens": input, "outputTokens": output })
    }

    #[test]
    fn streams_anthropic() {
        let (seen, events) = stream(
            Provider::Anthropic,
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n\
             event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n\
             event: ping\ndata: {\"type\":\"ping\"}\n\n\
             event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n\
             event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n\
             event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        assert!(seen.contains("x-api-key: sk-test") && seen.contains("anthropic-version: 2023-06-01"), "{seen}");
        assert_eq!(events, vec![json!({ "kind": "text", "text": "Hel" }), json!({ "kind": "text", "text": "lo" }), done("end_turn", 12, 2)]);
    }

    #[test]
    fn streams_openai() {
        let (seen, events) = stream(
            Provider::Openai,
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n\
             data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"}}]}\n\n\
             data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n\
             data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\n\
             data: [DONE]\n\n",
        );
        assert!(seen.to_lowercase().contains("authorization: bearer sk-test"), "{seen}");
        assert_eq!(events, vec![json!({ "kind": "text", "text": "Hel" }), json!({ "kind": "text", "text": "lo" }), done("stop", 9, 2)]);
    }

    #[test]
    fn streams_gemini() {
        let (seen, events) = stream(
            Provider::Gemini,
            "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"thinking…\",\"thought\":true},{\"text\":\"Hel\"}]}}]}\r\n\r\n\
             data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"lo\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":7,\"candidatesTokenCount\":2}}\r\n\r\n",
        );
        assert!(seen.contains("x-goog-api-key: sk-test"), "{seen}");
        assert_eq!(events, vec![json!({ "kind": "text", "text": "Hel" }), json!({ "kind": "text", "text": "lo" }), done("stop", 7, 2)]);
    }

    #[test]
    fn reports_api_errors() {
        let (url, server) = fake_api("401 Unauthorized", r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#);
        let client = AiState::default().client().unwrap();
        let (channel, _) = collect();
        let call = build(&request(Provider::Anthropic), "bad", Some(&url));
        let err = tauri::async_runtime::block_on(run(&client, Provider::Anthropic, call, &channel)).unwrap_err();
        server.join().unwrap();
        assert!(err.contains("rejected the API key"), "{err}");
    }

    #[test]
    fn says_when_ollama_isnt_running() {
        let client = AiState::default().client().unwrap();
        let (channel, _) = collect();
        // Nothing listens on port 9 (discard) on test machines.
        let mut r = request(Provider::Ollama);
        r.base_url = Some("http://127.0.0.1:9".into());
        let err = tauri::async_runtime::block_on(run(&client, Provider::Ollama, build(&r, "", None), &channel)).unwrap_err();
        assert!(err.starts_with("Couldn't reach Ollama at http://127.0.0.1:9. Is it running?"), "{err}");
    }
}

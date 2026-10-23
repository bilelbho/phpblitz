// MCP server: AI coding agents (Claude Code, Codex, Gemini CLI…) ask PHPBlitz's index about the
// open project: find symbols, a class's members and parents, usages, declarations, a file's
// outline and Mago's problems. The agent runs with the user's own account; PHPBlitz only answers.
//
// Streamable HTTP (MCP 2025-06-18) on 127.0.0.1, one JSON response per POST (no SSE streams).
// Off until turned on in Settings. Every request needs the token (a random secret kept in the app's
// config folder), and requests from web pages (an Origin header) or for another host name (DNS
// rebinding) are refused, so a website can't read the project through it. All tools only read.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::index::{self, ClassEntry, IndexState, Member};
use crate::mago::{self, MagoState};

const PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_HEADERS: usize = 16 * 1024;
const MAX_BODY: usize = 4 * 1024 * 1024;
/// Connections served at once; more are closed right away.
const MAX_CONNECTIONS: usize = 16;
/// Lines of usages or problems in one answer: enough to act on, small enough for a model's context.
const MAX_LINES: usize = 200;

#[derive(Default)]
pub struct McpState {
    running: Mutex<Option<Running>>,
    token: Mutex<Option<String>>,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    running: bool,
    port: u16,
    url: String,
    token: String,
}

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("mcp-token"))
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn save_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let path = token_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::fs::write_private(&path, token.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// The token, read from disk (or made) the first time.
fn token(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<McpState>();
    let mut slot = state.token.lock().map_err(|e| e.to_string())?;
    if let Some(t) = slot.as_ref() {
        return Ok(t.clone());
    }
    let saved = std::fs::read_to_string(token_path(app)?).ok().map(|t| t.trim().to_string()).filter(|t| t.len() >= 32);
    let t = match saved {
        Some(t) => t,
        None => {
            let t = new_token()?;
            save_token(app, &t)?;
            t
        }
    };
    *slot = Some(t.clone());
    Ok(t)
}

fn status(app: &AppHandle, port: u16) -> Result<McpStatus, String> {
    let running = app.state::<McpState>().running.lock().map_err(|e| e.to_string())?.as_ref().map(|r| r.port);
    let port = running.unwrap_or(port);
    Ok(McpStatus { running: running.is_some(), port, url: format!("http://127.0.0.1:{port}/mcp"), token: token(app)? })
}

fn stop(state: &McpState) {
    if let Some(r) = state.running.lock().ok().and_then(|mut r| r.take()) {
        r.stop.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it sees the flag.
        let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], r.port).into(), Duration::from_millis(200));
    }
}

#[tauri::command(async)]
pub fn mcp_start(app: AppHandle, port: u16) -> Result<McpStatus, String> {
    let state = app.state::<McpState>();
    if state.running.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|r| r.port == port) {
        return status(&app, port);
    }
    stop(&state);
    token(&app)?;
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("Port {port} is not available: {e}"))?;
    let stop_flag = Arc::new(AtomicBool::new(false));
    *state.running.lock().map_err(|e| e.to_string())? = Some(Running { port, stop: stop_flag.clone() });
    let handle = app.clone();
    // A thread per connection, but not without limit: a local process can't exhaust threads.
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = conn else { continue };
            if active.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                let _ = stream.shutdown(std::net::Shutdown::Both);
                continue;
            }
            active.fetch_add(1, Ordering::SeqCst);
            let (app, active) = (handle.clone(), Arc::clone(&active));
            std::thread::spawn(move || {
                // Counted down however serve ends (a panic too).
                struct Slot(Arc<std::sync::atomic::AtomicUsize>);
                impl Drop for Slot {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                let _slot = Slot(active);
                serve(&app, stream, port);
            });
        }
    });
    status(&app, port)
}

#[tauri::command(async)]
pub fn mcp_stop(app: AppHandle) {
    stop(&app.state::<McpState>());
}

#[tauri::command(async)]
pub fn mcp_status(app: AppHandle, port: u16) -> Result<McpStatus, String> {
    status(&app, port)
}

/// The MCP settings file for an agent started from PHPBlitz (`claude --mcp-config <file>`): the
/// token stays out of the command line and the terminal.
#[tauri::command(async)]
pub fn mcp_agent_config(app: AppHandle, port: u16) -> Result<String, String> {
    let token = token(&app)?;
    let config = json!({ "mcpServers": { "phpblitz": { "type": "http", "url": format!("http://127.0.0.1:{port}/mcp"), "headers": { "Authorization": format!("Bearer {token}") } } } });
    let path = token_path(&app)?.with_file_name("mcp-agents.json");
    crate::fs::write_private(&path, config.to_string().as_bytes()).map_err(|e| e.to_string())?;
    Ok(crate::fs::norm(&path))
}

/// A new token: agents set up with the old one stop working.
#[tauri::command(async)]
pub fn mcp_new_token(app: AppHandle, port: u16) -> Result<McpStatus, String> {
    let t = new_token()?;
    save_token(&app, &t)?;
    *app.state::<McpState>().token.lock().map_err(|e| e.to_string())? = Some(t);
    status(&app, port)
}

// ── HTTP ─────────────────────────────────────────────────────

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if buf.len() > MAX_HEADERS {
            return None;
        }
    };
    let head = std::str::from_utf8(&buf[..head_end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let length = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0);
    if length > MAX_BODY {
        return None;
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Some(Request { method, path, headers, body })
}

/// Compares in constant time, so the token can't be guessed byte by byte from response times.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Runs a tool: its name and arguments, and the text for the model (or why it failed).
type Tools<'a> = &'a dyn Fn(&str, &Value) -> Result<String, String>;

fn serve(app: &AppHandle, stream: TcpStream, port: u16) {
    let Ok(expected) = token(app) else { return };
    serve_with(stream, port, &expected, &|name, args| call(app, name, args));
}

fn serve_with(mut stream: TcpStream, port: u16, expected: &str, run: Tools) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let Some(req) = read_request(&mut stream) else { return };
    let (code, body) = respond(&req, port, expected, run);
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    let kind = if body.starts_with('{') || body.starts_with('[') { "application/json" } else { "text/plain; charset=utf-8" };
    let allow = if code == 405 { "Allow: POST\r\n" } else { "" };
    let head = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n{allow}Connection: close\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body.as_bytes()));
}

/// Refuses web pages (they send Origin), DNS rebinding (another Host) and other paths.
fn check(req: &Request, port: u16) -> Result<(), (u16, String)> {
    if req.header("origin").is_some() {
        return Err((403, "Requests from web pages are not accepted.".into()));
    }
    let host_ok = req.header("host").is_some_and(|h| [format!("127.0.0.1:{port}"), format!("localhost:{port}")].iter().any(|ok| h.eq_ignore_ascii_case(ok)));
    if !host_ok {
        return Err((403, "Unexpected Host header.".into()));
    }
    if req.path.split('?').next() != Some("/mcp") {
        return Err((404, "Not found: the MCP endpoint is /mcp.".into()));
    }
    Ok(())
}

fn respond(req: &Request, port: u16, expected: &str, run: Tools) -> (u16, String) {
    if let Err(refused) = check(req, port) {
        return refused;
    }
    let given = req.header("authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    if !same(given.trim(), expected) {
        return (401, "Missing or wrong token: copy the setup command again from PHPBlitz's Settings.".into());
    }
    if req.method != "POST" {
        return (405, String::new());
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&req.body) else {
        return (400, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }).to_string());
    };
    let reply = match msg {
        Value::Array(batch) => {
            let out: Vec<Value> = batch.into_iter().filter_map(|m| handle(m, run)).collect();
            (!out.is_empty()).then(|| Value::Array(out))
        }
        m => handle(m, run),
    };
    match reply {
        Some(v) => (200, v.to_string()),
        // Notifications and responses get no answer.
        None => (202, String::new()),
    }
}

// ── JSON-RPC and tools ───────────────────────────────────────

fn handle(msg: Value, run: Tools) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = PROTOCOLS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOLS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "phpblitz", "title": "PHPBlitz", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Answers come from PHPBlitz's index of the project open in the IDE (parsed PHP, project and vendor). \
                    Prefer these tools over searching files for PHP symbols: they resolve namespaces, inheritance, traits and mixins.",
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match run(name, &args) {
                Ok(text) => Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": false })),
                // Tool failures go to the model, which can correct its arguments.
                Err(e) => Ok(json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
            }
        }
        _ => Err(json!({ "code": -32601, "message": format!("Method not found: {method}") })),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    })
}

fn tool(name: &str, title: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
        "annotations": { "readOnlyHint": true, "openWorldHint": false },
    })
}

fn tools() -> Vec<Value> {
    let class = json!({ "type": "string", "description": "Class, interface, trait or enum: fully qualified (App\\Models\\User) or short (User)." });
    vec![
        tool("project_info", "Project info", "The project open in PHPBlitz: its folder and the size of the index.", json!({}), &[]),
        tool(
            "search_symbols",
            "Search symbols",
            "Find classes, interfaces, traits, enums, methods and functions by name (fuzzy: prefix, CamelHumps like UsCo for UserController, substring). Returns kind, name, detail, file and line.",
            json!({ "query": { "type": "string" }, "limit": { "type": "integer", "description": "Default 20, at most 100." } }),
            &["query"],
        ),
        tool(
            "get_class",
            "Class details",
            "A class's declaration, file, parent, interfaces, traits and members with signatures. With inherited=true, also the members it gets from parents, traits, interfaces and @mixin classes.",
            json!({ "name": class, "inherited": { "type": "boolean" } }),
            &["name"],
        ),
        tool(
            "find_declaration",
            "Find declaration",
            "Where a class, a member (method, property, constant) or a function is declared. Give class, or class and member, or function.",
            json!({ "class": class, "member": { "type": "string", "description": "Method, property (without $) or constant name." }, "function": { "type": "string", "description": "Function name, optionally namespaced." } }),
            &[],
        ),
        tool(
            "find_usages",
            "Find usages",
            "Where a class, member or function is used in the project, resolved by the index (not text search). Each line: file:line, the code, and whether the type of the receiver is unknown (maybe).",
            json!({
                "class": class,
                "member": { "type": "string", "description": "Method, property (without $) or constant name." },
                "function": { "type": "string" },
                "includeVendor": { "type": "boolean", "description": "Also search vendor/ (default false)." },
            }),
            &[],
        ),
        tool(
            "file_outline",
            "File outline",
            "The classes, members and functions a PHP file declares, with lines.",
            json!({ "path": { "type": "string", "description": "Absolute, or relative to the project folder." } }),
            &["path"],
        ),
        tool(
            "project_problems",
            "Project problems",
            "Errors and warnings from Mago's analyzer and linter for the project, optionally for one file.",
            json!({ "path": { "type": "string", "description": "Only this file (absolute, or relative to the project folder)." }, "limit": { "type": "integer", "description": "Default 100." } }),
            &[],
        ),
    ]
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn root(app: &AppHandle) -> Result<String, String> {
    let (root, _, _) = index::overview(&app.state::<IndexState>())?;
    if root.is_empty() {
        return Err("No project is open in PHPBlitz.".into());
    }
    Ok(root)
}

fn absolute(app: &AppHandle, path: &str) -> Result<String, String> {
    let path = path.replace('\\', "/");
    let is_abs = path.starts_with('/') || path.as_bytes().get(1) == Some(&b':');
    Ok(if is_abs { path } else { format!("{}/{}", root(app)?, path.trim_start_matches("./")) })
}

fn block<T>(f: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tauri::async_runtime::block_on(f)
}

fn call(app: &AppHandle, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "project_info" => {
            let (root, files, classes) = index::overview(&app.state::<IndexState>())?;
            if root.is_empty() {
                return Err("No project is open in PHPBlitz.".into());
            }
            Ok(format!("Project: {root}\nIndexed PHP files: {files} (project and vendor)\nClasses, interfaces, traits and enums: {classes}"))
        }
        "search_symbols" => {
            root(app)?;
            let query = arg(args, "query").ok_or("query is required")?;
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 100) as usize;
            let hits = serde_json::to_value(block(index::index_search(app.state(), query.to_string(), Some(limit)))?).map_err(|e| e.to_string())?;
            let lines: Vec<String> = hits
                .as_array()
                .into_iter()
                .flatten()
                .map(|h| {
                    let s = |k: &str| h.get(k).and_then(Value::as_str).unwrap_or("");
                    let vendor = if h.get("vendor").and_then(Value::as_bool) == Some(true) { " (vendor)" } else { "" };
                    format!("{} {}  {}  {}:{}{vendor}", s("kind"), s("name"), s("detail"), s("path"), h.get("line").and_then(Value::as_u64).unwrap_or(0))
                })
                .collect();
            Ok(if lines.is_empty() { format!("Nothing matches \"{query}\".") } else { lines.join("\n") })
        }
        "get_class" => {
            root(app)?;
            let name = arg(args, "name").ok_or("name is required")?;
            let info = block(index::index_class(app.state(), name.to_string()))?.ok_or_else(|| format!("No class \"{name}\" in the index."))?;
            let v = serde_json::to_value(info).map_err(|e| e.to_string())?;
            let class: ClassEntry = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
            let path = v.get("path").and_then(Value::as_str).unwrap_or("");
            let mut out = describe_class(&class, path);
            if args.get("inherited").and_then(Value::as_bool) == Some(true) {
                let all: Vec<Member> = serde_json::from_value(v.get("allMembers").cloned().unwrap_or(json!([]))).map_err(|e| e.to_string())?;
                let own: std::collections::HashSet<(&str, &str)> = class.members.iter().map(|m| (m.kind.as_str(), m.name.as_str())).collect();
                let inherited: Vec<String> = all.iter().filter(|m| !own.contains(&(m.kind.as_str(), m.name.as_str()))).map(signature).collect();
                if !inherited.is_empty() {
                    out.push_str("\n\nInherited (parents, traits, interfaces, mixins):\n");
                    out.push_str(&inherited.join("\n"));
                }
            }
            Ok(out)
        }
        "find_declaration" => {
            root(app)?;
            let target = target(args)?;
            let loc = block(index::index_locate(app.state(), target))?;
            let v = serde_json::to_value(loc).map_err(|e| e.to_string())?;
            if v.is_null() {
                return Err("Not found in the index.".into());
            }
            Ok(format!("{}  {}:{}", v["name"].as_str().unwrap_or(""), v["path"].as_str().unwrap_or(""), v["line"]))
        }
        "find_usages" => {
            root(app)?;
            let target = target(args)?;
            let vendor = args.get("includeVendor").and_then(Value::as_bool);
            let result = serde_json::to_value(block(index::index_find_usages(app.state(), target, None, vendor))?).map_err(|e| e.to_string())?;
            let items = result["items"].as_array().cloned().unwrap_or_default();
            let mut out = format!("{} {}, declared in {}: {} usages in {} files searched.", result["kind"].as_str().unwrap_or(""), result["title"].as_str().unwrap_or(""), result["declaredIn"].as_str().unwrap_or(""), items.len(), result["files"]);
            for u in items.iter().take(MAX_LINES) {
                let mut flags = Vec::new();
                if u["dynamic"].as_bool() == Some(true) {
                    flags.push("maybe: receiver type unknown");
                }
                if let Some(a) = u["access"].as_str().filter(|a| !a.is_empty()) {
                    flags.push(a);
                }
                let flags = if flags.is_empty() { String::new() } else { format!("  [{}]", flags.join(", ")) };
                out.push_str(&format!("\n{}:{}: {}{flags}", u["path"].as_str().unwrap_or(""), u["line"], u["preview"].as_str().unwrap_or("").trim()));
            }
            if items.len() > MAX_LINES {
                out.push_str(&format!("\n… and {} more.", items.len() - MAX_LINES));
            }
            Ok(out)
        }
        "file_outline" => {
            let path = absolute(app, arg(args, "path").ok_or("path is required")?)?;
            let structure = index::index_file_structure(app.state(), path.clone())?.ok_or_else(|| format!("{path} is not an indexed PHP file."))?;
            let v = serde_json::to_value(structure).map_err(|e| e.to_string())?;
            let classes: Vec<ClassEntry> = serde_json::from_value(v["classes"].clone()).map_err(|e| e.to_string())?;
            let mut parts: Vec<String> = classes.iter().map(|c| describe_class(c, &path)).collect();
            for f in v["functions"].as_array().into_iter().flatten() {
                parts.push(format!("function {}({}){}  line {}", f["fqn"].as_str().unwrap_or(""), f["params"].as_str().unwrap_or(""), ret(f["detail"].as_str().unwrap_or("")), f["line"]));
            }
            Ok(if parts.is_empty() { format!("{path} declares no classes or functions.") } else { parts.join("\n\n") })
        }
        "project_problems" => {
            root(app)?;
            let only = arg(args, "path").map(|p| absolute(app, p)).transpose()?;
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(100).clamp(1, 1000) as usize;
            let issues = serde_json::to_value(block(mago::mago_project_issues(app.state::<MagoState>(), Some(if only.is_some() { usize::MAX } else { limit })))?).map_err(|e| e.to_string())?;
            let mut lines = Vec::new();
            for f in issues["files"].as_array().into_iter().flatten() {
                let path = f["path"].as_str().unwrap_or("");
                if only.as_deref().is_some_and(|o| !o.eq_ignore_ascii_case(path)) {
                    continue;
                }
                for d in f["diagnostics"].as_array().into_iter().flatten() {
                    lines.push(format!("{path}:{}: {} [{}] {}", d["line"], d["severity"].as_str().unwrap_or(""), d["code"].as_str().unwrap_or(""), d["message"].as_str().unwrap_or("")));
                }
            }
            let total = lines.len();
            lines.truncate(limit);
            let mut head = format!("{total} problems{}.", if only.is_some() { " in this file" } else { "" });
            if issues["analyzed"].as_bool() == Some(false) {
                head.push_str(" The project analysis hasn't finished yet: only open files are checked so far.");
            }
            if total > lines.len() {
                head.push_str(&format!(" Showing {}.", lines.len()));
            }
            Ok(std::iter::once(head).chain(lines).collect::<Vec<_>>().join("\n"))
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}

fn target(args: &Value) -> Result<index::Target, String> {
    let v = match (arg(args, "class"), arg(args, "member"), arg(args, "function")) {
        (Some(class), Some(member), _) => json!({ "kind": "member", "class": class, "name": member.trim_start_matches('$').trim_end_matches("()") }),
        (Some(class), None, _) => json!({ "kind": "class", "name": class }),
        (None, _, Some(function)) => json!({ "kind": "function", "name": function.trim_end_matches("()") }),
        _ => return Err("Give class, class and member, or function.".into()),
    };
    serde_json::from_value(v).map_err(|e| e.to_string())
}

fn ret(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(": {}", detail.trim_start_matches(':').trim())
    }
}

fn signature(m: &Member) -> String {
    let stat = if m.is_static { "static " } else { "" };
    match m.kind.as_str() {
        "method" => format!("  {} {stat}function {}({}){}  line {}", m.visibility, m.name, m.params.as_deref().unwrap_or(""), ret(&m.detail), m.line),
        "property" => format!("  {} {stat}{}${}  line {}", m.visibility, if m.detail.is_empty() { String::new() } else { format!("{} ", m.detail) }, m.name, m.line),
        _ => format!("  {} const {}{}  line {}", m.visibility, m.name, if m.detail.is_empty() { String::new() } else { format!(" {}", m.detail) }, m.line),
    }
}

fn describe_class(c: &ClassEntry, path: &str) -> String {
    let mut head = format!("{} {}", c.kind, c.fqn);
    if let Some(parent) = &c.extends {
        head.push_str(&format!(" extends {parent}"));
    }
    if !c.implements.is_empty() {
        head.push_str(&format!(" implements {}", c.implements.join(", ")));
    }
    head.push_str(&format!("\n  {path}:{}-{}", c.line, c.end_line.max(c.line)));
    if !c.traits.is_empty() {
        head.push_str(&format!("\n  uses {}", c.traits.join(", ")));
    }
    if !c.mixins.is_empty() {
        head.push_str(&format!("\n  @mixin {}", c.mixins.join(", ")));
    }
    let members: Vec<String> = c.members.iter().map(signature).collect();
    if !members.is_empty() {
        head.push('\n');
        head.push_str(&members.join("\n"));
    }
    head
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(headers: &[(&str, &str)]) -> Request {
        Request { method: "POST".into(), path: "/mcp".into(), headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: b"{}".to_vec() }
    }

    #[test]
    fn token_comparison() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }

    #[test]
    fn targets_from_arguments() {
        assert!(matches!(target(&json!({ "class": "User", "member": "$name" })).unwrap(), index::Target::Member { name, .. } if name == "name"));
        assert!(matches!(target(&json!({ "class": "User" })).unwrap(), index::Target::Class { .. }));
        assert!(matches!(target(&json!({ "function": "helper()" })).unwrap(), index::Target::Function { name, .. } if name == "helper"));
        assert!(target(&json!({})).is_err());
    }

    #[test]
    fn refuses_web_pages_and_other_hosts() {
        assert!(check(&req(&[("Host", "127.0.0.1:7465")]), 7465).is_ok());
        assert!(check(&req(&[("host", "LOCALHOST:7465")]), 7465).is_ok());
        assert_eq!(check(&req(&[("Host", "127.0.0.1:7465"), ("Origin", "https://evil.example")]), 7465).unwrap_err().0, 403);
        assert_eq!(check(&req(&[("Host", "evil.example:7465")]), 7465).unwrap_err().0, 403);
        assert_eq!(check(&req(&[]), 7465).unwrap_err().0, 403);
        let mut other = req(&[("Host", "127.0.0.1:7465")]);
        other.path = "/".into();
        assert_eq!(check(&other, 7465).unwrap_err().0, 404);
    }

    /// One HTTP exchange with a server on a free port, the way an agent's MCP client talks to it.
    fn exchange(request: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_with(stream, port, "secret", &|name, args| match name {
                "echo" => Ok(format!("echo {}", args["text"].as_str().unwrap_or(""))),
                _ => Err(format!("Unknown tool: {name}")),
            });
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(request.replace("{port}", &port.to_string()).as_bytes()).unwrap();
        let mut out = String::new();
        client.read_to_string(&mut out).unwrap();
        server.join().unwrap();
        out
    }

    fn post(token: &str, body: &str) -> String {
        let head = ["POST /mcp HTTP/1.1", "Host: 127.0.0.1:{port}", &format!("Authorization: Bearer {token}"), "Content-Type: application/json", "Accept: application/json, text/event-stream", &format!("Content-Length: {}", body.len())];
        exchange(&format!("{}\r\n\r\n{body}", head.join("\r\n")))
    }

    fn json_body(response: &str) -> Value {
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    #[test]
    fn speaks_mcp_over_http() {
        let init = post("secret", r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#);
        assert!(init.starts_with("HTTP/1.1 200 OK\r\n"), "{init}");
        assert!(init.contains("Content-Type: application/json\r\n"));
        let v = json_body(&init);
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(v["result"]["serverInfo"]["name"], "phpblitz");

        let note = post("secret", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert!(note.starts_with("HTTP/1.1 202 Accepted\r\n"), "{note}");

        let list = json_body(&post("secret", r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#));
        assert!(list["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "find_usages"));

        let called = json_body(&post("secret", r#"{"jsonrpc":"2.0","id":"x","method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}"#));
        assert_eq!(called["id"], "x");
        assert_eq!(called["result"]["content"][0]["text"], "echo hi");
        assert_eq!(called["result"]["isError"], false);

        let failed = json_body(&post("secret", r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope"}}"#));
        assert_eq!(failed["result"]["isError"], true);

        let unknown = json_body(&post("secret", r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#));
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn refuses_wrong_tokens_gets_and_garbage() {
        assert!(post("wrong", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).starts_with("HTTP/1.1 401 "));
        assert!(post("", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).starts_with("HTTP/1.1 401 "));
        let get = exchange("GET /mcp HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer secret\r\n\r\n");
        assert!(get.starts_with("HTTP/1.1 405 ") && get.contains("Allow: POST\r\n"), "{get}");
        let bad = post("secret", "{not json");
        assert!(bad.starts_with("HTTP/1.1 400 "));
        assert_eq!(json_body(&bad)["error"]["code"], -32700);
        let page = exchange("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://example.com\r\nAuthorization: Bearer secret\r\nContent-Length: 2\r\n\r\n{}");
        assert!(page.starts_with("HTTP/1.1 403 "));
    }

    #[test]
    fn tools_are_read_only() {
        for t in tools() {
            assert_eq!(t["annotations"]["readOnlyHint"], true, "{}", t["name"]);
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn signatures() {
        let m = Member { kind: "method".into(), name: "find".into(), detail: "?User".into(), params: Some("int $id".into()), line: 12, visibility: "public".into(), is_static: true, ty: None, elem: None };
        assert_eq!(signature(&m), "  public static function find(int $id): ?User  line 12");
    }
}

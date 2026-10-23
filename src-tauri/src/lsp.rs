//! Language server manager.
//!
//! Starts a language server (PHPantom, php-lsp, later our own) as a child
//! process and relays LSP messages between it and the UI:
//! - UI → server: the `lsp_send` command writes one framed JSON-RPC message to stdin.
//! - server → UI: a reader thread parses stdout and sends each message through the server's
//!   channel (with its stderr lines, and its exit as the last message).
//!
//! The JSON itself is never interpreted here, so any LSP server works.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;

struct Server {
    child: Child,
    /// Queue to the writer thread that owns the server's stdin.
    input: std::sync::mpsc::Sender<Vec<u8>>,
}

#[derive(Default)]
pub struct LspState {
    servers: Mutex<HashMap<u32, Server>>,
    next_id: AtomicU32,
}

impl LspState {
    pub fn stop_all(&self) {
        if let Ok(mut servers) = self.servers.lock() {
            for (_, mut server) in servers.drain() {
                let _ = server.child.kill();
                let _ = server.child.wait();
            }
        }
    }
}

/// What a server's channel carries: its JSON-RPC messages, its stderr lines, then its exit.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LspEvent {
    Message { message: String },
    Log { line: String },
    Exit,
}

/// Reads `Content-Length: N\r\n...\r\n\r\n<N bytes>` frames until the stream ends.
fn read_messages(stdout: impl Read, mut on_message: impl FnMut(String)) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut length: Option<usize> = None;
        loop {
            let mut header = String::new();
            match reader.read_line(&mut header) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().ok();
                }
            }
        }
        let Some(length) = length else { continue };
        let mut body = vec![0u8; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        on_message(String::from_utf8_lossy(&body).into_owned());
    }
}

/// Starts a language server and returns its id. Its messages arrive through `on_event`.
#[tauri::command(async)]
pub fn lsp_start(
    state: State<'_, LspState>,
    command: String,
    args: Vec<String>,
    cwd: String,
    on_event: Channel<LspEvent>,
) -> Result<u32, String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::process::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start language server {command}: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let messages = on_event.clone();
    std::thread::spawn(move || {
        read_messages(stdout, |message| {
            let _ = messages.send(LspEvent::Message { message });
        });
        let _ = messages.send(LspEvent::Exit);
    });

    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = on_event.send(LspEvent::Log { line });
        }
    });

    state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Server { child, input: crate::process::spawn_writer(stdin) });
    Ok(id)
}

/// Sends one JSON-RPC message (already serialized) to a server: queued for its writer thread, so
/// a server that is slow to read never blocks the UI or the other servers.
#[tauri::command(async)]
pub fn lsp_send(state: State<'_, LspState>, server: u32, message: String) -> Result<(), String> {
    let servers = state.servers.lock().map_err(|e| e.to_string())?;
    let s = servers.get(&server).ok_or("language server is not running")?;
    let mut frame = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    frame.extend_from_slice(message.as_bytes());
    s.input.send(frame).map_err(|_| "Could not write to language server: it stopped reading".to_string())
}

#[tauri::command(async)]
pub fn lsp_stop(state: State<'_, LspState>, server: u32) -> Result<(), String> {
    if let Some(mut s) = state.servers.lock().map_err(|e| e.to_string())?.remove(&server) {
        // Waited for, so it doesn't stay a zombie process on Unix until PHPBlitz exits.
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::read_messages;

    #[test]
    fn reads_framed_messages() {
        let input = b"Content-Length: 2\r\n\r\n{}Content-Length: 7\r\nContent-Type: x\r\n\r\n{\"a\":1}";
        let mut got = Vec::new();
        read_messages(&input[..], |m| got.push(m));
        assert_eq!(got, vec!["{}".to_string(), "{\"a\":1}".to_string()]);
    }

    #[test]
    fn counts_bytes_not_chars() {
        let body = "{\"x\":\"é\"}";
        let input = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let mut got = Vec::new();
        read_messages(input.as_bytes(), |m| got.push(m));
        assert_eq!(got, vec![body.to_string()]);
    }
}

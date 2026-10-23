//! Xdebug (DBGp) connections: PHPBlitz listens (port 9003 by default), PHP connects when a
//! request starts with debugging on. Messages are relayed to the UI, which speaks the protocol.
//!
//! Framing: Xdebug sends `<length>\0<xml>\0`; the IDE sends `command -i <id> args\0`.
//!
//! Only this machine can connect unless the UI asks for every interface (Docker containers, a VM,
//! another machine): the port takes commands from whoever connects. Frames and sessions are capped,
//! so a peer can't make PHPBlitz allocate without limit.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Connected { session: u32, remote: String },
    Message { session: u32, xml: String },
    Closed { session: u32 },
}

type Emit = Arc<dyn Fn(Event) + Send + Sync>;

/// The largest DBGp frame accepted (Xdebug's are rarely over a few MB): a bigger one drops the connection.
const MAX_FRAME: usize = 64 * 1024 * 1024;
/// Debug sessions at once; more connections are refused.
const MAX_SESSIONS: usize = 32;

struct Listening {
    port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct XdebugState {
    listening: Mutex<Option<Listening>>,
    conns: Arc<Mutex<HashMap<u32, TcpStream>>>,
    next: Arc<AtomicU32>,
}

impl XdebugState {
    /// Starts listening, on this machine only unless `everywhere`; returns the port (useful with port 0 in tests).
    fn listen(&self, port: u16, everywhere: bool, emit: Emit) -> Result<u16, String> {
        self.stop_listening();
        let host = if everywhere { "0.0.0.0" } else { "127.0.0.1" };
        let listener = TcpListener::bind((host, port)).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {port} is already in use (another IDE listening for Xdebug?)")
            } else {
                format!("Could not listen on port {port}: {e}")
            }
        })?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let (conns, next, stop_flag) = (Arc::clone(&self.conns), Arc::clone(&self.next), Arc::clone(&stop));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                if conns.lock().unwrap().len() >= MAX_SESSIONS {
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                let id = next.fetch_add(1, Ordering::Relaxed) + 1;
                let remote = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
                let Ok(writer) = stream.try_clone() else { continue };
                conns.lock().unwrap().insert(id, writer);
                emit(Event::Connected { session: id, remote });
                let (emit, conns) = (Arc::clone(&emit), Arc::clone(&conns));
                std::thread::spawn(move || {
                    read_frames(stream, |xml| emit(Event::Message { session: id, xml }));
                    conns.lock().unwrap().remove(&id);
                    emit(Event::Closed { session: id });
                });
            }
        });
        *self.listening.lock().unwrap() = Some(Listening { port, stop });
        Ok(port)
    }

    fn stop_listening(&self) {
        if let Some(l) = self.listening.lock().unwrap().take() {
            l.stop.store(true, Ordering::Relaxed);
            // Wake the blocking accept so the thread sees the flag.
            let _ = TcpStream::connect(("127.0.0.1", l.port));
        }
    }

    fn send(&self, session: u32, command: &str) -> Result<(), String> {
        let mut conns = self.conns.lock().map_err(|e| e.to_string())?;
        let stream = conns.get_mut(&session).ok_or("The debug session has ended")?;
        let mut bytes = command.as_bytes().to_vec();
        bytes.push(0);
        stream.write_all(&bytes).map_err(|e| e.to_string())
    }

    fn close(&self, session: u32) {
        if let Some(s) = self.conns.lock().unwrap().remove(&session) {
            let _ = s.shutdown(Shutdown::Both);
        }
    }

    pub fn shutdown(&self) {
        self.stop_listening();
        for (_, s) in self.conns.lock().unwrap().drain() {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

/// Reads `<length>\0<xml>\0` frames until the connection closes.
fn read_frames(stream: impl Read, mut on_xml: impl FnMut(String)) {
    let mut reader = BufReader::new(stream);
    loop {
        // The length: a few digits and a NUL (more than 24 bytes without one isn't DBGp).
        let mut len = Vec::new();
        match (&mut reader).take(24).read_until(0, &mut len) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if len.pop() != Some(0) {
            return;
        }
        let Ok(n) = String::from_utf8_lossy(&len).trim().parse::<usize>() else { return };
        if n > MAX_FRAME {
            return;
        }
        let mut body = vec![0u8; n + 1]; // the XML and its trailing NUL
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        body.pop();
        on_xml(String::from_utf8_lossy(&body).into_owned());
    }
}

#[tauri::command(async)]
pub fn xdebug_listen(app: AppHandle, state: State<'_, XdebugState>, port: u16, everywhere: Option<bool>) -> Result<u16, String> {
    let emit: Emit = Arc::new(move |e: Event| {
        let _ = app.emit("xdebug", e);
    });
    state.listen(port, everywhere.unwrap_or(false), emit)
}

#[tauri::command(async)]
pub fn xdebug_stop_listening(state: State<'_, XdebugState>) -> Result<(), String> {
    state.stop_listening();
    Ok(())
}

#[tauri::command(async)]
pub fn xdebug_send(state: State<'_, XdebugState>, session: u32, command: String) -> Result<(), String> {
    state.send(session, &command)
}

#[tauri::command(async)]
pub fn xdebug_close(state: State<'_, XdebugState>, session: u32) -> Result<(), String> {
    state.close(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn frame(xml: &str) -> Vec<u8> {
        let mut out = format!("{}\0{}", xml.len(), xml).into_bytes();
        out.push(0);
        out
    }

    /// Plays Xdebug: connects, sends the init packet, receives a command, answers it.
    #[test]
    fn relays_dbgp_frames_both_ways() {
        let state = XdebugState::default();
        let (tx, rx) = mpsc::channel::<Event>();
        let tx = Mutex::new(tx);
        let port = state.listen(0, false, Arc::new(move |e| tx.lock().unwrap().send(e).unwrap())).unwrap();

        let mut php = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let init = r#"<?xml version="1.0" encoding="iso-8859-1"?><init xmlns="urn:debugger_protocol_v1" fileuri="file:///var/www/html/public/index.php" language="PHP" idekey="PHPSTORM"/>"#;
        // Two frames in one write, the second split across writes: framing must not depend on packet boundaries.
        let mut bytes = frame(init);
        let second = frame(r#"<response command="status" transaction_id="0" status="starting"/>"#);
        bytes.extend_from_slice(&second[..10]);
        php.write_all(&bytes).unwrap();
        php.write_all(&second[10..]).unwrap();

        let wait = || rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let session = match wait() {
            Event::Connected { session, .. } => session,
            e => panic!("expected connected, got {e:?}"),
        };
        assert_eq!(wait(), Event::Message { session, xml: init.to_string() });
        assert!(matches!(wait(), Event::Message { xml, .. } if xml.contains("starting")));

        state.send(session, "run -i 1").unwrap();
        php.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut buf = [0u8; 9];
        php.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"run -i 1\0");

        drop(php);
        assert_eq!(wait(), Event::Closed { session });
        assert!(state.send(session, "status -i 2").is_err(), "closed sessions refuse commands");
        state.shutdown();
    }

    /// Lengths that don't fit, overflow or never end drop the connection instead of allocating.
    #[test]
    fn refuses_frames_that_are_too_big_or_malformed() {
        let mut ok = frame("<init/>");
        ok.extend_from_slice(b"18446744073709551615\0");
        let mut seen = Vec::new();
        read_frames(&ok[..], |xml| seen.push(xml));
        assert_eq!(seen, ["<init/>"], "the good frame is read, the huge one ends the connection");

        for bad in [format!("{}\0", MAX_FRAME + 1), "99999999999999999999999\0".to_string(), "1".repeat(10_000), "abc\0".to_string()] {
            let mut seen = Vec::new();
            read_frames(bad.as_bytes(), |xml| seen.push(xml));
            assert!(seen.is_empty(), "{bad:.30}");
        }
    }

    #[test]
    fn listens_on_this_machine_unless_asked() {
        let state = XdebugState::default();
        let port = state.listen(0, false, Arc::new(|_| {})).unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        state.shutdown();
    }
}

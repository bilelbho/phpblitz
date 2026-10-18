//! Interactive terminal sessions.
//!
//! Each session is a shell running in a pseudo-terminal (ConPTY on Windows), so
//! programs like `php artisan tinker`, prompts and colors work. Output is sent to
//! the UI as base64 `pty-output` events (bytes, not text: a UTF-8 character can be
//! split across reads, and xterm.js decodes the stream itself).

use std::collections::HashMap;
use std::io::Read;
#[cfg(windows)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Queue to the writer thread that owns the terminal's input.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

impl PtyState {
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, s) in sessions.drain() {
                let _ = s.child.lock().map(|mut c| c.kill());
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: u32,
    code: Option<u32>,
}

#[derive(Serialize)]
pub struct Shell {
    name: String,
    path: String,
    args: Vec<String>,
}

/// Shells available on this machine, the default first.
#[tauri::command]
pub async fn terminal_shells() -> Vec<Shell> {
    tauri::async_runtime::spawn_blocking(shells).await.unwrap_or_default()
}

fn shells() -> Vec<Shell> {
    fn add(out: &mut Vec<Shell>, name: &str, path: String, args: &[&str]) {
        out.push(Shell { name: name.into(), path, args: args.iter().map(|s| s.to_string()).collect() });
    }
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        let found = |names: &[&str]| crate::process::find_executable_blocking(names.iter().map(|s| s.to_string()).collect());
        if let Some(p) = found(&["powershell"]) {
            add(&mut out, "Windows PowerShell", p, &["-NoLogo"]);
        }
        if let Some(p) = found(&["pwsh"]) {
            add(&mut out, "PowerShell 7", p, &["-NoLogo"]);
        }
        if let Some(p) = found(&["cmd"]) {
            add(&mut out, "Command Prompt", p, &[]);
        }
        // Git for Windows: bash.exe sits next to the git folder, not on PATH.
        let git_bash = found(&["git"])
            .map(PathBuf::from)
            .and_then(|git| git.parent()?.parent().map(|root| root.join("bin").join("bash.exe")))
            .filter(|p| p.is_file())
            .or_else(|| Some(PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")).filter(|p| p.is_file()));
        if let Some(p) = git_bash {
            add(&mut out, "Git Bash", crate::fs::norm(&p), &["--login", "-i"]);
        }
        if let Some(p) = found(&["wsl"]) {
            add(&mut out, "WSL", p, &[]);
        }
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let name = shell.rsplit('/').next().unwrap_or("shell").to_string();
        add(&mut out, &name, shell, &["-l"]);
        for (name, path) in [("bash", "/bin/bash"), ("zsh", "/bin/zsh"), ("fish", "/usr/bin/fish")] {
            if std::path::Path::new(path).exists() && !out.iter().any(|s| s.path == path) {
                add(&mut out, name, path.into(), &["-l"]);
            }
        }
    }
    out
}

const PWSH_INTEGRATION: &str = include_str!("shell/integration.ps1");
const BASH_INTEGRATION: &str = include_str!("shell/integration.bash");

/// Adds shell integration: the shell marks each prompt and the exit code of the last command
/// (OSC 133), which the terminal uses to draw command blocks. Shells it doesn't know run as is.
fn with_integration(shell: &str, args: Vec<String>, cmd: &mut CommandBuilder) -> Vec<String> {
    let exe = std::path::Path::new(shell)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let has = |flags: &[&str]| args.iter().any(|a| flags.iter().any(|f| a.eq_ignore_ascii_case(f)));
    match exe.as_str() {
        // -EncodedCommand (UTF-16LE, base64) runs under any execution policy, unlike a .ps1 file.
        "powershell" | "pwsh" if !has(&["-command", "-c", "-file", "-f", "-encodedcommand"]) => {
            let utf16: Vec<u8> = PWSH_INTEGRATION.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            let mut out = args;
            out.extend(["-NoExit".into(), "-EncodedCommand".into(), base64::engine::general_purpose::STANDARD.encode(utf16)]);
            out
        }
        "bash" if !has(&["-c", "--rcfile", "--init-file"]) => {
            let dir = std::env::temp_dir().join("phpblitz");
            let file = dir.join("integration.bash");
            let written = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, BASH_INTEGRATION));
            if written.is_err() {
                return args;
            }
            // --init-file replaces --login; the script loads the login files itself.
            let mut out: Vec<String> = args.into_iter().filter(|a| a != "--login" && a != "-l" && a != "-i").collect();
            out.extend(["--init-file".into(), crate::fs::norm(&file), "-i".into()]);
            out
        }
        "cmd" if !has(&["/c", "/k"]) => {
            // cmd has no exit code in its prompt; it still marks where each command starts.
            cmd.env("PROMPT", r"$e]133;D$e\$e]133;A$e\$P$G$e]133;B$e\");
            args
        }
        _ => args,
    }
}

/// Starts a shell in a pseudo-terminal and returns the session id.
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    shell: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    env: Vec<(String, String)>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Could not open a terminal: {e}"))?;
    let mut cmd = CommandBuilder::new(&shell);
    let args = with_integration(&shell, args, &mut cmd);
    cmd.args(&args);
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "PHPBlitz");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Could not start {shell}: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = Arc::new(Mutex::new(child));
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    let exit_child = Arc::clone(&child);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let engine = base64::engine::general_purpose::STANDARD;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit("pty-output", Output { id, data: engine.encode(&buf[..n]) });
                }
            }
        }
        let code = exit_child.lock().ok().and_then(|mut c| c.wait().ok()).map(|s| s.exit_code());
        let _ = app.emit("pty-exit", Exit { id, code });
    });

    state.sessions.lock().map_err(|e| e.to_string())?.insert(id, Session { master: pair.master, input: crate::process::spawn_writer(writer), child });
    Ok(id)
}

/// Keyboard input (and pasted text) for a session, queued for its writer thread: a big paste
/// never blocks the UI.
#[tauri::command(async)]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get(&id).ok_or("The terminal session has ended")?;
    s.input.send(data.into_bytes()).map_err(|_| "The terminal session has ended".to_string())
}

#[tauri::command(async)]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get(&id).ok_or("The terminal session has ended")?;
    s.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = s.child.lock().map(|mut c| c.kill());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs a real shell in a pseudo-terminal and reads its output back.
    #[test]
    fn runs_a_shell_in_a_pty() {
        let shells = shells();
        assert!(!shells.is_empty(), "at least one shell is found");
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        #[cfg(windows)]
        let mut cmd = {
            let mut c = CommandBuilder::new("cmd");
            c.args(["/C", "echo phpblitz-%PROCESSOR_ARCHITECTURE%"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = CommandBuilder::new("sh");
            c.args(["-c", "echo phpblitz-ok"]);
            c
        };
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        // Act as the terminal: ConPTY asks for the cursor position (ESC[6n) before printing.
        let mut all = Vec::new();
        let mut answered = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline && !String::from_utf8_lossy(&all).contains("phpblitz-") {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                all.extend_from_slice(&chunk);
                if !answered && String::from_utf8_lossy(&all).contains("\x1b[6n") {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                    answered = true;
                }
            }
        }
        let output = String::from_utf8_lossy(&all).into_owned();
        assert!(output.contains("phpblitz-"), "{output:?}");
        let _ = child.wait();
    }

    /// Runs `shell` with integration, types `input` at the first prompt and returns the output
    /// once `done` matches it (or after the timeout).
    fn run_integrated(shell: &str, args: &[&str], input: &str, done: impl Fn(&str) -> bool) -> String {
        let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(shell);
        let args = with_integration(shell, args.iter().map(|s| s.to_string()).collect(), &mut cmd);
        cmd.args(&args);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut all = String::new();
        let (mut answered, mut typed) = (0, false);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline && !done(&all) {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                all.push_str(&String::from_utf8_lossy(&chunk));
                // Answer every cursor-position request, as xterm.js would.
                let asked = all.matches("\x1b[6n").count();
                while answered < asked {
                    writer.write_all(b"\x1b[1;1R").unwrap();
                    answered += 1;
                }
                if !typed && all.contains("\x1b]133;B") {
                    writer.write_all(input.as_bytes()).unwrap();
                    typed = true;
                }
            }
        }
        let _ = child.kill();
        all
    }

    #[cfg(windows)]
    #[test]
    fn powershell_reports_exit_codes() {
        let Some(ps) = crate::process::find_executable_blocking(vec!["powershell".into()]) else { return };
        let out = run_integrated(&ps, &["-NoLogo", "-NoProfile"], "cmd /c exit 3\r", |o| o.contains("133;D;"));
        assert!(out.contains("\x1b]133;A"), "prompt mark: {out:?}");
        assert!(out.contains("\x1b]133;D;3\x07"), "exit code 3: {out:?}");
    }

    #[test]
    fn bash_reports_exit_codes() {
        let bash = shells().into_iter().find(|s| s.path.to_ascii_lowercase().ends_with("bash.exe") || s.path.ends_with("/bash"));
        let Some(bash) = bash else { return };
        let args: Vec<&str> = bash.args.iter().map(|s| s.as_str()).collect();
        let out = run_integrated(&bash.path, &args, "false\r", |o| o.contains("133;D;"));
        assert!(out.contains("\x1b]133;D;1\x07"), "exit code 1: {out:?}");
    }
}

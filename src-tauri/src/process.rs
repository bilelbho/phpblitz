//! Running external tools: git, php, composer, and terminal command lines.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
pub struct RunResult {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Never flash a console window for child processes on Windows.
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn exec(cwd: &str, mut cmd: Command, label: &str) -> Result<RunResult, String> {
    cmd.current_dir(cwd);
    hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("Could not start {label}: {e}"))?;
    Ok(RunResult {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Runs a program directly (no shell), e.g. `git status` or `php -l file.php`.
#[tauri::command]
pub async fn run_process(cwd: String, program: String, args: Vec<String>) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&program);
        cmd.args(&args);
        exec(&cwd, cmd, &program)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs a command line through the system shell, for the terminal tab and
/// tools that ship as shell scripts (composer.bat on Windows).
#[tauri::command]
pub async fn run_shell(cwd: String, line: String) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new("cmd");
            c.raw_arg(format!("/C {line}"));
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = Command::new("sh");
            c.arg("-c").arg(&line);
            c
        };
        exec(&cwd, cmd, "shell")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shows a file in the system file manager (Explorer, Finder, …) with it selected.
#[tauri::command(async)]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let native = std::path::Path::new(&path);
    if !native.exists() {
        return Err(format!("{path} does not exist"));
    }
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        let windows_path = path.replace('/', "\\");
        Command::new("explorer").raw_arg(format!("/select,\"{windows_path}\"")).spawn()
    };
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(native).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(native.parent().unwrap_or(native)).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Opens an http(s) link in the default browser (links clicked in the terminal).
#[tauri::command(async)]
pub fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.chars().any(|c| c.is_control() || c == '"') {
        return Err("Only http and https links can be opened".into());
    }
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        // `start "" "url"`: the empty title keeps `start` from treating the URL as a window title.
        c.raw_arg(format!("/C start \"\" \"{url}\""));
        hide_console(&mut c);
        c.spawn()
    };
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Finds the first of `names` on PATH or in ~/.cargo/bin (where `cargo install`
/// puts language servers; GUI apps often start without it on PATH).
#[tauri::command]
pub async fn find_executable(names: Vec<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || find_executable_blocking(names)).await.ok().flatten()
}

/// [`find_executable`] for Rust callers.
pub fn find_executable_blocking(names: Vec<String>) -> Option<String> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    if let Some(home) = home {
        dirs.push(PathBuf::from(home).join(".cargo").join("bin"));
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    for name in &names {
        for dir in &dirs {
            for ext in exts {
                let candidate = dir.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return Some(crate::fs::norm(&candidate));
                }
            }
        }
    }
    None
}

/// Whether this copy can install updates itself. Everything can (the Windows installers, the macOS
/// app, the AppImage, and .deb / .rpm through a password prompt) except the portable Windows zip,
/// which is replaced by hand.
#[tauri::command]
pub fn updater_supported() -> bool {
    #[cfg(target_os = "windows")]
    return !portable();
    #[cfg(not(target_os = "windows"))]
    return true;
}

/// The portable zip: no uninstaller next to the exe (the NSIS installer writes uninstall.exe) and
/// not under Program Files (where the MSI installs).
#[cfg(target_os = "windows")]
fn portable() -> bool {
    let Ok(exe) = std::env::current_exe() else { return true };
    let Some(dir) = exe.parent() else { return true };
    if dir.join("uninstall.exe").exists() {
        return false;
    }
    let program_files = [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramW6432")];
    !program_files.iter().flatten().any(|pf| dir.starts_with(pf))
}

/// Long-running tools whose output is shown as it comes (project generators): id → process id.
#[derive(Default)]
pub struct JobState {
    jobs: std::sync::Mutex<std::collections::HashMap<u32, u32>>,
}

#[derive(Clone, Serialize)]
struct JobOutput {
    id: u32,
    text: String,
}

/// Runs a command line through the system shell and streams stdout and stderr as `job-output`
/// events, line by line; returns the exit code. Tools run without a terminal and without input,
/// with the environment variables that make them pick defaults instead of asking (CI=1, …).
#[tauri::command]
pub async fn job_run(app: tauri::AppHandle, state: tauri::State<'_, JobState>, id: u32, cwd: String, line: String) -> Result<i32, String> {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.raw_arg(format!("/C {line}"));
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&line);
        c
    };
    cmd.env("CI", "1")
        .env("COMPOSER_NO_INTERACTION", "1")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("npm_config_yes", "true")
        .env("npm_config_fund", "false")
        .env("npm_config_update_notifier", "false");
    stream_job(app, &state, id, &cwd, cmd).await
}

/// Runs a program (no shell) and streams its output like `job_run`: test runs, whose output is
/// read as it comes.
#[tauri::command]
pub async fn job_exec(app: tauri::AppHandle, state: tauri::State<'_, JobState>, id: u32, cwd: String, program: String, args: Vec<String>) -> Result<i32, String> {
    let mut cmd = Command::new(&program);
    cmd.args(&args);
    stream_job(app, &state, id, &cwd, cmd).await
}

async fn stream_job(app: tauri::AppHandle, state: &JobState, id: u32, cwd: &str, mut cmd: Command) -> Result<i32, String> {
    use std::io::BufRead;
    use std::process::Stdio;
    use tauri::Emitter;

    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so stopping it stops the processes it started too.
        cmd.process_group(0);
    }
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the command: {e}"))?;
    state.jobs.lock().map_err(|e| e.to_string())?.insert(id, child.id());

    let pipes: Vec<Box<dyn std::io::Read + Send>> = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let app = app.clone();
            std::thread::spawn(move || {
                let mut reader = std::io::BufReader::new(pipe);
                let mut buf = Vec::new();
                while reader.read_until(b'\n', &mut buf).is_ok_and(|n| n > 0) {
                    let _ = app.emit("job-output", JobOutput { id, text: String::from_utf8_lossy(&buf).into_owned() });
                    buf.clear();
                }
            })
        })
        .collect();
    let status = tauri::async_runtime::spawn_blocking(move || child.wait()).await.map_err(|e| e.to_string())?;
    for r in readers {
        let _ = r.join();
    }
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(&id);
    }
    Ok(status.map_err(|e| e.to_string())?.code().unwrap_or(-1))
}

/// Stops a job started with `job_run`, with the processes it started.
#[tauri::command(async)]
pub fn job_kill(state: tauri::State<'_, JobState>, id: u32) -> Result<(), String> {
    let Some(pid) = state.jobs.lock().map_err(|e| e.to_string())?.get(&id).copied() else {
        return Ok(());
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &pid.to_string()]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("kill");
        c.args(["-TERM", "--", &format!("-{pid}")]);
        c
    };
    hide_console(&mut cmd);
    cmd.output().map_err(|e| e.to_string())?;
    Ok(())
}

/// A thread that owns a child's input (a language server's stdin, a terminal) and writes what is
/// queued to it. Commands only queue bytes, so a slow reader never blocks them or holds a lock.
/// The thread ends when the sender is dropped or a write fails.
pub fn spawn_writer(mut writer: impl std::io::Write + Send + 'static) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for bytes in rx {
            if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::spawn_writer;
    use std::sync::{Arc, Mutex};

    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            // A slow reader: queuing must not wait for it.
            std::thread::sleep(std::time::Duration::from_millis(20));
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writer_thread_keeps_order_without_blocking_the_sender() {
        let out = Arc::new(Mutex::new(Vec::new()));
        let tx = spawn_writer(Shared(Arc::clone(&out)));
        let started = std::time::Instant::now();
        for chunk in ["one ", "two ", "three"] {
            tx.send(chunk.as_bytes().to_vec()).unwrap();
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(20), "sending queues, it doesn't write");
        for _ in 0..100 {
            if out.lock().unwrap().len() == 13 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(String::from_utf8(out.lock().unwrap().clone()).unwrap(), "one two three");
    }
}

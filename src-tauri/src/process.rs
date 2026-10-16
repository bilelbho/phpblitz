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
#[tauri::command]
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
#[tauri::command]
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

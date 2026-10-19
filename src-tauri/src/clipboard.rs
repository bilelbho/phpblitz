// Reading the clipboard natively, for Paste in the terminal's menu: the web view's
// navigator.clipboard.readText makes the user allow "see text copied to the clipboard" first.
// (Writing needs no permission and stays in the UI.)

/// The clipboard's text; empty when it holds none (an image, files).
#[tauri::command(async)]
pub fn clipboard_read_text() -> Result<String, String> {
    read()
}

#[cfg(windows)]
fn read() -> Result<String, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;

    // SAFETY: the clipboard is opened and closed here, and its memory is only read between
    // GlobalLock and GlobalUnlock, up to the terminating NUL of CF_UNICODETEXT.
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
            return Ok(String::new());
        }
        // Another program may hold the clipboard for a moment.
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            return Err("The clipboard is in use by another program.".into());
        }
        let text = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT).map_err(|e| e.to_string())?;
            let memory = HGLOBAL(handle.0);
            let ptr = GlobalLock(memory) as *const u16;
            if ptr.is_null() {
                return Err("Couldn't read the clipboard.".to_string());
            }
            let mut len = 0;
            while *ptr.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
            let _ = GlobalUnlock(memory);
            Ok(text)
        })();
        let _ = CloseClipboard();
        text
    }
}

#[cfg(not(windows))]
fn read() -> Result<String, String> {
    use std::process::Command;
    // macOS: pbpaste. Linux: Wayland's wl-paste, else X11's xclip or xsel.
    let tools: Vec<(&str, Vec<&str>)> = if cfg!(target_os = "macos") {
        vec![("pbpaste", vec![])]
    } else {
        vec![("wl-paste", vec!["--no-newline"]), ("xclip", vec!["-selection", "clipboard", "-o"]), ("xsel", vec!["--clipboard", "--output"])]
    };
    for (program, args) in tools {
        if let Ok(out) = Command::new(program).args(&args).output() {
            if out.status.success() {
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
            }
        }
    }
    Err("Couldn't read the clipboard: install wl-clipboard (Wayland) or xclip (X11).".into())
}

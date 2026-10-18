//! The project's `.blitz` folder:
//!
//! ```text
//! .blitz/
//!   .gitignore       cache/ and workspace.json: machine-specific, never committed
//!   project.json     project settings to share (PHP, excluded folders, data sources…)
//!   workspace.json   this machine's state (bookmarks, recent files, debugger watches…)
//!   cache/           rebuildable data (index.bin: the symbol index)
//! ```

use std::path::{Path, PathBuf};

pub const DIR: &str = ".blitz";

const GITIGNORE: &str = "# PHPBlitz: machine-specific files. project.json can be committed.\ncache/\nworkspace.json\n";

/// The project's `.blitz` folder, created (with its .gitignore) if missing.
pub fn dir(root: &str) -> std::io::Result<PathBuf> {
    let dir = Path::new(root).join(DIR);
    std::fs::create_dir_all(&dir)?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(ignore, GITIGNORE)?;
    }
    Ok(dir)
}

/// `.blitz/cache`, created if missing.
pub fn cache_dir(root: &str) -> std::io::Result<PathBuf> {
    let dir = dir(root)?.join("cache");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Writes a file atomically, so a crash never leaves half a file (see [`crate::fs::write_atomic`]).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    crate::fs::write_atomic(path, bytes)
}

/// Only these files can be read and written by the UI.
fn settings_file(root: &str, name: &str) -> Result<PathBuf, String> {
    match name {
        "project.json" | "workspace.json" => Ok(Path::new(root).join(DIR).join(name)),
        _ => Err(format!("not a .blitz settings file: {name}")),
    }
}

/// `.blitz/project.json` or `workspace.json`; `None` when it doesn't exist yet.
#[tauri::command]
pub async fn blitz_read(root: String, name: String) -> Result<Option<String>, String> {
    let path = settings_file(&root, &name)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn blitz_write(root: String, name: String, text: String) -> Result<(), String> {
    let path = settings_file(&root, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        dir(&root).map_err(|e| e.to_string())?;
        write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_folder_with_its_gitignore() {
        let root = std::env::temp_dir().join(format!("phpblitz-blitz-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let r = crate::fs::norm(&root);
        let cache = cache_dir(&r).unwrap();
        assert!(cache.ends_with(".blitz/cache") || cache.ends_with(".blitz\\cache"));
        let ignore = std::fs::read_to_string(root.join(".blitz/.gitignore")).unwrap();
        assert!(ignore.contains("cache/") && ignore.contains("workspace.json") && !ignore.contains("project.json\n"));
        // A .gitignore the user edited is kept.
        std::fs::write(root.join(".blitz/.gitignore"), "mine\n").unwrap();
        dir(&r).unwrap();
        assert_eq!(std::fs::read_to_string(root.join(".blitz/.gitignore")).unwrap(), "mine\n");
        assert!(settings_file(&r, "../secrets").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

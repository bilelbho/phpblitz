//! File system commands: directory listing, project file walk, read and write.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Directories that are never walked when building the project file list.
const SKIPPED_DIRS: [&str; 5] = [".git", ".idea", "node_modules", "vendor", "storage"];
const MAX_FILES: usize = 50_000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    /// Last modification time in milliseconds since 1970, for "Sort By ▸ Modification Time".
    modified: u64,
}

/// Paths always cross the bridge with forward slashes, on every OS.
pub fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        out.push(Entry { name, path: norm(&entry.path()), is_dir, modified });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut stack = vec![PathBuf::from(&root)];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !SKIPPED_DIRS.contains(&name.as_str()) {
                        stack.push(entry.path());
                    }
                } else {
                    out.push(norm(&entry.path()));
                    if out.len() >= MAX_FILES {
                        return out;
                    }
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("File is larger than 5 MB".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Creates a new file; fails instead of overwriting an existing one.
#[tauri::command]
pub async fn create_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{} already exists", p.file_name().map_or(path.clone(), |n| n.to_string_lossy().into_owned())),
        _ => e.to_string(),
    })?;
    std::io::Write::write_all(&mut file, content.as_bytes()).map_err(|e| e.to_string())
}

fn file_name(p: &Path) -> String {
    p.file_name().map_or_else(|| p.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

/// Renames or moves a file or folder; never replaces something that already exists.
#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    let (src, dst) = (Path::new(&from), Path::new(&to));
    if !src.exists() {
        return Err(format!("{} no longer exists", file_name(src)));
    }
    // A case-only rename (User.php → user.php) is the same file on Windows: allow it.
    let same_file = from.eq_ignore_ascii_case(&to);
    if dst.exists() && !same_file {
        return Err(format!("{} already exists", file_name(dst)));
    }
    if dst.starts_with(src) && !same_file {
        return Err("Can't move a folder into itself".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

/// Copies a file or a whole folder to a new path that must not exist yet.
#[tauri::command]
pub async fn copy_path(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (src, dst) = (Path::new(&from), Path::new(&to));
        if dst.exists() {
            return Err(format!("{} already exists", file_name(dst)));
        }
        if dst.starts_with(src) {
            return Err("Can't copy a folder into itself".into());
        }
        copy_recursive(src, dst).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)?.flatten() {
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst).map(|_| ())
    }
}

/// Moves files and folders to the Recycle Bin (Trash on macOS/Linux), so a delete can be undone.
#[tauri::command]
pub async fn delete_to_trash(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let native: Vec<PathBuf> = paths.iter().map(|p| PathBuf::from(p.replace('/', std::path::MAIN_SEPARATOR_STR))).collect();
        trash::delete_all(&native).map_err(|e| format!("Could not move to the Recycle Bin: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn rename_and_copy_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("phpblitz-fs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("app/Models")).unwrap();
        fs::write(dir.join("app/Models/User.php"), "<?php // user").unwrap();
        fs::write(dir.join("app/Models/Post.php"), "<?php // post").unwrap();
        let p = |rel: &str| norm(&dir.join(rel));

        // Rename into an existing name is refused; a free name works.
        assert!(run(rename_path(p("app/Models/User.php"), p("app/Models/Post.php"))).unwrap_err().contains("already exists"));
        run(rename_path(p("app/Models/User.php"), p("app/Models/Customer.php"))).unwrap();
        assert!(dir.join("app/Models/Customer.php").exists() && !dir.join("app/Models/User.php").exists());
        // Case-only rename is allowed (same file on Windows).
        run(rename_path(p("app/Models/Customer.php"), p("app/Models/customer.php"))).unwrap();
        // A folder can't move into itself.
        assert!(run(rename_path(p("app"), p("app/Models/app"))).is_err());

        // Copying a folder copies its content; existing targets and copies into itself are refused.
        run(copy_path(p("app/Models"), p("app/Entities"))).unwrap();
        assert_eq!(fs::read_to_string(dir.join("app/Entities/Post.php")).unwrap(), "<?php // post");
        assert!(run(copy_path(p("app/Models"), p("app/Entities"))).is_err());
        assert!(run(copy_path(p("app"), p("app/Models/copy"))).is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}

/// Creates a directory (and missing parents); fails if something already has that name.
#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("{} already exists", p.file_name().map_or(path.clone(), |n| n.to_string_lossy().into_owned())));
    }
    fs::create_dir_all(p).map_err(|e| e.to_string())
}

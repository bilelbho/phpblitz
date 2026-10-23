//! File system commands: directory listing, project file walk, read and write.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::project::{skips, Excluded, Purpose};

/// Directories that are never walked when building the project file list.
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
pub async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_blocking(&path)).await.map_err(|e| e.to_string())?
}

fn list_dir_blocking(path: &str) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
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
    // Folders first, then by name ignoring case (each name lowered once, not per comparison).
    out.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub async fn list_files(root: String, excludes: Option<Vec<String>>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let excluded = Excluded::new(&root, &excludes.unwrap_or_default());
        let mut out = Vec::new();
        let mut stack = vec![PathBuf::from(&root)];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !skips(&name, Purpose::Files) && !excluded.contains(&norm(&entry.path())) {
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
    // Disk reads on a blocking thread: a slow disk (or a busy one, during indexing) never holds up
    // the async workers that answer the UI.
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_FILE_BYTES {
            return Err("File is larger than 5 MB".into());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves a file atomically (see [`write_atomic`]), off the async workers. With the project's
/// `root`, the save is kept in Local History (see [`crate::history`]).
#[tauri::command]
pub async fn write_file(path: String, content: String, root: Option<String>) -> Result<(), String> {
    blocking(move || {
        if let Some(root) = root {
            crate::history::record(&root, &path, &content);
        }
        write_atomic(Path::new(&path), content.as_bytes()).map_err(|e| e.to_string())
    })
    .await
}

/// Runs blocking file work on a blocking thread, so the async workers stay free for the UI.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Replaces a file's content without a moment where it is half written: a crash or power loss
/// mid-save leaves the old content or the new one, never a truncated file. The new content goes
/// to a temp file in the same folder (a unique name, flushed to disk), which is then renamed over
/// the original. A symlink keeps pointing where it did: the file it points to is replaced. On
/// Unix the original's permissions are kept.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let is_link = fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let target = if is_link { fs::canonicalize(path)? } else { path.to_path_buf() };
    let dir = target.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = target.file_name().map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
    let n = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}.{n}.blitz-tmp", std::process::id()));

    let written = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        Ok(())
    })();
    let result = written.and_then(|()| fs::rename(&tmp, &target));
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            // Windows refuses to replace a file another program holds open (some editors,
            // indexers, antivirus scans): save in place rather than not at all.
            if cfg!(windows) && e.kind() == std::io::ErrorKind::PermissionDenied && target.is_file() {
                return fs::write(&target, bytes);
            }
            Err(e)
        }
    }
}

/// Creates a new file; fails instead of overwriting an existing one.
#[tauri::command]
pub async fn create_file(path: String, content: String) -> Result<(), String> {
    blocking(move || create_file_blocking(&path, &content)).await
}

fn create_file_blocking(path: &str, content: &str) -> Result<(), String> {
    let path = path.to_string();
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
    blocking(move || rename_blocking(&from, &to)).await
}

/// Whether two paths are the same file on disk (by identity, not by name).
fn is_same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        // Windows resolves both to the name as it is on disk.
        match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
    }
}

fn rename_blocking(from: &str, to: &str) -> Result<(), String> {
    let (src, dst) = (Path::new(from), Path::new(to));
    if !src.exists() {
        return Err(format!("{} no longer exists", file_name(src)));
    }
    // A case-only rename (User.php → user.php) is the same file on Windows and macOS: allow it. On
    // Linux they can be two files, and renaming would replace the other one.
    let same_file = from.eq_ignore_ascii_case(to) && is_same_file(src, dst);
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

/// Whether a file is read-only on disk (the status bar lock).
#[tauri::command]
pub async fn is_readonly(path: String) -> Result<bool, String> {
    blocking(move || fs::metadata(&path).map(|m| m.permissions().readonly()).map_err(|e| e.to_string())).await
}

/// Makes a file read-only, or writable again (on Unix: the owner's write bit).
#[tauri::command]
pub async fn set_readonly(path: String, readonly: bool) -> Result<(), String> {
    blocking(move || set_readonly_flag(Path::new(&path), readonly).map_err(|e| e.to_string())).await
}

fn set_readonly_flag(path: &Path, readonly: bool) -> std::io::Result<()> {
    let mut perms = fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = perms.mode();
        perms.set_mode(if readonly { mode & !0o222 } else { mode | 0o200 });
    }
    #[cfg(not(unix))]
    perms.set_readonly(readonly);
    fs::set_permissions(path, perms)
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

    /// On a case-sensitive disk, User.php and user.php are two files: renaming one onto the other
    /// is refused. Where they are one file (Windows, macOS), the case-only rename works.
    #[test]
    fn case_only_rename_never_replaces_another_file() {
        let dir = std::env::temp_dir().join(format!("phpblitz-case-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("User.php"), "upper").unwrap();
        fs::write(dir.join("user.php"), "lower").unwrap();
        let p = |rel: &str| norm(&dir.join(rel));
        let two_files = fs::read_to_string(dir.join("User.php")).unwrap() == "upper";
        let result = run(rename_path(p("User.php"), p("user.php")));
        if two_files {
            assert!(result.unwrap_err().contains("already exists"));
            assert_eq!(fs::read_to_string(dir.join("user.php")).unwrap(), "lower", "the other file is untouched");
        } else {
            result.unwrap();
            assert!(fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name() == "user.php"), "renamed to the new case");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}

/// Creates a directory (and missing parents); fails if something already has that name.
#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    blocking(move || {
        let p = Path::new(&path);
        if p.exists() {
            return Err(format!("{} already exists", p.file_name().map_or(path.clone(), |n| n.to_string_lossy().into_owned())));
        }
        fs::create_dir_all(p).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod atomic_tests {
    use super::write_atomic;
    use std::fs;

    #[test]
    fn file_list_skips_dependencies_generated_and_excluded_folders() {
        let root = temp_dir("list");
        for f in ["app/User.php", "vendor/x/Y.php", "node_modules/a/b.js", "legacy/Old.php", "public/build/app.js", "public/index.php", ".git/HEAD"] {
            let p = root.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "x").unwrap();
        }
        let root_s = super::norm(&root);
        let mut files: Vec<String> = tauri::async_runtime::block_on(super::list_files(root_s.clone(), Some(vec!["legacy".into(), "public/build".into()])))
            .unwrap()
            .into_iter()
            .map(|f| f.trim_start_matches(&format!("{root_s}/")).to_string())
            .collect();
        files.sort();
        assert_eq!(files, ["app/User.php", "public/index.php"]);
        let _ = fs::remove_dir_all(&root);
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("phpblitz-atomic-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_the_content_and_leaves_no_temp_file() {
        let dir = temp_dir("replace");
        let file = dir.join("User.php");
        fs::write(&file, "<?php // old, longer content than the new one").unwrap();
        write_atomic(&file, b"<?php // new").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "<?php // new");
        write_atomic(&dir.join("Created.php"), b"x").unwrap();
        let names: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 2, "only the two files, no temp file: {names:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("unix");
        let real = dir.join("script.sh");
        fs::write(&real, "#!/bin/sh\necho old\n").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).unwrap();
        let link = dir.join("link.sh");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"#!/bin/sh\necho new\n").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link stays a link");
        assert_eq!(fs::read_to_string(&real).unwrap(), "#!/bin/sh\necho new\n");
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o755);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod readonly_tests {
    use super::*;

    #[test]
    fn toggles_read_only() {
        let file = std::env::temp_dir().join(format!("phpblitz-ro-{}.txt", std::process::id()));
        fs::write(&file, "x").unwrap();
        set_readonly_flag(&file, true).unwrap();
        assert!(fs::metadata(&file).unwrap().permissions().readonly());
        set_readonly_flag(&file, false).unwrap();
        assert!(!fs::metadata(&file).unwrap().permissions().readonly());
        fs::remove_file(&file).unwrap();
    }
}

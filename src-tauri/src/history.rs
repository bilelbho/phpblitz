//! Local History: every save keeps a copy of the file, so versions that were never committed can
//! be looked at and brought back.
//!
//! ```text
//! .blitz/cache/history/
//!   <hash of the relative path>/
//!     path              the file's path, relative to the project
//!     <millis>          one saved version (its text)
//! ```
//!
//! A save records the text on disk before it (the first time, that's the original) and the new
//! text; a version equal to the newest one isn't stored twice. Each file keeps at most
//! [`MAX_VERSIONS`] versions, none older than [`MAX_AGE`]; files over [`MAX_BYTES`] aren't kept.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_VERSIONS: usize = 100;
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// FNV-1a: a folder name that stays the same across builds (std's hasher may not).
fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The path relative to the project, with `/`; `None` outside it.
fn relative(root: &str, path: &str) -> Option<String> {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_string();
    let (root, path) = (norm(root), norm(path));
    // Windows paths compare without case.
    let prefix = format!("{root}/");
    let head = path.get(..prefix.len())?;
    let same = if cfg!(windows) { head.eq_ignore_ascii_case(&prefix) } else { head == prefix };
    let rel = same.then(|| path[prefix.len()..].to_string())?;
    // The IDE's own files have no history.
    (!rel.starts_with(".blitz/") && !rel.starts_with(".git/")).then_some(rel)
}

fn file_dir(root: &str, rel: &str) -> std::io::Result<PathBuf> {
    let key = if cfg!(windows) { rel.to_lowercase() } else { rel.to_string() };
    Ok(crate::blitz::cache_dir(root)?.join("history").join(hash(&key)))
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The versions' times, newest first.
fn versions(dir: &Path) -> Vec<u64> {
    let mut times: Vec<u64> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse().ok())
        .collect();
    times.sort_unstable_by(|a, b| b.cmp(a));
    times
}

/// Stores `text` as a new version unless it's the newest one already; drops old versions.
fn add(dir: &Path, text: &str, time: u64) -> std::io::Result<()> {
    let times = versions(dir);
    if let Some(newest) = times.first() {
        if std::fs::read_to_string(dir.join(newest.to_string())).is_ok_and(|t| t == text) {
            return Ok(());
        }
    }
    // Two saves in the same millisecond: the later one goes just after.
    let time = times.first().map_or(time, |&newest| time.max(newest + 1));
    std::fs::write(dir.join(time.to_string()), text)?;
    let oldest_kept = time.saturating_sub(MAX_AGE.as_millis() as u64);
    for (i, t) in std::iter::once(time).chain(times).enumerate() {
        if i >= MAX_VERSIONS || t < oldest_kept {
            let _ = std::fs::remove_file(dir.join(t.to_string()));
        }
    }
    Ok(())
}

/// Files with secrets (.env, .env.local…): no copies of them pile up in the history.
fn is_secret(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == ".env" || name.starts_with(".env.")
}

/// Called by a save, before the file is written: keeps the text on disk (if it isn't kept yet)
/// and the new text. Never fails the save: history is best effort.
pub fn record(root: &str, path: &str, new_text: &str) {
    let Some(rel) = relative(root, path) else { return };
    if new_text.len() > MAX_BYTES || is_secret(&rel) {
        return;
    }
    let _ = (|| -> std::io::Result<()> {
        let dir = file_dir(root, &rel)?;
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("path"), &rel)?;
        let time = now_millis();
        if let Ok(old) = std::fs::read_to_string(path) {
            if old != new_text && old.len() <= MAX_BYTES {
                // The version on disk, if the history doesn't end with it (the first save, or a
                // change made outside the IDE).
                let had = versions(&dir).first().is_some_and(|t| std::fs::read_to_string(dir.join(t.to_string())).is_ok_and(|t| t == old));
                if !had {
                    add(&dir, &old, time.saturating_sub(1))?;
                }
            }
        }
        add(&dir, new_text, time)
    })();
}

#[derive(serde::Serialize)]
pub struct Version {
    /// Milliseconds since 1970: the version's id.
    time: u64,
    size: u64,
}

/// A file's saved versions, newest first.
#[tauri::command]
pub async fn history_list(root: String, path: String) -> Result<Vec<Version>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(rel) = relative(&root, &path) else { return Ok(Vec::new()) };
        let dir = file_dir(&root, &rel).map_err(|e| e.to_string())?;
        Ok(versions(&dir)
            .into_iter()
            .map(|time| Version { time, size: std::fs::metadata(dir.join(time.to_string())).map_or(0, |m| m.len()) })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One version's text.
#[tauri::command]
pub async fn history_read(root: String, path: String, time: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rel = relative(&root, &path).ok_or("The file isn't in the project")?;
        let dir = file_dir(&root, &rel).map_err(|e| e.to_string())?;
        std::fs::read_to_string(dir.join(time.to_string())).map_err(|_| "This version is no longer kept".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!("phpblitz-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let s = root.to_string_lossy().replace('\\', "/");
        (root, s)
    }

    fn texts(root: &str, path: &str) -> Vec<String> {
        let dir = file_dir(root, &relative(root, path).unwrap()).unwrap();
        versions(&dir).iter().map(|t| std::fs::read_to_string(dir.join(t.to_string())).unwrap()).collect()
    }

    #[test]
    fn keeps_no_copies_of_env_files() {
        let (dir, root) = project("env");
        for name in [".env", "config/.env.local"] {
            let file = format!("{root}/{name}");
            std::fs::create_dir_all(std::path::Path::new(&file).parent().unwrap()).unwrap();
            std::fs::write(&file, "APP_KEY=old").unwrap();
            record(&root, &file, "APP_KEY=new");
            assert!(versions(&file_dir(&root, name).unwrap()).is_empty(), "{name}");
        }
        assert!(!is_secret("app/Environment.php") && !is_secret("docs/env.md"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_the_original_and_each_save_once() {
        let (dir, root) = project("saves");
        let file = format!("{root}/a.php");
        std::fs::write(&file, "one").unwrap();
        for text in ["two", "two", "three"] {
            record(&root, &file, text);
            std::fs::write(&file, text).unwrap();
        }
        assert_eq!(texts(&root, &file), ["three", "two", "one"]);
        // Changed outside the IDE: that text is kept too before the next save.
        std::fs::write(&file, "outside").unwrap();
        record(&root, &file, "four");
        assert_eq!(texts(&root, &file)[..2], ["four", "outside"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_at_most_the_newest_versions() {
        let (dir, root) = project("limit");
        let file = format!("{root}/b.php");
        let hist = file_dir(&root, "b.php").unwrap();
        std::fs::create_dir_all(&hist).unwrap();
        // An old version, past the age limit, goes on the next save.
        std::fs::write(hist.join("1000"), "ancient").unwrap();
        for i in 0..MAX_VERSIONS + 5 {
            add(&hist, &format!("v{i}"), now_millis()).unwrap();
        }
        let kept = texts(&root, &file);
        assert_eq!(kept.len(), MAX_VERSIONS);
        assert_eq!(kept[0], format!("v{}", MAX_VERSIONS + 4));
        assert!(!kept.contains(&"ancient".to_string()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_project_files() {
        assert_eq!(relative("C:/p", "C:/p/src/A.php").as_deref(), Some("src/A.php"));
        assert_eq!(relative("C:/p", "C:/other/A.php"), None);
        assert_eq!(relative("C:/p", "C:/p/.blitz/project.json"), None);
    }
}

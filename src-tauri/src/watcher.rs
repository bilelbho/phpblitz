//! Watches the open project for changes made outside PHPBlitz (git checkout,
//! composer install, another editor) and tells the UI in batches.
//!
//! Emits `fs-changed` with a list of [`FsChange`]. Busy folders are summarized:
//! any change under `.git` becomes one `git` entry, any under `vendor` one `vendor` entry.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Never reported: dependencies of JavaScript tooling, build output, Laravel's runtime files.
const IGNORED_DIRS: [&str; 5] = ["node_modules", "target", ".idea", "storage", "dist"];

#[derive(Default)]
pub struct WatchState {
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    /// "file" (a project file or folder), "git" (repository state) or "vendor" (Composer packages).
    kind: &'static str,
    path: String,
    /// False when the path was deleted.
    exists: bool,
    is_dir: bool,
}

/// Turns raw watcher paths into the changes the UI cares about.
fn classify(root: &Path, paths: impl IntoIterator<Item = PathBuf>) -> Vec<FsChange> {
    let mut out: Vec<FsChange> = Vec::new();
    let mut push = |c: FsChange| {
        if !out.contains(&c) {
            out.push(c);
        }
    };
    for path in paths {
        let Ok(rel) = path.strip_prefix(root) else { continue };
        let first = rel.components().next().and_then(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        });
        match first {
            None => continue,
            Some(".git") => {
                // Only what changes `git status`: the branch, the index, refs. Not objects or lock files.
                let name = rel.to_string_lossy().replace('\\', "/");
                let relevant = name == ".git/HEAD" || name == ".git/index" || name.starts_with(".git/refs/");
                if relevant && !name.ends_with(".lock") {
                    push(FsChange { kind: "git", path: crate::fs::norm(&root.join(".git")), exists: true, is_dir: true });
                }
            }
            Some("vendor") => push(FsChange { kind: "vendor", path: crate::fs::norm(&root.join("vendor")), exists: true, is_dir: true }),
            Some(dir) if IGNORED_DIRS.contains(&dir) => {}
            Some(_) => push(FsChange { kind: "file", path: crate::fs::norm(&path), exists: path.exists(), is_dir: path.is_dir() }),
        }
    }
    out
}

#[tauri::command]
pub fn watch_start(app: AppHandle, state: tauri::State<'_, WatchState>, root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let watched_root = root_path.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let changes = classify(&watched_root, events.into_iter().map(|e| e.path));
        if !changes.is_empty() {
            let _ = app.emit("fs-changed", changes);
        }
    })
    .map_err(|e| format!("Could not watch the project: {e}"))?;
    debouncer
        .watcher()
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Could not watch {root}: {e}"))?;
    *state.watcher.lock().map_err(|e| e.to_string())? = Some(debouncer);
    Ok(())
}

#[tauri::command]
pub fn watch_stop(state: tauri::State<'_, WatchState>) -> Result<(), String> {
    *state.watcher.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real OS watcher: create, edit and delete files and receive classified, batched changes.
    #[test]
    fn reports_real_file_system_changes() {
        let root = std::env::temp_dir().join(format!("phpblitz-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/Old.php"), "<?php").unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let watched = root.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(150), move |r: DebounceEventResult| {
            if let Ok(events) = r {
                let _ = tx.send(classify(&watched, events.into_iter().map(|e| e.path)));
            }
        })
        .unwrap();
        debouncer.watcher().watch(&root, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        std::fs::write(root.join("app/New.php"), "<?php class NewOne {}").unwrap();
        std::fs::remove_file(root.join("app/Old.php")).unwrap();

        let mut seen: Vec<FsChange> = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !(seen.iter().any(|c| c.path.ends_with("New.php") && c.exists) && seen.iter().any(|c| c.path.ends_with("Old.php") && !c.exists)) {
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.extend(batch);
            }
        }
        assert!(seen.iter().any(|c| c.path.ends_with("app/New.php") && c.exists && c.kind == "file"), "{seen:?}");
        assert!(seen.iter().any(|c| c.path.ends_with("app/Old.php") && !c.exists), "{seen:?}");
        drop(debouncer);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn summarizes_busy_folders_and_skips_noise() {
        let root = std::env::temp_dir().join("phpblitz-watch-classify");
        let p = |rel: &str| root.join(rel);
        let changes = classify(
            &root,
            [
                p("app/User.php"),
                p("app/User.php"),
                p(".git/index"),
                p(".git/refs/heads/main"),
                p(".git/objects/ab/cdef"),
                p(".git/index.lock"),
                p("vendor/laravel/framework/src/A.php"),
                p("vendor/laravel/framework/src/B.php"),
                p("node_modules/x/index.js"),
                p("storage/logs/laravel.log"),
                p("routes/web.php"),
            ],
        );
        let kinds: Vec<(&str, String)> = changes.iter().map(|c| (c.kind, c.path.rsplit('/').next().unwrap().to_string())).collect();
        assert_eq!(
            kinds,
            vec![("file", "User.php".to_string()), ("git", ".git".to_string()), ("vendor", "vendor".to_string()), ("file", "web.php".to_string())]
        );
        assert!(!changes[0].exists, "missing files are reported as deleted");
    }
}

//! Watches the open project for changes made outside PHPBlitz (git checkout,
//! composer install, another editor) and tells the UI in batches.
//!
//! Emits `fs-changed` with a list of [`FsChange`]. Busy folders are summarized:
//! any change under `.git` becomes one `git` entry, any under `vendor` one `vendor` entry.
//!
//! Only what the IDE uses is watched. On Windows one recursive watch is a single handle, so the
//! whole project is watched and noise is filtered. On Linux every watched folder costs an inotify
//! watch (and setting them up walks the tree), so folders are watched one by one, skipping
//! node_modules, .git internals, vendor packages and build output; new folders are added as they
//! appear.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Never reported: dependencies of JavaScript tooling, build output, Laravel's runtime files.
const IGNORED_DIRS: [&str; 5] = ["node_modules", "target", ".idea", "storage", "dist"];
/// Never watched, at any depth.
#[cfg_attr(windows, allow(dead_code))]
const NEVER_WATCHED: [&str; 6] = ["node_modules", ".git", ".idea", ".svn", ".hg", ".cache"];

type Watcher = Arc<Mutex<Option<Debouncer<RecommendedWatcher>>>>;

#[derive(Default)]
pub struct WatchState {
    watcher: Watcher,
}

#[derive(Clone, Serialize, PartialEq, Eq, Hash, Debug)]
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
    let mut seen = HashSet::new();
    let mut push = |c: FsChange| {
        if seen.insert(c.clone()) {
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
            Some(_) if rel.components().any(|c| matches!(c, Component::Normal(s) if s == "node_modules")) => {}
            Some(_) => push(FsChange { kind: "file", path: crate::fs::norm(&path), exists: path.exists(), is_dir: path.is_dir() }),
        }
    }
    out
}

/// Folders to watch one by one (Linux, macOS): the project's own folders, `.git` and its refs,
/// and `vendor` / `vendor/composer` (enough to notice `composer install`).
#[cfg_attr(windows, allow(dead_code))]
fn folders_to_watch(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    for special in [".git", ".git/refs", "vendor", "vendor/composer"] {
        let p = root.join(special);
        if p.is_dir() {
            if special == ".git/refs" {
                out.extend(subfolders(&p, &[]));
            } else {
                out.push(p);
            }
        }
    }
    let Ok(entries) = std::fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && name != "vendor" && !IGNORED_DIRS.contains(&name.as_str()) && !NEVER_WATCHED.contains(&name.as_str()) {
            out.extend(subfolders(&entry.path(), &NEVER_WATCHED));
        }
    }
    out
}

/// `dir` and the folders under it, skipping `skip` names and symlinks.
#[cfg_attr(windows, allow(dead_code))]
fn subfolders(dir: &Path, skip: &[&str]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&d) {
            for entry in entries.flatten() {
                let Ok(t) = entry.file_type() else { continue };
                if t.is_dir() && !t.is_symlink() && !skip.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    stack.push(entry.path());
                }
            }
        }
        out.push(d);
    }
    out
}

#[tauri::command]
pub async fn watch_start(app: AppHandle, state: tauri::State<'_, WatchState>, root: String) -> Result<(), String> {
    let shared = state.watcher.clone();
    // Walking a big project and registering watches takes a while: never on the main thread.
    tauri::async_runtime::spawn_blocking(move || start(app, shared, root)).await.map_err(|e| e.to_string())?
}

fn start(app: AppHandle, shared: Watcher, root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let watched_root = root_path.clone();
    // New folders (Linux, macOS) are added from a helper thread, not the debouncer's callback.
    let (new_dirs, new_dirs_rx) = std::sync::mpsc::channel::<PathBuf>();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let changes = classify(&watched_root, events.into_iter().map(|e| e.path));
        if cfg!(not(windows)) {
            for c in changes.iter().filter(|c| c.kind == "file" && c.exists && c.is_dir) {
                let _ = new_dirs.send(PathBuf::from(&c.path));
            }
        }
        if !changes.is_empty() {
            let _ = app.emit("fs-changed", changes);
        }
    })
    .map_err(|e| format!("Could not watch the project: {e}"))?;

    #[cfg(windows)]
    {
        drop(new_dirs_rx);
        debouncer
            .watcher()
            .watch(&root_path, RecursiveMode::Recursive)
            .map_err(|e| format!("Could not watch {root}: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let folders = folders_to_watch(&root_path);
        let mut failed = None;
        for dir in &folders {
            if let Err(e) = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive) {
                // Usually the inotify limit (fs.inotify.max_user_watches): keep what we have.
                failed.get_or_insert(e);
            }
        }
        if let Some(e) = failed {
            eprintln!("phpblitz: some folders are not watched ({e}); raise fs.inotify.max_user_watches to watch them all");
        }
        let weak = Arc::downgrade(&shared);
        std::thread::spawn(move || {
            while let Ok(dir) = new_dirs_rx.recv() {
                let Some(shared) = weak.upgrade() else { break };
                let Ok(mut guard) = shared.lock() else { break };
                let Some(d) = guard.as_mut() else { continue };
                for sub in subfolders(&dir, &NEVER_WATCHED) {
                    let _ = d.watcher().watch(&sub, RecursiveMode::NonRecursive);
                }
            }
        });
    }

    // The previous project's watcher is dropped here too, off the main thread.
    let old = shared.lock().map_err(|e| e.to_string())?.replace(debouncer);
    drop(old);
    Ok(())
}

#[tauri::command]
pub async fn watch_stop(state: tauri::State<'_, WatchState>) -> Result<(), String> {
    let shared = state.watcher.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let old = shared.lock().map_err(|e| e.to_string())?.take();
        drop(old);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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

    #[test]
    fn watches_project_folders_but_not_dependencies() {
        let root = std::env::temp_dir().join(format!("phpblitz-watch-folders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["app/Models", "node_modules/x/y", "themes/a/node_modules/z", "vendor/laravel/framework", "vendor/composer", ".git/refs/heads", ".git/objects/ab", "storage/logs"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let watched: Vec<String> = folders_to_watch(&root).iter().map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/")).collect();
        for want in ["", "app", "app/Models", "themes", "themes/a", ".git", ".git/refs", ".git/refs/heads", "vendor", "vendor/composer"] {
            assert!(watched.iter().any(|w| w == want), "{want} should be watched: {watched:?}");
        }
        for skip in ["node_modules", "themes/a/node_modules", "vendor/laravel", ".git/objects", "storage"] {
            assert!(!watched.iter().any(|w| w.starts_with(skip)), "{skip} should not be watched: {watched:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}

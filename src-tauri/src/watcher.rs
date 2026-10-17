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
//! appear, shallow folders first.
//!
//! Folders that can't be watched (the inotify limit `fs.inotify.max_user_watches` is reached, or no
//! watcher can be created at all) are polled instead, like VS Code and IntelliJ do: their files'
//! times and sizes are compared every few seconds. `watch_start` reports how many, so the UI can
//! explain how to raise the limit.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Never reported: dependencies of JavaScript tooling, build output, Laravel's runtime files.
const IGNORED_DIRS: [&str; 6] = ["node_modules", "target", ".idea", ".blitz", "storage", "dist"];
/// Never watched, at any depth.
const NEVER_WATCHED: [&str; 7] = ["node_modules", ".git", ".idea", ".blitz", ".svn", ".hg", ".cache"];

/// The open project's watching: OS watches, and the poller for folders without one.
struct Session {
    debouncer: Option<Debouncer<RecommendedWatcher>>,
    /// Owned here only: the polling thread holds a weak reference and stops when this is dropped.
    #[allow(dead_code)]
    poller: Arc<Mutex<Poller>>,
}

type Watcher = Arc<Mutex<Option<Session>>>;

/// What `watch_start` managed to set up.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    /// Folders with an OS watch.
    watched: usize,
    /// Folders checked by polling instead.
    polled: usize,
    /// fs.inotify.max_user_watches (Linux).
    limit: Option<u64>,
    /// Why some folders are polled.
    reason: Option<String>,
}

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

/// `dir` and the folders under it, shallow ones first (they get watches before the limit is
/// reached), skipping `skip` names and symlinks.
fn subfolders(dir: &Path, skip: &[&str]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([dir.to_path_buf()]);
    while let Some(d) = queue.pop_front() {
        if let Ok(entries) = std::fs::read_dir(&d) {
            for entry in entries.flatten() {
                let Ok(t) = entry.file_type() else { continue };
                if t.is_dir() && !t.is_symlink() && !skip.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    queue.push_back(entry.path());
                }
            }
        }
        out.push(d);
    }
    out
}

/// Folders whose changes are found by polling: each one's entries (not recursive), compared with
/// the previous scan by modification time and size.
#[derive(Default)]
struct Poller {
    dirs: Vec<PathBuf>,
    /// Entry path → (modified, size, is_dir) at the last scan.
    seen: HashMap<PathBuf, (Option<SystemTime>, u64, bool)>,
}

impl Poller {
    /// Starts polling `dir` (its current entries are the baseline: nothing is reported for them).
    fn add(&mut self, dir: PathBuf) {
        if self.dirs.contains(&dir) {
            return;
        }
        for (path, meta) in Self::entries(&dir) {
            self.seen.insert(path, meta);
        }
        self.dirs.push(dir);
    }

    fn entries(dir: &Path) -> Vec<(PathBuf, (Option<SystemTime>, u64, bool))> {
        let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
        read.flatten()
            .filter_map(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                if NEVER_WATCHED.contains(&name.as_ref()) || IGNORED_DIRS.contains(&name.as_ref()) {
                    return None;
                }
                let m = e.metadata().ok()?;
                Some((e.path(), (m.modified().ok(), m.len(), m.is_dir())))
            })
            .collect()
    }

    /// Paths created, changed or deleted since the last scan. New folders are polled from now on.
    fn scan(&mut self) -> Vec<PathBuf> {
        let mut changed = Vec::new();
        let mut current = HashSet::new();
        let mut new_dirs = Vec::new();
        for dir in &self.dirs {
            for (path, meta) in Self::entries(dir) {
                current.insert(path.clone());
                match self.seen.get(&path) {
                    Some(old) if *old == meta || (old.2 && meta.2) => {}
                    old => {
                        if meta.2 && old.is_none() {
                            new_dirs.push(path.clone());
                        }
                        changed.push(path.clone());
                        self.seen.insert(path, meta);
                    }
                }
            }
        }
        // Deleted: known entries of polled folders that are gone (and folders under them).
        let gone: Vec<PathBuf> = self.seen.keys().filter(|p| !current.contains(*p) && p.parent().is_some_and(|d| self.dirs.iter().any(|x| x == d))).cloned().collect();
        for path in gone {
            self.seen.remove(&path);
            self.dirs.retain(|d| !d.starts_with(&path));
            changed.push(path);
        }
        for dir in new_dirs {
            for sub in subfolders(&dir, &NEVER_WATCHED) {
                // Files already inside a new folder are new too.
                for (path, _) in Self::entries(&sub) {
                    if !path.is_dir() {
                        changed.push(path);
                    }
                }
                self.add(sub);
            }
        }
        changed
    }
}

/// Polls in the background until the session's poller is dropped. The pause follows the cost of a
/// scan (20 times it, between 1 and 10 seconds), so a big polled tree doesn't keep a core busy.
fn spawn_poller(poller: Weak<Mutex<Poller>>, emit: impl Fn(Vec<PathBuf>) + Send + 'static) {
    std::thread::spawn(move || {
        let mut pause = Duration::from_secs(1);
        loop {
            std::thread::sleep(pause);
            let Some(poller) = poller.upgrade() else { break };
            let Ok(mut p) = poller.lock() else { break };
            if p.dirs.is_empty() {
                pause = Duration::from_secs(5);
                continue;
            }
            let started = Instant::now();
            let changed = p.scan();
            drop(p);
            pause = (started.elapsed() * 20).clamp(Duration::from_secs(1), Duration::from_secs(10));
            if !changed.is_empty() {
                emit(changed);
            }
        }
    });
}

/// fs.inotify.max_user_watches, read for the message (Linux).
fn inotify_limit() -> Option<u64> {
    std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches").ok()?.trim().parse().ok()
}

#[tauri::command]
pub async fn watch_start(app: AppHandle, state: tauri::State<'_, WatchState>, root: String) -> Result<WatchStatus, String> {
    let shared = state.watcher.clone();
    // Walking a big project and registering watches takes a while: never on the main thread.
    tauri::async_runtime::spawn_blocking(move || start(app, shared, root)).await.map_err(|e| e.to_string())?
}

fn start(app: AppHandle, shared: Watcher, root: String) -> Result<WatchStatus, String> {
    let root_path = PathBuf::from(&root);
    let emit_root = root_path.clone();
    let emit_app = app.clone();
    let emit = move |paths: Vec<PathBuf>| {
        let changes = classify(&emit_root, paths);
        if !changes.is_empty() {
            let _ = emit_app.emit("fs-changed", changes);
        }
    };
    let poller = Arc::new(Mutex::new(Poller::default()));
    spawn_poller(Arc::downgrade(&poller), emit.clone());

    let watched_root = root_path.clone();
    // New folders (Linux, macOS) are added from a helper thread, not the debouncer's callback.
    let (new_dirs, new_dirs_rx) = std::sync::mpsc::channel::<PathBuf>();
    let debouncer = new_debouncer(Duration::from_millis(250), move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
        if cfg!(not(windows)) {
            for c in classify(&watched_root, paths.iter().cloned()).iter().filter(|c| c.kind == "file" && c.exists && c.is_dir) {
                let _ = new_dirs.send(PathBuf::from(&c.path));
            }
        }
        emit(paths);
    });
    let mut status = WatchStatus { watched: 0, polled: 0, limit: inotify_limit(), reason: None };

    let mut debouncer = match debouncer {
        Ok(d) => Some(d),
        Err(e) => {
            // No watcher at all (e.g. fs.inotify.max_user_instances reached): poll everything.
            status.reason = Some(e.to_string());
            None
        }
    };

    if cfg!(windows) {
        // One recursive watch covers the project.
        drop(new_dirs_rx);
        match debouncer.as_mut().map(|d| d.watcher().watch(&root_path, RecursiveMode::Recursive)) {
            Some(Ok(())) => status.watched = 1,
            other => {
                if let Some(Err(e)) = other {
                    status.reason = Some(e.to_string());
                }
                let mut p = poller.lock().map_err(|e| e.to_string())?;
                for dir in folders_to_watch(&root_path) {
                    p.add(dir);
                }
                status.polled = p.dirs.len();
            }
        }
    } else {
        let (watched, failed) = watch_folders(folders_to_watch(&root_path), |dir| match debouncer.as_mut() {
            Some(d) => d.watcher().watch(dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string()),
            None => Err(String::new()),
        });
        status.watched = watched;
        if let Some((reason, dirs)) = failed {
            if !reason.is_empty() {
                status.reason = Some(reason);
            }
            let mut p = poller.lock().map_err(|e| e.to_string())?;
            for dir in dirs {
                p.add(dir);
            }
            status.polled = p.dirs.len();
        }
        let weak = Arc::downgrade(&shared);
        let weak_poller = Arc::downgrade(&poller);
        std::thread::spawn(move || {
            while let Ok(dir) = new_dirs_rx.recv() {
                let Some(shared) = weak.upgrade() else { break };
                let Ok(mut guard) = shared.lock() else { break };
                let Some(session) = guard.as_mut() else { continue };
                let Some(d) = session.debouncer.as_mut() else { continue };
                let (_, failed) = watch_folders(subfolders(&dir, &NEVER_WATCHED), |sub| d.watcher().watch(sub, RecursiveMode::NonRecursive).map_err(|e| e.to_string()));
                if let (Some((_, dirs)), Some(poller)) = (failed, weak_poller.upgrade()) {
                    if let Ok(mut p) = poller.lock() {
                        for dir in dirs {
                            p.add(dir);
                        }
                    }
                }
            }
        });
    }

    // The previous project's watcher (and poller) is dropped here too, off the main thread.
    let old = shared.lock().map_err(|e| e.to_string())?.replace(Session { debouncer, poller });
    drop(old);
    Ok(status)
}

/// Watches folders in order: returns how many are watched, and the folders that could not be
/// (with the first error), which are then polled.
fn watch_folders(folders: Vec<PathBuf>, mut watch: impl FnMut(&Path) -> Result<(), String>) -> (usize, Option<(String, Vec<PathBuf>)>) {
    let mut watched = 0;
    let mut failed: Option<(String, Vec<PathBuf>)> = None;
    for (i, dir) in folders.iter().enumerate() {
        match watch(dir) {
            Ok(()) => watched += 1,
            Err(e) => {
                // The inotify limit: every further watch fails too, so stop trying. notify reports it
                // as ErrorKind::MaxFilesWatch ("OS file watch limit reached."), raw inotify as ENOSPC.
                let limit = e.contains("watch limit reached") || e.contains("os error 28") || e.contains("No space left");
                let entry = failed.get_or_insert_with(|| (e, Vec::new()));
                if limit {
                    entry.1.extend_from_slice(&folders[i..]);
                    break;
                }
                entry.1.push(dir.clone());
            }
        }
    }
    (watched, failed)
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
        // macOS: the temp folder is under /var, a link to /private/var, and events use the real path.
        let root = if cfg!(target_os = "macos") { root.canonicalize().unwrap() } else { root };
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

    /// Polled folders: new, changed and deleted files are found, new folders are polled from then on.
    #[test]
    fn polls_folders_without_a_watch() {
        let root = std::env::temp_dir().join(format!("phpblitz-poll-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/Keep.php"), "<?php").unwrap();
        std::fs::write(root.join("app/Gone.php"), "<?php").unwrap();
        let mut poller = Poller::default();
        poller.add(root.join("app"));
        assert!(poller.scan().is_empty(), "the first scan is the baseline");

        std::fs::write(root.join("app/Keep.php"), "<?php // edited, and longer").unwrap();
        std::fs::remove_file(root.join("app/Gone.php")).unwrap();
        std::fs::write(root.join("app/New.php"), "<?php").unwrap();
        std::fs::create_dir_all(root.join("app/Models")).unwrap();
        std::fs::write(root.join("app/Models/User.php"), "<?php").unwrap();
        let mut changed: Vec<String> = poller.scan().iter().map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/")).collect();
        changed.sort();
        assert_eq!(changed, ["app/Gone.php", "app/Keep.php", "app/Models", "app/Models/User.php", "app/New.php"]);

        // The new folder is polled now: a file added in it is found next time.
        std::fs::write(root.join("app/Models/Post.php"), "<?php").unwrap();
        let next: Vec<PathBuf> = poller.scan();
        assert!(next.iter().any(|p| p.ends_with("Post.php")), "{next:?}");
        assert!(poller.scan().is_empty(), "nothing changed since");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The inotify limit stops watching (the rest is polled); another error skips only that folder.
    #[test]
    fn polls_what_cannot_be_watched() {
        let dirs: Vec<PathBuf> = ["a", "b", "c", "d", "e"].iter().map(PathBuf::from).collect();
        let (watched, failed) = watch_folders(dirs.clone(), |d| if d == Path::new("b") { Err("Permission denied (os error 13)".into()) } else { Ok(()) });
        assert_eq!(watched, 4);
        assert_eq!(failed.unwrap().1, vec![PathBuf::from("b")]);

        let mut tried = 0;
        let (watched, failed) = watch_folders(dirs, |d| {
            tried += 1;
            // What notify's MaxFilesWatch error displays.
            if d >= Path::new("c") { Err(notify_debouncer_mini::notify::Error::new(notify_debouncer_mini::notify::ErrorKind::MaxFilesWatch).add_path(d.to_path_buf()).to_string()) } else { Ok(()) }
        });
        assert_eq!(watched, 2);
        assert_eq!(tried, 3, "stops at the limit");
        let (reason, rest) = failed.unwrap();
        assert!(reason.contains("limit"), "{reason}");
        assert_eq!(rest, ["c", "d", "e"].iter().map(PathBuf::from).collect::<Vec<_>>());
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

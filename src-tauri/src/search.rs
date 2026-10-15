//! Find in Files and Replace in Files.
//!
//! Walks the project in parallel with ripgrep's walker (honours .gitignore, skips
//! hidden files and `vendor`/`node_modules`), matches with the `regex` crate, and
//! reports positions as 1-based lines and UTF-16 columns, the way Monaco counts.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

const MAX_MATCHES: usize = 2000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const PREVIEW_CHARS: usize = 160;
const SKIPPED_DIRS: [&str; 4] = ["vendor", "node_modules", "storage", "target"];

/// Bumped by every search; a running search stops as soon as a newer one starts.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    query: String,
    #[serde(default)]
    regex: bool,
    #[serde(default)]
    match_case: bool,
    #[serde(default)]
    whole_word: bool,
    /// Comma-separated globs, e.g. "*.php, *.blade.php". Empty = all files.
    #[serde(default)]
    file_mask: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    line: u32,
    column: u32,
    end_column: u32,
    /// The line around the match, trimmed; `preview_column` is where the match starts in it.
    preview: String,
    preview_column: u32,
    preview_length: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    path: String,
    matches: Vec<Match>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    files: Vec<FileMatches>,
    total: usize,
    truncated: bool,
    millis: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    text: String,
    count: usize,
}

fn build_regex(options: &SearchOptions) -> Result<Regex, String> {
    if options.query.is_empty() {
        return Err("Empty search".into());
    }
    let pattern = if options.regex { options.query.clone() } else { regex::escape(&options.query) };
    let pattern = if options.whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.match_case)
        .multi_line(true)
        .size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|e| format!("Bad pattern: {e}"))
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// All matches in one file's text, or None when there are none.
fn search_text(path: &str, text: &str, re: &Regex, budget: &AtomicUsize) -> Option<FileMatches> {
    let mut matches = Vec::new();
    let mut line_no = 1u32;
    let mut line_start = 0usize;
    let mut scanned = 0usize;
    for m in re.find_iter(text) {
        if m.start() == m.end() {
            continue; // empty matches (e.g. `^`) are not useful results
        }
        // Advance the line counter up to this match.
        for (i, b) in text[scanned..m.start()].bytes().enumerate() {
            if b == b'\n' {
                line_no += 1;
                line_start = scanned + i + 1;
            }
        }
        scanned = m.start();
        let line_end = text[line_start..].find('\n').map_or(text.len(), |i| line_start + i);
        let line = text[line_start..line_end].trim_end_matches('\r');
        let column = utf16_len(&text[line_start..m.start()]) + 1;
        let match_end = m.end().min(line_start + line.len());
        let end_column = column + utf16_len(&text[m.start()..match_end.max(m.start())]);

        // Preview: the line without its indentation, cut around long matches.
        let indent = line.len() - line.trim_start().len();
        let mut from = line_start + indent;
        if m.start().saturating_sub(from) > PREVIEW_CHARS / 2 {
            from = m.start() - PREVIEW_CHARS / 3;
            while !text.is_char_boundary(from) {
                from -= 1;
            }
        }
        let mut to = line_start + line.len();
        if to - from > PREVIEW_CHARS * 2 {
            to = (from + PREVIEW_CHARS * 2).max(match_end);
            while !text.is_char_boundary(to) {
                to += 1;
            }
        }
        let preview = text[from..to].to_string();
        matches.push(Match {
            line: line_no,
            column,
            end_column,
            preview_column: utf16_len(&text[from..m.start()]),
            preview_length: end_column - column,
            preview,
        });
        if budget.fetch_add(1, Ordering::Relaxed) + 1 >= MAX_MATCHES {
            break;
        }
    }
    (!matches.is_empty()).then(|| FileMatches { path: path.to_string(), matches })
}

pub fn search(root: &Path, options: &SearchOptions, generation: u64) -> Result<SearchResult, String> {
    let started = Instant::now();
    let re = build_regex(options)?;
    let mut walker = WalkBuilder::new(root);
    walker.hidden(true).git_ignore(true).git_global(false).git_exclude(true).require_git(false);
    let masks: Vec<&str> = options.file_mask.split(',').map(str::trim).filter(|m| !m.is_empty()).collect();
    if !masks.is_empty() {
        let mut overrides = OverrideBuilder::new(root);
        for mask in &masks {
            overrides.add(mask).map_err(|e| format!("Bad file mask {mask}: {e}"))?;
        }
        walker.overrides(overrides.build().map_err(|e| e.to_string())?);
    }
    walker.filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIPPED_DIRS.contains(&e.file_name().to_str().unwrap_or(""))));

    let results = Mutex::new(Vec::new());
    let budget = AtomicUsize::new(0);
    let cancelled = AtomicBool::new(false);
    walker.build_parallel().run(|| {
        let (re, results, budget, cancelled) = (&re, &results, &budget, &cancelled);
        Box::new(move |entry| {
            if GENERATION.load(Ordering::Relaxed) != generation {
                cancelled.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            if budget.load(Ordering::Relaxed) >= MAX_MATCHES {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) || entry.metadata().map_or(true, |m| m.len() > MAX_FILE_BYTES) {
                return WalkState::Continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else { return WalkState::Continue };
            if bytes[..bytes.len().min(8000)].contains(&0) {
                return WalkState::Continue; // binary
            }
            let text = String::from_utf8_lossy(&bytes);
            if let Some(found) = search_text(&crate::fs::norm(entry.path()), &text, re, budget) {
                results.lock().unwrap().push(found);
            }
            WalkState::Continue
        })
    });
    if cancelled.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    let mut files = results.into_inner().map_err(|e| e.to_string())?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let total = files.iter().map(|f| f.matches.len()).sum();
    Ok(SearchResult { files, total, truncated: total >= MAX_MATCHES, millis: started.elapsed().as_millis() as u64 })
}

/// Replaces every match; `$1` refers to groups in regex mode, the text is literal otherwise.
pub fn replace_text(text: &str, options: &SearchOptions, replacement: &str) -> Result<ReplaceResult, String> {
    let re = build_regex(options)?;
    let count = re.find_iter(text).filter(|m| m.start() != m.end()).count();
    let text = if options.regex { re.replace_all(text, replacement).into_owned() } else { re.replace_all(text, NoExpand(replacement)).into_owned() };
    Ok(ReplaceResult { text, count })
}

#[tauri::command]
pub async fn search_in_files(root: String, options: SearchOptions) -> Result<SearchResult, String> {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || search(Path::new(&root), &options, generation)).await.map_err(|e| e.to_string())?
}

/// Replace in Files for files that are not open in the editor (open ones use `replace_in_text`).
#[tauri::command]
pub async fn replace_in_files(options: SearchOptions, replacement: String, paths: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut total = 0;
        for path in paths {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
            let result = replace_text(&text, &options, &replacement)?;
            if result.count > 0 {
                std::fs::write(&path, result.text).map_err(|e| format!("{path}: {e}"))?;
                total += result.count;
            }
        }
        Ok(total)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn replace_in_text(options: SearchOptions, replacement: String, text: String) -> Result<ReplaceResult, String> {
    replace_text(&text, &options, &replacement)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(query: &str) -> SearchOptions {
        SearchOptions { query: query.into(), regex: false, match_case: false, whole_word: false, file_mask: String::new() }
    }

    #[test]
    fn finds_positions_in_utf16_columns() {
        let text = "<?php\n$é = 'User';\n    return new User();\r\n";
        let found = search_text("a.php", text, &build_regex(&opts("user")).unwrap(), &AtomicUsize::new(0)).unwrap();
        let at: Vec<_> = found.matches.iter().map(|m| (m.line, m.column, m.end_column, m.preview.as_str(), m.preview_column)).collect();
        assert_eq!(at, vec![(2, 7, 11, "$é = 'User';", 6), (3, 16, 20, "return new User();", 11)]);
    }

    #[test]
    fn options_change_matching() {
        let text = "User users USER";
        let count = |o: SearchOptions| search_text("a", text, &build_regex(&o).unwrap(), &AtomicUsize::new(0)).map_or(0, |f| f.matches.len());
        assert_eq!(count(opts("user")), 3);
        assert_eq!(count(SearchOptions { match_case: true, ..opts("User") }), 1);
        assert_eq!(count(SearchOptions { whole_word: true, ..opts("user") }), 2);
        assert_eq!(count(SearchOptions { regex: true, ..opts(r"us\w+s") }), 1);
        assert!(build_regex(&SearchOptions { regex: true, ..opts("(") }).is_err());
    }

    #[test]
    fn replaces_literally_or_with_groups() {
        let r = replace_text("$a = $b; $a", &opts("$a"), "$x").unwrap();
        assert_eq!((r.text.as_str(), r.count), ("$x = $b; $x", 2));
        let r = replace_text("getName getEmail", &SearchOptions { regex: true, match_case: true, ..opts(r"get(\w+)") }, "fetch$1").unwrap();
        assert_eq!(r.text, "fetchName fetchEmail");
    }

    #[test]
    fn searches_a_project_respecting_gitignore_and_masks() {
        let dir = std::env::temp_dir().join(format!("phpblitz-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (rel, text) in [
            ("app/User.php", "class User {}\n"),
            ("app/view.blade.php", "{{ $user }}\n"),
            ("vendor/x/User.php", "class User {}\n"),
            ("cache/User.php", "class User {}\n"),
            (".gitignore", "cache/\n"),
            ("logo.png", "PNG\0User"),
        ] {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        let files = |o: SearchOptions| -> Vec<String> {
            search(&dir, &o, GENERATION.load(Ordering::SeqCst)).unwrap().files.iter().map(|f| f.path.rsplit_once("phpblitz-search-").unwrap().1.split_once('/').unwrap().1.to_string()).collect()
        };
        assert_eq!(files(opts("user")), vec!["app/User.php", "app/view.blade.php"], "skips vendor, gitignored and binary files");
        assert_eq!(files(SearchOptions { file_mask: "*.blade.php".into(), ..opts("user") }), vec!["app/view.blade.php"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

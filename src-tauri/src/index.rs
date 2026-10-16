//! The project's symbol index, like IntelliJ's stub index: every PHP file of the project and of
//! `vendor` is parsed with Mago (parser, name resolver and scanner), and what it declares is kept:
//! classes, interfaces, traits and enums with their members, functions, and the names each file
//! refers to (for "N usages"). Built in parallel, cached on disk per file (by modification time
//! and size) so reopening a project only re-parses what changed, and updated incrementally.
//!
//! The UI asks questions instead of receiving file contents: search, a class with its members
//! (inherited ones too), usage counts, and which files declare which kind of class (file icons).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Instant, UNIX_EPOCH};

use mago_allocator::LocalArena;
use mago_codex::metadata::CodebaseMetadata;
use mago_codex::metadata::function_like::FunctionLikeKind;
use mago_codex::symbol::SymbolKind;
use mago_codex::ttype::TType;
use mago_codex::visibility::Visibility;
use mago_database::file::{File, FileType};
use mago_names::resolver::NameResolver;
use mago_php_version::PHPVersion;
use mago_syntax::parser::parse_file_borrowed_with_settings;
use mago_syntax::settings::ParserSettings;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Bump when what is stored per file changes: old caches are then ignored.
const CACHE_VERSION: u32 = 1;
/// Never indexed (dependencies of JS tooling, caches, build output).
const SKIPPED_DIRS: [&str; 9] = [".git", ".idea", ".svn", "node_modules", "storage", "var", "dist", "target", ".phpblitz"];
const MAX_FILES: usize = 300_000;
/// Files larger than this are not parsed (generated code, dumps).
const MAX_FILE_BYTES: u64 = 2_500_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// "method", "property" or "const" (constants and enum cases).
    pub kind: String,
    pub name: String,
    /// Return type, property or constant type.
    pub detail: String,
    /// Methods: the parameter list without parentheses.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub params: Option<String>,
    pub line: u32,
    pub visibility: String,
    pub is_static: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClassEntry {
    pub name: String,
    pub fqn: String,
    /// "class", "interface", "trait" or "enum".
    pub kind: String,
    pub line: u32,
    /// Fully qualified, as written in the code (case kept).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub extends: Option<String>,
    #[serde(default)]
    pub implements: Vec<String>,
    #[serde(default)]
    pub traits: Vec<String>,
    pub members: Vec<Member>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FunctionEntry {
    pub name: String,
    pub fqn: String,
    pub line: u32,
    pub params: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct FileSymbols {
    pub classes: Vec<ClassEntry>,
    pub functions: Vec<FunctionEntry>,
    /// Names this file refers to, with counts: members (`->save`, `::create`) and classes.
    pub refs: Vec<(String, u32)>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedFile {
    mtime: u64,
    size: u64,
    symbols: FileSymbols,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    root: String,
    files: HashMap<String, CachedFile>,
}

// ── Scanning one file ─────────────────────────────────────────

/// What one PHP file declares and refers to.
pub fn scan(path: &str, contents: &[u8]) -> FileSymbols {
    let src = contents;
    let file = File::new(Cow::Owned(path.as_bytes().to_vec()), FileType::Host, Some(PathBuf::from(path)), Cow::Owned(contents.to_vec()));
    let arena = LocalArena::new();
    let program = parse_file_borrowed_with_settings(&arena, &file, ParserSettings::default());
    let names = NameResolver::new(&arena).resolve(program);
    let codebase = mago_codex::scanner::scan_program(&arena, &file, program, &names, PHPVersion::PHP84);
    let line = |offset: u32| file.line_number(offset) + 1;
    // Mago keys names in lower case; the resolver kept them as written.
    let mut casing: HashMap<String, String> = HashMap::new();
    for (_, _, name, _) in names.iter() {
        let written = String::from_utf8_lossy(name).trim_start_matches('\\').to_string();
        casing.entry(written.to_lowercase()).or_insert(written);
    }
    let mut out = FileSymbols { classes: classes_of(contents, &codebase, &line, &casing), functions: Vec::new(), refs: references(contents) };

    for ((scope, _), f) in codebase.function_likes.iter() {
        if !scope.is_empty() || !matches!(f.kind, FunctionLikeKind::Function) {
            continue;
        }
        let fqn = f.original_name.to_string();
        out.functions.push(FunctionEntry {
            name: fqn.rsplit('\\').next().unwrap_or(&fqn).to_string(),
            line: line(f.name_span.unwrap_or(f.span).start.offset),
            params: params_of(src, f),
            detail: written(src, &f.return_type_declaration_metadata),
            fqn,
        });
    }
    out.functions.sort_by_key(|f| f.line);
    out
}

/// A declared type as written in the code (`?int`, `array`, `static`), from its span.
fn written(src: &[u8], t: &Option<mago_codex::metadata::ttype::TypeMetadata>) -> String {
    let Some(t) = t else { return String::new() };
    let (a, b) = (t.span.start.offset as usize, t.span.end.offset as usize);
    match src.get(a..b) {
        Some(bytes) if a < b => String::from_utf8_lossy(bytes).trim().to_string(),
        _ => t.type_union.get_id().to_string(),
    }
}

fn params_of(src: &[u8], f: &mago_codex::metadata::function_like::FunctionLikeMetadata) -> String {
    f.parameters
        .iter()
        .map(|p| match &p.type_declaration_metadata {
            Some(_) => format!("{} {}", written(src, &p.type_declaration_metadata), p.name.0),
            None => p.name.0.to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn visibility(v: Visibility) -> &'static str {
    match v {
        Visibility::Public => "public",
        Visibility::Protected => "protected",
        Visibility::Private => "private",
    }
}

fn classes_of(src: &[u8], codebase: &CodebaseMetadata, line: &dyn Fn(u32) -> u32, casing: &HashMap<String, String>) -> Vec<ClassEntry> {
    // Parents are stored by lower-case name: map them back to how they are written.
    let mut out = Vec::new();
    for class in codebase.class_likes.values() {
        let fqn = class.original_name.to_string();
        if fqn.is_empty() || class.name.as_str_lossy().starts_with("class@anonymous") {
            continue;
        }
        let kind = match class.kind {
            SymbolKind::Class => "class",
            SymbolKind::Interface => "interface",
            SymbolKind::Trait => "trait",
            SymbolKind::Enum => "enum",
        };
        let mut members: Vec<Member> = Vec::new();
        for method in class.methods.iter() {
            let Some(f) = codebase.function_likes.get(&(class.name, *method)) else { continue };
            let meta = f.method_metadata.as_ref();
            members.push(Member {
                kind: "method".into(),
                name: f.original_name.to_string(),
                detail: written(src, &f.return_type_declaration_metadata),
                params: Some(params_of(src, f)),
                line: line(f.name_span.unwrap_or(f.span).start.offset),
                visibility: visibility(meta.map(|m| m.visibility).unwrap_or_default()).into(),
                is_static: meta.is_some_and(|m| m.is_static),
            });
        }
        for p in class.properties.values() {
            let Some(span) = p.name_span.or(p.span) else { continue };
            members.push(Member {
                kind: "property".into(),
                name: p.name.0.to_string().trim_start_matches('$').to_string(),
                detail: written(src, &p.type_declaration_metadata),
                params: None,
                line: line(span.start.offset),
                visibility: visibility(p.read_visibility).into(),
                is_static: p.flags.is_static(),
            });
        }
        for c in class.constants.values() {
            members.push(Member {
                kind: "const".into(),
                name: c.name.to_string(),
                detail: written(src, &c.type_declaration),
                params: None,
                line: line(c.span.start.offset),
                visibility: visibility(c.visibility).into(),
                is_static: true,
            });
        }
        for c in class.enum_cases.values() {
            members.push(Member { kind: "const".into(), name: c.name.to_string(), detail: String::new(), params: None, line: line(c.name_span.start.offset), visibility: "public".into(), is_static: true });
        }
        members.sort_by_key(|m| m.line);
        let original = |w: &mago_word::Word| {
            codebase
                .class_likes
                .get(w)
                .map(|c| c.original_name.to_string())
                .or_else(|| casing.get(&w.to_string().to_lowercase()).cloned())
                .unwrap_or_else(|| w.to_string())
        };
        let mut implements: Vec<String> = class.direct_parent_interfaces.iter().map(original).collect();
        implements.sort();
        let mut traits: Vec<String> = class.used_traits.iter().map(original).collect();
        traits.sort();
        let offset = class.name_span.unwrap_or(class.span).start.offset;
        out.push((offset, ClassEntry {
            name: fqn.rsplit('\\').next().unwrap_or(&fqn).to_string(),
            kind: kind.into(),
            line: line(class.name_span.unwrap_or(class.span).start.offset),
            extends: class.direct_parent_class.as_ref().map(original),
            implements,
            traits,
            members,
            fqn,
        }));
    }
    // In source order (several classes can share a line).
    out.sort_by_key(|(offset, _)| *offset);
    out.into_iter().map(|(_, c)| c).collect()
}

/// Names a file refers to, counted by name only (like the "N usages" estimate PhpStorm shows
/// without a language server): members after `->`, `?->` and `::`, Laravel route actions
/// `[Controller::class, 'method']`, and class names in `new`, `::`, `instanceof`, `extends`,
/// `implements`, type declarations and `use` imports.
fn references(src: &[u8]) -> Vec<(String, u32)> {
    static RE: OnceLock<[Regex; 4]> = OnceLock::new();
    let [member, action, class_ref, hint] = RE.get_or_init(|| {
        [
            Regex::new(r"(?:->|::)\$?([A-Za-z_]\w*)").unwrap(),
            Regex::new(r#"::class\s*,\s*['"](\w+)['"]"#).unwrap(),
            Regex::new(r"(?:\bnew\s+|\binstanceof\s+|\bextends\s+|\bimplements\s+|\buse\s+|,\s*)\\?((?:\w+\\)*[A-Z]\w*)|\b((?:\w+\\)*[A-Z]\w*)::").unwrap(),
            Regex::new(r"(?:[(,|]\s*\??|\)\s*:\s*\??)\\?((?:\w+\\)*[A-Z]\w*)\s*(?:\$|&|\.\.\.|\{|;|\||=>)").unwrap(),
        ]
    });
    let text = String::from_utf8_lossy(src);
    let mut counts: HashMap<String, u32> = HashMap::new();
    let mut add = |name: &str| *counts.entry(name.to_string()).or_default() += 1;
    for c in member.captures_iter(&text) {
        if &c[1] != "class" {
            add(&c[1]);
        }
    }
    for c in action.captures_iter(&text) {
        add(&c[1]);
    }
    for c in class_ref.captures_iter(&text) {
        if let Some(m) = c.get(1).or(c.get(2)) {
            let short = m.as_str().rsplit('\\').next().unwrap_or(m.as_str());
            if !matches!(short, "self" | "static" | "parent") {
                add(short);
            }
        }
    }
    for c in hint.captures_iter(&text) {
        add(c[1].rsplit('\\').next().unwrap_or(&c[1]));
    }
    let mut out: Vec<(String, u32)> = counts.into_iter().collect();
    out.sort();
    out
}

// ── The project index ─────────────────────────────────────────

#[derive(Default)]
struct ProjectIndex {
    root: String,
    files: HashMap<String, CachedFile>,
    /// Lower-case FQN → (file, class index).
    by_fqn: HashMap<String, (String, usize)>,
    /// Lower-case short name → classes.
    by_short: HashMap<String, Vec<(String, usize)>>,
    /// Name → references across the project.
    refs: HashMap<String, u32>,
}

impl ProjectIndex {
    fn add_aggregates(&mut self, path: &str) {
        let Some(f) = self.files.get(path) else { return };
        for (i, c) in f.symbols.classes.iter().enumerate() {
            self.by_fqn.insert(c.fqn.to_lowercase(), (path.to_string(), i));
            self.by_short.entry(c.name.to_lowercase()).or_default().push((path.to_string(), i));
        }
        for (name, n) in &f.symbols.refs {
            *self.refs.entry(name.clone()).or_default() += n;
        }
    }

    fn remove_aggregates(&mut self, path: &str) {
        let Some(f) = self.files.get(path) else { return };
        for c in &f.symbols.classes {
            if self.by_fqn.get(&c.fqn.to_lowercase()).is_some_and(|(p, _)| p == path) {
                self.by_fqn.remove(&c.fqn.to_lowercase());
            }
            if let Some(list) = self.by_short.get_mut(&c.name.to_lowercase()) {
                list.retain(|(p, _)| p != path);
            }
        }
        for (name, n) in &f.symbols.refs {
            if let Some(total) = self.refs.get_mut(name) {
                *total = total.saturating_sub(*n);
            }
        }
    }

    fn rebuild(&mut self) {
        self.by_fqn.clear();
        self.by_short.clear();
        self.refs.clear();
        let paths: Vec<String> = self.files.keys().cloned().collect();
        for p in paths {
            self.add_aggregates(&p);
        }
    }

    fn set(&mut self, path: String, file: CachedFile) {
        self.remove_aggregates(&path);
        self.files.insert(path.clone(), file);
        self.add_aggregates(&path);
    }

    fn remove(&mut self, path: &str) {
        self.remove_aggregates(path);
        self.files.remove(path);
    }

    fn class(&self, at: &(String, usize)) -> Option<&ClassEntry> {
        self.files.get(&at.0)?.symbols.classes.get(at.1)
    }

    /// A class by FQN (leading `\` optional), else by short name (first match, project files first).
    fn find(&self, name: &str) -> Option<(&String, &ClassEntry)> {
        let key = name.trim_start_matches('\\').to_lowercase();
        if let Some(at) = self.by_fqn.get(&key) {
            return self.class(at).map(|c| (&at.0, c));
        }
        let short = key.rsplit('\\').next().unwrap_or(&key);
        let list = self.by_short.get(short)?;
        let vendor = format!("{}/vendor/", self.root);
        let at = list.iter().find(|(p, _)| !p.starts_with(&vendor)).or(list.first())?;
        self.class(at).map(|c| (&at.0, c))
    }
}

#[derive(Default)]
pub struct IndexState {
    index: Arc<RwLock<ProjectIndex>>,
    /// Bumped by each open: an older open still running stops.
    generation: Arc<std::sync::atomic::AtomicU64>,
}

fn cache_path(app: &AppHandle, root: &str) -> Option<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.to_lowercase().hash(&mut h);
    let dir = app.path().app_cache_dir().ok()?.join("index");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{:016x}.json", h.finish())))
}

fn load_cache(path: &Path, root: &str) -> HashMap<String, CachedFile> {
    let Ok(text) = std::fs::read(path) else { return HashMap::new() };
    match serde_json::from_slice::<CacheFile>(&text) {
        Ok(c) if c.version == CACHE_VERSION && c.root == root => c.files,
        _ => HashMap::new(),
    }
}

fn save_cache(path: &Path, index: &ProjectIndex) {
    let cache = CacheFile { version: CACHE_VERSION, root: index.root.clone(), files: index.files.clone() };
    if let Ok(bytes) = serde_json::to_vec(&cache) {
        // Write then rename, so a crash never leaves a half-written cache.
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// PHP files of the project, vendor included (even when .gitignore'd), skipping tool folders and
/// the folders marked Excluded.
fn php_files(root: &str, excludes: &[String]) -> Vec<(String, u64, u64)> {
    let excluded: HashSet<String> = excludes.iter().map(|e| format!("{}/{}", root, e.trim_matches('/'))).collect();
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(t) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = crate::fs::norm(&entry.path());
            if t.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) && !excluded.contains(&path) {
                    stack.push(entry.path());
                }
            } else if t.is_file() && name.ends_with(".php") && !name.ends_with(".blade.php") {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() > MAX_FILE_BYTES {
                    continue;
                }
                let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
                out.push((path, mtime, meta.len()));
                if out.len() >= MAX_FILES {
                    return out;
                }
            }
        }
    }
    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    files: usize,
    classes: usize,
    functions: usize,
    /// Files parsed this time (the others came from the cache).
    parsed: usize,
    ms: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: usize,
    total: usize,
}

/// Builds (or loads and refreshes) the index of a project.
#[tauri::command]
pub async fn index_open(app: AppHandle, state: tauri::State<'_, IndexState>, root: String, excludes: Option<Vec<String>>) -> Result<IndexStats, String> {
    let index = state.index.clone();
    let generation = state.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let current = state.generation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let root = root.trim_end_matches('/').to_string();
        let cache = cache_path(&app, &root);
        let mut cached = cache.as_deref().map(|p| load_cache(p, &root)).unwrap_or_default();
        let files = php_files(&root, &excludes.unwrap_or_default());
        let total = files.len();
        let (fresh, stale): (Vec<_>, Vec<_>) = files.into_iter().partition(|(p, mtime, size)| cached.get(p).is_some_and(|c| c.mtime == *mtime && c.size == *size));

        let done = std::sync::atomic::AtomicUsize::new(fresh.len());
        let _ = app.emit("index-progress", Progress { done: fresh.len(), total });
        let parsed: Vec<(String, CachedFile)> = crate::mago::analysis_pool().install(|| {
            stale
                .par_iter()
                .filter_map(|(path, mtime, size)| {
                    if current.load(std::sync::atomic::Ordering::SeqCst) != generation {
                        return None;
                    }
                    let bytes = std::fs::read(path).ok()?;
                    let symbols = scan(path, &bytes);
                    let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    if n % 500 == 0 {
                        let _ = app.emit("index-progress", Progress { done: n, total });
                    }
                    Some((path.clone(), CachedFile { mtime: *mtime, size: *size, symbols }))
                })
                .collect()
        });
        if current.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return Err("cancelled: another project was opened".to_string());
        }

        let mut next = ProjectIndex { root: root.clone(), ..Default::default() };
        for (path, ..) in &fresh {
            if let Some(c) = cached.remove(path) {
                next.files.insert(path.clone(), c);
            }
        }
        let parsed_count = parsed.len();
        next.files.extend(parsed);
        next.rebuild();
        if let Some(p) = &cache {
            save_cache(p, &next);
        }
        let stats = IndexStats {
            files: next.files.len(),
            classes: next.files.values().map(|f| f.symbols.classes.len()).sum(),
            functions: next.files.values().map(|f| f.symbols.functions.len()).sum(),
            parsed: parsed_count,
            ms: started.elapsed().as_millis() as u64,
        };
        *index.write().map_err(|e| e.to_string())? = next;
        let _ = app.emit("index-progress", Progress { done: total, total });
        Ok(stats)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Files changed or deleted on disk. Returns the kinds of the changed files (for their icons).
#[tauri::command]
pub async fn index_update(state: tauri::State<'_, IndexState>, changed: Vec<String>, removed: Vec<String>) -> Result<Vec<(String, Option<String>)>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scanned: Vec<(String, Option<CachedFile>)> = crate::mago::analysis_pool().install(|| {
            changed
                .par_iter()
                .map(|path| {
                    let file = std::fs::metadata(path).ok().filter(|m| m.len() <= MAX_FILE_BYTES).and_then(|meta| {
                        let bytes = std::fs::read(path).ok()?;
                        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
                        Some(CachedFile { mtime, size: meta.len(), symbols: scan(path, &bytes) })
                    });
                    (path.clone(), file)
                })
                .collect()
        });
        let mut idx = index.write().map_err(|e| e.to_string())?;
        for path in &removed {
            idx.remove(path);
        }
        let mut kinds = Vec::new();
        for (path, file) in scanned {
            match file {
                Some(f) => {
                    kinds.push((path.clone(), f.symbols.classes.first().map(|c| c.kind.clone())));
                    idx.set(path, f);
                }
                None => idx.remove(&path),
            }
        }
        Ok(kinds)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An open file's current text (not saved yet). Returns its kind.
#[tauri::command]
pub async fn index_update_text(state: tauri::State<'_, IndexState>, path: String, text: String) -> Result<Option<String>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let symbols = crate::mago::analysis_pool().install(|| scan(&path, text.as_bytes()));
        let kind = symbols.classes.first().map(|c| c.kind.clone());
        let mut idx = index.write().map_err(|e| e.to_string())?;
        // Keep the disk stamp: a later index_open re-reads the file only if the disk changed.
        let (mtime, size) = idx.files.get(&path).map_or((0, 0), |f| (f.mtime, f.size));
        idx.set(path, CachedFile { mtime, size, symbols });
        Ok(kind)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the index cache now (the UI calls it when a project closes).
#[tauri::command]
pub async fn index_save(app: AppHandle, state: tauri::State<'_, IndexState>) -> Result<(), String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        if idx.root.is_empty() {
            return Ok(());
        }
        if let Some(p) = cache_path(&app, &idx.root) {
            save_cache(&p, &idx);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which kind of class each file declares (class, interface, trait, enum), for file icons.
#[tauri::command]
pub async fn index_kinds(state: tauri::State<'_, IndexState>) -> Result<Vec<(String, String)>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        Ok(idx.files.iter().filter_map(|(p, f)| f.symbols.classes.first().map(|c| (p.clone(), c.kind.clone()))).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassInfo {
    #[serde(flatten)]
    class: ClassEntry,
    path: String,
    /// Members of the class and of its parents, traits and interfaces (own first, no duplicates).
    all_members: Vec<Member>,
}

/// A class with its members, inherited ones included. `name`: FQN, or a short name.
#[tauri::command]
pub async fn index_class(state: tauri::State<'_, IndexState>, name: String) -> Result<Option<ClassInfo>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        let Some((path, class)) = idx.find(&name) else { return Ok(None) };
        let mut all = Vec::new();
        let mut seen: HashSet<(String, String)> = HashSet::new();
        let mut queue = vec![class.clone()];
        let mut visited: HashSet<String> = HashSet::new();
        while let Some(c) = queue.pop() {
            if !visited.insert(c.fqn.to_lowercase()) || visited.len() > 32 {
                continue;
            }
            for m in &c.members {
                if seen.insert((m.kind.clone(), m.name.to_lowercase())) {
                    all.push(m.clone());
                }
            }
            // Parents after the class itself: interfaces first so the class's parent wins over them.
            for p in c.implements.iter().chain(c.traits.iter()).chain(c.extends.iter()) {
                if let Some((_, parent)) = idx.find(p) {
                    queue.push(parent.clone());
                }
            }
        }
        Ok(Some(ClassInfo { class: class.clone(), path: path.clone(), all_members: all }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// "class", "interface", "trait", "enum", "method", "function".
    kind: String,
    /// "User" or "User::save()".
    name: String,
    /// FQN for classes, return type for methods.
    detail: String,
    path: String,
    line: u32,
    vendor: bool,
}

/// How well `query` matches `name`, IntelliJ-style: prefix, camel humps, then substring. None: no match.
fn score(name: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let n = name.to_lowercase();
    let q = query.to_lowercase();
    if n == q {
        return Some(1000);
    }
    if n.starts_with(&q) {
        return Some(800 - name.len() as i32);
    }
    // Camel humps: "UC" or "UsCon" matches "UserController".
    let humps: Vec<(usize, char)> = name.char_indices().filter(|(i, c)| *i == 0 || c.is_uppercase() || c.is_ascii_digit()).collect();
    let mut qi = query.chars().peekable();
    let mut hi = 0;
    let chars: Vec<char> = name.chars().collect();
    let mut pos = 0usize;
    let mut ok = true;
    while let Some(qc) = qi.next() {
        // Next hump starting with qc, then extend within the hump.
        while hi < humps.len() && !humps[hi].1.eq_ignore_ascii_case(&qc) {
            hi += 1;
        }
        if hi >= humps.len() {
            ok = false;
            break;
        }
        pos = name[..humps[hi].0].chars().count() + 1;
        hi += 1;
        while let Some(&nc) = qi.peek() {
            if pos < chars.len() && chars[pos].eq_ignore_ascii_case(&nc) && !(chars[pos].is_uppercase() && pos > 0) {
                pos += 1;
                qi.next();
            } else {
                break;
            }
        }
    }
    let _ = pos;
    if ok {
        return Some(600 - name.len() as i32);
    }
    n.find(&q).map(|i| 400 - i as i32 - name.len() as i32)
}

/// Search Everywhere / Go to Class: classes, then public methods and functions, best first.
#[tauri::command]
pub async fn index_search(state: tauri::State<'_, IndexState>, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        let limit = limit.unwrap_or(100);
        let query = query.trim();
        // "User::save" searches members of matching classes.
        let (class_q, member_q) = match query.split_once("::") {
            Some((c, m)) => (c, Some(m)),
            None => (query, None),
        };
        let vendor_prefix = format!("{}/vendor/", idx.root);
        let mut hits: Vec<(i32, SearchHit)> = Vec::new();
        for (path, f) in &idx.files {
            let vendor = path.starts_with(&vendor_prefix);
            // Project symbols rank above vendor ones.
            let bonus = if vendor { -150 } else { 0 };
            for c in &f.symbols.classes {
                let class_score = score(&c.name, class_q);
                if member_q.is_none() {
                    if let Some(s) = class_score {
                        hits.push((s + bonus + 50, SearchHit { kind: c.kind.clone(), name: c.name.clone(), detail: c.fqn.clone(), path: path.clone(), line: c.line, vendor }));
                    }
                }
                if query.is_empty() {
                    continue;
                }
                for m in c.members.iter().filter(|m| m.kind == "method" && m.visibility == "public") {
                    let s = match member_q {
                        Some(mq) => class_score.and_then(|cs| score(&m.name, mq).map(|ms| cs / 4 + ms)),
                        None => score(&m.name, query),
                    };
                    if let Some(s) = s {
                        hits.push((s + bonus - 100, SearchHit { kind: "method".into(), name: format!("{}::{}()", c.name, m.name), detail: m.detail.clone(), path: path.clone(), line: m.line, vendor }));
                    }
                }
            }
            if member_q.is_none() && !query.is_empty() {
                for fun in &f.symbols.functions {
                    if let Some(s) = score(&fun.name, query) {
                        hits.push((s + bonus - 80, SearchHit { kind: "function".into(), name: format!("{}()", fun.name), detail: fun.fqn.clone(), path: path.clone(), line: fun.line, vendor }));
                    }
                }
            }
        }
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
        hits.truncate(limit);
        Ok(hits.into_iter().map(|(_, h)| h).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// References to each name across the project (name-based estimate).
#[tauri::command]
pub fn index_usages(state: tauri::State<'_, IndexState>, names: Vec<String>) -> Result<Vec<u32>, String> {
    // A few hash lookups: cheap enough to answer right away.
    let idx = state.index.read().map_err(|e| e.to_string())?;
    Ok(names.iter().map(|n| idx.refs.get(n).copied().unwrap_or(0)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = r#"<?php
namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Contracts\HasName;

/** A customer. */
final class User extends Model implements HasName
{
    use Notifiable;

    public const ROLE = 'user';
    protected static int $count = 0;

    public function __construct(private readonly string $name, public ?int $age = null) {}

    public function name(): string
    {
        return $this->name;
    }

    public static function create(array $attributes): static
    {
        return new static($attributes['name']);
    }

    private function secret() {}
}

function helper(int $a, $b = 1): ?string { return null; }
"#;

    #[test]
    fn scans_classes_members_and_functions() {
        let s = scan("/p/app/Models/User.php", USER.as_bytes());
        assert_eq!(s.classes.len(), 1);
        let c = &s.classes[0];
        assert_eq!((c.name.as_str(), c.fqn.as_str(), c.kind.as_str(), c.line), ("User", "App\\Models\\User", "class", 8));
        assert_eq!(c.extends.as_deref(), Some("Illuminate\\Database\\Eloquent\\Model"));
        assert_eq!(c.implements, vec!["App\\Contracts\\HasName".to_string()]);
        let m = |name: &str| c.members.iter().find(|m| m.name == name).unwrap_or_else(|| panic!("{name} in {:?}", c.members));
        assert_eq!((m("ROLE").kind.as_str(), m("ROLE").line), ("const", 12));
        assert!(m("count").is_static && m("count").visibility == "protected" && m("count").detail == "int");
        // Promoted constructor properties are properties.
        assert!(c.members.iter().any(|x| x.kind == "method" && x.name == "name" && x.visibility == "public" && x.detail == "string"));
        assert!(c.members.iter().any(|x| x.kind == "property" && x.name == "name" && x.visibility == "private"));
        assert!(c.members.iter().any(|x| x.kind == "property" && x.name == "age" && x.detail == "?int"), "{:?}", c.members);
        assert_eq!(m("create").params.as_deref(), Some("array $attributes"));
        assert!(m("create").is_static);
        assert_eq!(m("create").detail, "static");
        assert_eq!(m("secret").visibility, "private");
        assert_eq!(s.functions.len(), 1);
        assert_eq!((s.functions[0].fqn.as_str(), s.functions[0].params.as_str(), s.functions[0].line), ("App\\Models\\helper", "int $a, $b", 30));
        // References: members and classes by name.
        let refs: HashMap<_, _> = s.refs.iter().cloned().collect();
        assert_eq!(refs.get("name"), Some(&1));
        assert!(refs.get("Model").is_some() && refs.get("HasName").is_some());
    }

    #[test]
    fn survives_broken_and_odd_files() {
        assert!(scan("/p/a.php", b"<?php class {").classes.is_empty());
        assert!(scan("/p/b.php", b"").classes.is_empty());
        let s = scan("/p/c.php", b"<?php interface I { public function f(): void; } enum E: string { case A = 'a'; } trait T {}");
        let kinds: Vec<_> = s.classes.iter().map(|c| (c.name.as_str(), c.kind.as_str())).collect();
        assert_eq!(kinds, vec![("I", "interface"), ("E", "enum"), ("T", "trait")]);
        assert!(s.classes[1].members.iter().any(|m| m.name == "A" && m.kind == "const"));
    }

    #[test]
    fn index_finds_and_inherits() {
        let mut idx = ProjectIndex { root: "/p".into(), ..Default::default() };
        let parent = scan("/p/vendor/x/Model.php", b"<?php namespace Illuminate\\Database\\Eloquent; abstract class Model { public function save(): bool { return true; } public function name() {} }");
        let user = scan("/p/app/Models/User.php", USER.as_bytes());
        idx.set("/p/vendor/x/Model.php".into(), CachedFile { mtime: 1, size: 1, symbols: parent });
        idx.set("/p/app/Models/User.php".into(), CachedFile { mtime: 1, size: 1, symbols: user.clone() });
        assert_eq!(idx.find("\\App\\Models\\User").map(|(_, c)| c.name.as_str()), Some("User"));
        assert_eq!(idx.find("user").map(|(_, c)| c.fqn.as_str()), Some("App\\Models\\User"));
        assert_eq!(idx.find("Model").map(|(p, _)| p.as_str()), Some("/p/vendor/x/Model.php"));
        assert!(idx.refs.get("name").copied().unwrap_or(0) >= 1);
        // Replacing a file updates the aggregates instead of adding to them.
        let before = idx.refs.get("name").copied();
        idx.set("/p/app/Models/User.php".into(), CachedFile { mtime: 2, size: 1, symbols: user });
        assert_eq!(idx.refs.get("name").copied(), before);
        idx.remove("/p/app/Models/User.php");
        assert!(idx.find("User").is_none());
    }

    /// Benchmark on a real project: PHPBLITZ_INDEX_BENCH=/path/to/project cargo test --lib index_bench -- --nocapture
    #[test]
    fn index_bench() {
        let Ok(root) = std::env::var("PHPBLITZ_INDEX_BENCH") else { return };
        let t = Instant::now();
        let files = php_files(&root, &[]);
        let listed = t.elapsed();
        let t2 = Instant::now();
        let parsed: Vec<(String, CachedFile)> = crate::mago::analysis_pool().install(|| {
            files.par_iter().filter_map(|(p, m, s)| Some((p.clone(), CachedFile { mtime: *m, size: *s, symbols: scan(p, &std::fs::read(p).ok()?) }))).collect()
        });
        let scanned = t2.elapsed();
        let mut idx = ProjectIndex { root: root.clone(), ..Default::default() };
        idx.files.extend(parsed);
        let t3 = Instant::now();
        idx.rebuild();
        let classes: usize = idx.files.values().map(|f| f.symbols.classes.len()).sum();
        let json = serde_json::to_vec(&CacheFile { version: CACHE_VERSION, root: root.clone(), files: idx.files.clone() }).unwrap();
        let t4 = Instant::now();
        let back: CacheFile = serde_json::from_slice(&json).unwrap();
        eprintln!(
            "BENCH {} files, {} classes | list {:?} | parse+scan {:?} | aggregate {:?} | cache {} KB, load {:?} ({} files)",
            idx.files.len(), classes, listed, scanned, t3.elapsed(), json.len() / 1024, t4.elapsed(), back.files.len()
        );
        let q = Instant::now();
        let hits = idx.files.values().flat_map(|f| f.symbols.classes.iter()).filter(|c| score(&c.name, "UpHa").is_some()).count();
        eprintln!("BENCH search 'UpHa': {hits} matches in {:?}", q.elapsed());
    }

    #[test]
    fn finds_files_and_caches_them() {
        let root = std::env::temp_dir().join(format!("phpblitz-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (rel, text) in [
            ("app/A.php", "<?php namespace App; class A {}"),
            ("vendor/acme/lib/B.php", "<?php namespace Acme; interface B {}"),
            ("node_modules/x/C.php", "<?php class C {}"),
            ("plugins/old/D.php", "<?php class D {}"),
            ("resources/views/v.blade.php", "<div></div>"),
            (".gitignore", "vendor/"),
        ] {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        let r = crate::fs::norm(&root);
        let mut found: Vec<String> = php_files(&r, &["plugins".to_string()]).into_iter().map(|(p, ..)| p.strip_prefix(&r).unwrap().to_string()).collect();
        found.sort();
        assert_eq!(found, vec!["/app/A.php".to_string(), "/vendor/acme/lib/B.php".to_string()], "vendor in, node_modules / excluded / blade out");

        // Cache: saved, loaded for the same root and version, ignored otherwise.
        let mut idx = ProjectIndex { root: r.clone(), ..Default::default() };
        for (p, mtime, size) in php_files(&r, &[]) {
            let symbols = scan(&p, &std::fs::read(&p).unwrap());
            idx.set(p, CachedFile { mtime, size, symbols });
        }
        let cache = root.join("cache.json");
        save_cache(&cache, &idx);
        let loaded = load_cache(&cache, &r);
        assert_eq!(loaded.len(), idx.files.len());
        let a = format!("{r}/app/A.php");
        assert_eq!(loaded[&a].symbols, idx.files[&a].symbols);
        assert!(load_cache(&cache, "/other/project").is_empty());
        std::fs::write(&cache, br#"{"version":0,"root":"x","files":{}}"#).unwrap();
        assert!(load_cache(&cache, &r).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn serializes_for_the_ui() {
        let s = scan("/p/U.php", USER.as_bytes());
        let info = ClassInfo { class: s.classes[0].clone(), path: "/p/U.php".into(), all_members: s.classes[0].members.clone() };
        let v = serde_json::to_value(&info).unwrap();
        for key in ["name", "fqn", "kind", "line", "extends", "members", "path", "allMembers"] {
            assert!(v.get(key).is_some(), "{key} in {v}");
        }
        let m = &v["allMembers"][0];
        for key in ["kind", "name", "detail", "line", "visibility", "isStatic"] {
            assert!(m.get(key).is_some(), "{key} in {m}");
        }
        let hit = serde_json::to_value(SearchHit { kind: "class".into(), name: "U".into(), detail: "".into(), path: "/p".into(), line: 1, vendor: false }).unwrap();
        let mut keys: Vec<String> = hit.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["detail", "kind", "line", "name", "path", "vendor"]);
        let stats = serde_json::to_value(IndexStats { files: 1, classes: 1, functions: 0, parsed: 1, ms: 2 }).unwrap();
        assert!(stats.get("parsed").is_some() && stats.get("functions").is_some());
    }

    #[test]
    fn scores_like_go_to_class() {
        assert!(score("UserController", "UserController") > score("UserController", "User"));
        assert!(score("UserController", "User").is_some());
        assert!(score("UserController", "UC").is_some());
        assert!(score("UserController", "UsCon").is_some());
        assert!(score("UserController", "troll").is_some()); // substring
        assert!(score("UserController", "xyz").is_none());
        assert!(score("UserController", "User") > score("UserController", "UC"));
    }
}

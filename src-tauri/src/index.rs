//! The project's symbol index: every PHP file of the project and of
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
use mago_codex::ttype::atomic::TAtomic;
use mago_codex::ttype::atomic::array::TArray;
use mago_codex::ttype::atomic::object::TObject;
use mago_codex::ttype::atomic::reference::TReference;
use mago_codex::ttype::union::TUnion;
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
/// The cache's format: bump when FileSymbols or the encoding changes (an old cache is then rebuilt).
const CACHE_VERSION: u32 = 4;
const CACHE_MAGIC: &[u8; 8] = b"BLITZIDX";
/// Never indexed (dependencies of JS tooling, caches, build output).
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
    #[serde(default)]
    pub params: Option<String>,
    pub line: u32,
    pub visibility: String,
    pub is_static: bool,
    /// The class a method returns or a property holds, fully qualified (docblocks included), or
    /// "static" for `static` / `$this`. For completion after `->`.
    #[serde(default)]
    pub ty: Option<String>,
    /// For collections (`User[]`, `list<User>`, `Collection<int, User>`): the element class.
    #[serde(default)]
    pub elem: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClassEntry {
    pub name: String,
    pub fqn: String,
    /// "class", "interface", "trait" or "enum".
    pub kind: String,
    pub line: u32,
    /// Last line of the declaration (to find the class around a line).
    #[serde(default)]
    pub end_line: u32,
    /// Fully qualified, as written in the code (case kept).
    #[serde(default)]
    pub extends: Option<String>,
    #[serde(default)]
    pub implements: Vec<String>,
    #[serde(default)]
    pub traits: Vec<String>,
    /// `@mixin` classes: their members are reachable too (Laravel models and their query builder).
    #[serde(default)]
    pub mixins: Vec<String>,
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
    /// The class the function returns and, for collections, their element class (see Member).
    #[serde(default)]
    pub ty: Option<String>,
    #[serde(default)]
    pub elem: Option<String>,
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

/// `.blitz/cache/index.bin`: CACHE_MAGIC, CACHE_VERSION (u32 LE), then this in bincode. Paths are
/// relative to the project, so the cache still works after the folder is moved or renamed.
#[derive(Deserialize)]
struct CacheFile {
    files: Vec<(String, CachedFile)>,
}

/// What CacheFile reads back, written from references (no copy of the whole index).
#[derive(Serialize)]
struct CacheRef<'a> {
    files: Vec<(&'a str, &'a CachedFile)>,
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
        let (ty, elem) = class_types(&f.return_type_metadata, &|w| original_name(&codebase, &casing, w));
        out.functions.push(FunctionEntry {
            name: fqn.rsplit('\\').next().unwrap_or(&fqn).to_string(),
            line: line(f.name_span.unwrap_or(f.span).start.offset),
            params: params_of(src, f),
            detail: written(src, &f.return_type_declaration_metadata),
            ty,
            elem,
            fqn,
        });
    }
    out.functions.sort_by_key(|f| f.line);
    out
}

/// A class name with the casing it was written with (Mago keys names in lower case).
fn original_name(codebase: &CodebaseMetadata, casing: &HashMap<String, String>, w: &mago_word::Word) -> String {
    codebase
        .class_likes
        .get(w)
        .map(|c| c.original_name.to_string())
        .or_else(|| casing.get(&w.to_string().to_lowercase()).cloned())
        .unwrap_or_else(|| w.to_string())
}

/// The first class in a type: "static" for `static` / `$this`, else its fully qualified name.
fn first_class(t: &TUnion, original: &dyn Fn(&mago_word::Word) -> String) -> Option<String> {
    t.types.iter().find_map(|a| match a {
        TAtomic::Object(TObject::Named(n)) => Some(if n.is_static || n.is_this { "static".to_string() } else { original(&n.name) }),
        TAtomic::Object(TObject::Enum(e)) => Some(original(&e.name)),
        // Before the codebase is populated (this scan), class types are references by name.
        TAtomic::Reference(TReference::Symbol { name, .. }) => Some(original(name)),
        _ => None,
    })
}

/// What completion needs from a type: the class it is (`ty`) and, for collections, the class of
/// its elements (`elem`): `User[]`, `list<User>`, `iterable<User>`, `Collection<int, User>`.
fn class_types(t: &Option<mago_codex::metadata::ttype::TypeMetadata>, original: &dyn Fn(&mago_word::Word) -> String) -> (Option<String>, Option<String>) {
    let Some(t) = t else { return (None, None) };
    let ty = first_class(&t.type_union, original);
    let elem = t.type_union.types.iter().find_map(|a| match a {
        TAtomic::Object(TObject::Named(n)) => n.type_parameters.as_ref().and_then(|ps| ps.last()).and_then(|v| first_class(v, original)),
        TAtomic::Reference(TReference::Symbol { parameters, .. }) => parameters.as_ref().and_then(|ps| ps.last()).and_then(|v| first_class(v, original)),
        TAtomic::Array(TArray::List(l)) => first_class(&l.element_type, original),
        TAtomic::Array(TArray::Keyed(k)) => k.parameters.as_ref().and_then(|(_, v)| first_class(v, original)),
        TAtomic::Iterable(i) => first_class(&i.value_type, original),
        _ => None,
    });
    (ty, elem.filter(|e| e != "static"))
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
        let original = |w: &mago_word::Word| original_name(codebase, casing, w);
        // Declared methods, then `@method` ones from the docblock (static or not).
        let pseudo = class.pseudo_methods.iter().map(|m| (m, false)).chain(class.static_pseudo_methods.iter().map(|m| (m, true)));
        for (method, docblock_static) in class.methods.iter().map(|m| (m, None)).chain(pseudo.map(|(m, st)| (m, Some(st)))) {
            let Some(f) = codebase.function_likes.get(&(class.name, *method)) else { continue };
            if docblock_static.is_some() && members.iter().any(|m| m.kind == "method" && m.name.eq_ignore_ascii_case(&f.original_name.to_string())) {
                continue;
            }
            let meta = f.method_metadata.as_ref();
            let (ty, elem) = class_types(&f.return_type_metadata, &original);
            members.push(Member {
                kind: "method".into(),
                name: f.original_name.to_string(),
                detail: written(src, &f.return_type_declaration_metadata),
                params: Some(params_of(src, f)),
                line: line(f.name_span.unwrap_or(f.span).start.offset),
                visibility: visibility(meta.map(|m| m.visibility).unwrap_or_default()).into(),
                is_static: docblock_static.unwrap_or_else(|| meta.is_some_and(|m| m.is_static)),
                ty,
                elem,
            });
        }
        // Declared properties, then `@property` ones from the docblock (Eloquent model columns).
        let class_span = class.name_span.unwrap_or(class.span);
        for p in class.properties.values().chain(class.magic_properties.values()) {
            let span = p.name_span.or(p.span).unwrap_or(class_span);
            let name = p.name.0.to_string().trim_start_matches('$').to_string();
            if members.iter().any(|m| m.kind == "property" && m.name == name) {
                continue;
            }
            let (ty, elem) = class_types(&p.type_metadata, &original);
            members.push(Member {
                kind: "property".into(),
                name,
                detail: written(src, &p.type_declaration_metadata),
                params: None,
                line: line(span.start.offset),
                visibility: visibility(p.read_visibility).into(),
                is_static: p.flags.is_static(),
                ty,
                elem,
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
                ty: None,
                elem: None,
            });
        }
        for c in class.enum_cases.values() {
            members.push(Member { kind: "const".into(), name: c.name.to_string(), detail: String::new(), params: None, line: line(c.name_span.start.offset), visibility: "public".into(), is_static: true, ty: Some(fqn.clone()), elem: None });
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
        let mixins: Vec<String> = class.mixins.iter().filter_map(|m| first_class(&m.type_union, &|w| original_name(codebase, casing, w))).filter(|m| m != "static").collect();
        let offset = class.name_span.unwrap_or(class.span).start.offset;
        out.push((offset, ClassEntry {
            name: fqn.rsplit('\\').next().unwrap_or(&fqn).to_string(),
            kind: kind.into(),
            line: line(class.name_span.unwrap_or(class.span).start.offset),
            end_line: line(class.span.end.offset),
            extends: class.direct_parent_class.as_ref().map(original),
            implements,
            traits,
            mixins,
            members,
            fqn,
        }));
    }
    // In source order (several classes can share a line).
    out.sort_by_key(|(offset, _)| *offset);
    out.into_iter().map(|(_, c)| c).collect()
}

/// Names a file refers to, counted by name only (for the "N usages" estimate shown without a
/// language server): members after `->`, `?->` and `::`, Laravel route actions
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
    /// Lower-case function FQN → (file, function index).
    functions: HashMap<String, (String, usize)>,
    /// Search Everywhere's flat list of symbols: built on the first search after a change, then
    /// reused for every keystroke.
    search: std::sync::Mutex<Option<Arc<SearchTable>>>,
}

#[derive(Clone, Copy, PartialEq)]
enum SearchKind {
    Class,
    Method,
    Function,
}

/// One symbol Search Everywhere can find, with what scoring needs ready (the lower-case name).
struct SearchEntry {
    kind: SearchKind,
    /// The name matched against the query: class, method or function name.
    name: Box<str>,
    lower: Box<str>,
    /// As listed: `User`, `User::save()`, `helper()` (also the tie-breaker when sorting).
    display: Box<str>,
    /// Index into `SearchTable::paths`, then the class or function in that file, then the member.
    file: u32,
    item: u32,
    member: u32,
}

struct SearchTable {
    paths: Vec<String>,
    vendor: Vec<bool>,
    entries: Vec<SearchEntry>,
}

impl ProjectIndex {
    /// The symbols Search Everywhere looks through (classes, public methods, functions).
    fn search_table(&self) -> Arc<SearchTable> {
        let mut cached = self.search.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(table) = cached.as_ref() {
            return Arc::clone(table);
        }
        let vendor_prefix = format!("{}/vendor/", self.root);
        let mut table = SearchTable { paths: Vec::with_capacity(self.files.len()), vendor: Vec::new(), entries: Vec::new() };
        for (path, f) in &self.files {
            let file = table.paths.len() as u32;
            table.vendor.push(path.starts_with(&vendor_prefix));
            table.paths.push(path.clone());
            let entry = |kind, name: &str, display: String, item: usize, member: usize| SearchEntry {
                kind,
                name: name.into(),
                lower: name.to_lowercase().into(),
                display: display.into(),
                file,
                item: item as u32,
                member: member as u32,
            };
            for (ci, c) in f.symbols.classes.iter().enumerate() {
                table.entries.push(entry(SearchKind::Class, &c.name, c.name.clone(), ci, 0));
                for (mi, m) in c.members.iter().enumerate().filter(|(_, m)| m.kind == "method" && m.visibility == "public") {
                    table.entries.push(entry(SearchKind::Method, &m.name, format!("{}::{}()", c.name, m.name), ci, mi));
                }
            }
            for (fi, fun) in f.symbols.functions.iter().enumerate() {
                table.entries.push(entry(SearchKind::Function, &fun.name, format!("{}()", fun.name), fi, 0));
            }
        }
        let table = Arc::new(table);
        *cached = Some(Arc::clone(&table));
        table
    }

    /// The index changed: the search table is built again on the next search.
    fn changed(&mut self) {
        *self.search.get_mut().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn add_aggregates(&mut self, path: &str) {
        let Some(f) = self.files.get(path) else { return };
        for (i, c) in f.symbols.classes.iter().enumerate() {
            self.by_fqn.insert(c.fqn.to_lowercase(), (path.to_string(), i));
            self.by_short.entry(c.name.to_lowercase()).or_default().push((path.to_string(), i));
        }
        for (name, n) in &f.symbols.refs {
            *self.refs.entry(name.clone()).or_default() += n;
        }
        for (i, fun) in f.symbols.functions.iter().enumerate() {
            self.functions.insert(fun.fqn.to_lowercase(), (path.to_string(), i));
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
        for fun in &f.symbols.functions {
            if self.functions.get(&fun.fqn.to_lowercase()).is_some_and(|(p, _)| p == path) {
                self.functions.remove(&fun.fqn.to_lowercase());
            }
        }
    }

    fn rebuild(&mut self) {
        self.changed();
        self.by_fqn.clear();
        self.by_short.clear();
        self.refs.clear();
        self.functions.clear();
        let paths: Vec<String> = self.files.keys().cloned().collect();
        for p in paths {
            self.add_aggregates(&p);
        }
    }

    fn set(&mut self, path: String, file: CachedFile) {
        self.changed();
        self.remove_aggregates(&path);
        self.files.insert(path.clone(), file);
        self.add_aggregates(&path);
    }

    fn remove(&mut self, path: &str) {
        self.changed();
        self.remove_aggregates(path);
        self.files.remove(path);
    }

    fn class(&self, at: &(String, usize)) -> Option<&ClassEntry> {
        self.files.get(&at.0)?.symbols.classes.get(at.1)
    }

    /// Is `class` the class `ancestor`, or does it extend, implement or use it (at any depth)?
    fn is_a(&self, class: &str, ancestor: &str) -> bool {
        let target = ancestor.trim_start_matches('\\').to_lowercase();
        let mut queue = vec![class.trim_start_matches('\\').to_string()];
        let mut seen = HashSet::new();
        while let Some(name) = queue.pop() {
            let key = name.to_lowercase();
            if key == target {
                return true;
            }
            if !seen.insert(key.clone()) || seen.len() > 64 {
                continue;
            }
            if let Some(at) = self.by_fqn.get(&key) {
                if let Some(c) = self.class(at) {
                    queue.extend(c.extends.iter().cloned());
                    queue.extend(c.implements.iter().cloned());
                    queue.extend(c.traits.iter().cloned());
                }
            }
        }
        false
    }

    /// Where a member of a class is declared: the class itself, else its parents and traits, then
    /// interfaces. `kind`: "method", "property", "const", or empty for any.
    fn find_member(&self, class: &str, name: &str, kind: &str) -> Option<(String, &ClassEntry, &Member)> {
        let mut queue = std::collections::VecDeque::from([class.to_string()]);
        let mut seen = HashSet::new();
        while let Some(c) = queue.pop_front() {
            let Some((path, entry)) = self.find(&c) else { continue };
            if !seen.insert(entry.fqn.to_lowercase()) || seen.len() > 64 {
                continue;
            }
            // Methods are case-insensitive in PHP; properties and constants are not.
            let hit = entry.members.iter().find(|m| (kind.is_empty() || m.kind == kind) && if m.kind == "method" { m.name.eq_ignore_ascii_case(name) } else { m.name == name });
            if let Some(m) = hit {
                return Some((path.clone(), entry, m));
            }
            queue.extend(entry.traits.iter().cloned());
            queue.extend(entry.extends.iter().cloned());
            queue.extend(entry.implements.iter().cloned());
        }
        None
    }

    /// A function by name: `Ns\foo` first, then the global `foo` (PHP's fallback for unqualified calls).
    fn find_function(&self, name: &str, namespace: Option<&str>) -> Option<(&String, &FunctionEntry)> {
        let name = name.trim_start_matches('\\');
        let mut tries = Vec::new();
        if let Some(ns) = namespace.filter(|ns| !ns.is_empty() && !name.contains('\\')) {
            tries.push(format!("{ns}\\{name}"));
        }
        tries.push(name.to_string());
        for t in tries {
            if let Some((path, i)) = self.functions.get(&t.to_lowercase()) {
                if let Some(f) = self.files.get(path).and_then(|f| f.symbols.functions.get(*i)) {
                    return Some((path, f));
                }
            }
        }
        None
    }

    /// The class declared around a line of a file.
    fn class_at(&self, path: &str, line: u32) -> Option<&ClassEntry> {
        self.files.get(path)?.symbols.classes.iter().rfind(|c| c.line <= line && line <= c.end_line.max(c.line))
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

/// The open project's folder (empty when none is open) and how many files and classes the index holds.
pub(crate) fn overview(state: &IndexState) -> Result<(String, usize, usize), String> {
    let idx = state.index.read().map_err(|e| e.to_string())?;
    Ok((idx.root.clone(), idx.files.len(), idx.by_fqn.len()))
}

/// The cache file: in the project's `.blitz/cache`, or in the app's cache
/// folder when the project can't be written to.
fn cache_path(app: &AppHandle, root: &str) -> Option<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.to_lowercase().hash(&mut h);
    let app_dir = app.path().app_cache_dir().ok().map(|d| d.join("index"));
    let key = format!("{:016x}", h.finish());
    // The JSON cache of earlier versions: not read any more.
    if let Some(d) = &app_dir {
        let _ = std::fs::remove_file(d.join(format!("{key}.json")));
    }
    if let Ok(dir) = crate::blitz::cache_dir(root) {
        return Some(dir.join("index.bin"));
    }
    let dir = app_dir?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{key}.bin")))
}

fn load_cache(path: &Path, root: &str) -> HashMap<String, CachedFile> {
    let Ok(bytes) = std::fs::read(path) else { return HashMap::new() };
    let header = CACHE_MAGIC.len() + 4;
    if bytes.len() < header || &bytes[..CACHE_MAGIC.len()] != CACHE_MAGIC || bytes[CACHE_MAGIC.len()..header] != CACHE_VERSION.to_le_bytes() {
        return HashMap::new();
    }
    match bincode::deserialize::<CacheFile>(&bytes[header..]) {
        Ok(c) => c.files.into_iter().map(|(rel, f)| (format!("{root}/{rel}"), f)).collect(),
        Err(_) => HashMap::new(),
    }
}

fn save_cache(path: &Path, index: &ProjectIndex) {
    let prefix = format!("{}/", index.root);
    let files = index.files.iter().filter_map(|(p, f)| Some((p.strip_prefix(&prefix)?, f))).collect();
    let mut bytes = Vec::with_capacity(1 << 20);
    bytes.extend_from_slice(CACHE_MAGIC);
    bytes.extend_from_slice(&CACHE_VERSION.to_le_bytes());
    if bincode::serialize_into(&mut bytes, &CacheRef { files }).is_ok() {
        let _ = crate::blitz::write_atomic(path, &bytes);
    }
}

/// PHP files of the project, vendor included (even when .gitignore'd), skipping tool folders and
/// the folders marked Excluded.
fn php_files(root: &str, excludes: &[String]) -> Vec<(String, u64, u64)> {
    let excluded = crate::project::Excluded::new(root, excludes);
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(t) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = crate::fs::norm(&entry.path());
            if t.is_dir() {
                if !crate::project::skips(&name, crate::project::Purpose::Index) && !excluded.contains(&path) {
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
        // What's left of the old cache are files deleted since: with none of those and nothing
        // parsed, the cache on disk is already right and isn't written again.
        let removed = cached.len();
        next.files.extend(parsed);
        next.rebuild();
        if let Some(p) = &cache {
            if parsed_count > 0 || removed > 0 || !p.exists() {
                save_cache(p, &next);
            }
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

/// One file's declarations, for the Structure panel and the breadcrumbs.
#[derive(Serialize)]
pub struct FileStructure {
    classes: Vec<ClassEntry>,
    functions: Vec<FunctionEntry>,
}

/// The Structure of an indexed file, exact from the parser (the UI's regex scan is the fallback).
#[tauri::command(async)]
pub fn index_file_structure(state: tauri::State<'_, IndexState>, path: String) -> Result<Option<FileStructure>, String> {
    let idx = state.index.read().map_err(|e| e.to_string())?;
    Ok(idx.files.get(&path).map(|f| FileStructure { classes: f.symbols.classes.clone(), functions: f.symbols.functions.clone() }))
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

/// The class kinds of the PHP files directly in these folders, for their icons (the tree asks
/// per folder as it shows them, instead of for every file of the project at once).
#[tauri::command]
pub async fn index_kinds_in(state: tauri::State<'_, IndexState>, dirs: Vec<String>) -> Result<Vec<(String, String)>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        Ok(kinds_in(&idx, &dirs))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn kinds_in(idx: &ProjectIndex, dirs: &[String]) -> Vec<(String, String)> {
    let dirs: HashSet<&str> = dirs.iter().map(|d| d.trim_end_matches('/')).collect();
    idx.files
        .iter()
        .filter(|(p, _)| p.rsplit_once('/').is_some_and(|(dir, _)| dirs.contains(dir)))
        .filter_map(|(p, f)| f.symbols.classes.first().map(|c| (p.clone(), c.kind.clone())))
        .collect()
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

/// A function called as `name()` in `namespace`: its return type, for completion after `helper()->`.
/// Like PHP, an unqualified name in a namespace falls back to the global function.
#[tauri::command(async)]
pub fn index_function(state: tauri::State<'_, IndexState>, name: String, namespace: Option<String>) -> Result<Option<FunctionEntry>, String> {
    let idx = state.index.read().map_err(|e| e.to_string())?;
    Ok(idx.find_function(&name, namespace.as_deref()).map(|(_, f)| f.clone()))
}

/// A class with its members, inherited ones included. `name`: FQN, or a short name.
#[tauri::command]
pub async fn index_class(state: tauri::State<'_, IndexState>, name: String) -> Result<Option<ClassInfo>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        let Some((path, class)) = idx.find(&name) else { return Ok(None) };
        // Walked by reference: a Laravel model reaches Eloquent's builders (hundreds of members)
        // through @mixin, and only the members that are kept get copied.
        let mut all = Vec::new();
        let mut seen: HashSet<(&str, String)> = HashSet::new();
        let mut queue: Vec<&ClassEntry> = vec![class];
        let mut visited: HashSet<String> = HashSet::new();
        while let Some(c) = queue.pop() {
            if !visited.insert(c.fqn.to_lowercase()) || visited.len() > 32 {
                continue;
            }
            for m in &c.members {
                if seen.insert((m.kind.as_str(), m.name.to_lowercase())) {
                    all.push(m.clone());
                }
            }
            // Parents after the class itself: interfaces first so the class's parent wins over them.
            for p in c.implements.iter().chain(c.traits.iter()).chain(c.extends.iter()).chain(c.mixins.iter()) {
                if let Some((_, parent)) = idx.find(p) {
                    queue.push(parent);
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

/// How well `query` matches `name`: prefix, camel humps, then substring. None: no match.
#[cfg(test)]
fn score(name: &str, query: &str) -> Option<i32> {
    score_with(name, &name.to_lowercase(), query, &query.to_lowercase())
}

/// [`score`] with both lower-case forms computed by the caller (once per name, once per query).
fn score_with(name: &str, n: &str, query: &str, q: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    // Every kind of match uses the query's characters in order: names without them are out.
    let mut rest = n.chars();
    if !q.chars().all(|qc| rest.any(|nc| nc == qc)) {
        return None;
    }
    if n == q {
        return Some(1000);
    }
    if n.starts_with(q) {
        return Some(800 - name.len() as i32);
    }
    // Camel humps: "UC" or "UsCon" matches "UserController".
    let chars: Vec<char> = name.chars().collect();
    let humps: Vec<(usize, char)> = chars.iter().copied().enumerate().filter(|(i, c)| *i == 0 || c.is_uppercase() || c.is_ascii_digit()).collect();
    let mut qi = query.chars().peekable();
    let mut hi = 0;
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
        let mut pos = humps[hi].0 + 1;
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
    if ok {
        return Some(600 - name.len() as i32);
    }
    n.find(q).map(|i| 400 - i as i32 - name.len() as i32)
}

/// Search Everywhere / Go to Class: classes, then public methods and functions, best first.
#[tauri::command]
pub async fn index_search(state: tauri::State<'_, IndexState>, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        Ok(search(&idx, &query, limit.unwrap_or(100)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Search Everywhere's classes, methods and functions for a query, best first.
fn search(idx: &ProjectIndex, query: &str, limit: usize) -> Vec<SearchHit> {
    let query = query.trim();
    // "User::save" searches members of matching classes.
    let (class_q, member_q) = match query.split_once("::") {
        Some((c, m)) => (c, Some(m)),
        None => (query, None),
    };
    let table = idx.search_table();
    // Project symbols rank above vendor ones.
    let bonus = |e: &SearchEntry| if table.vendor[e.file as usize] { -150 } else { 0 };
    let q_lower = query.to_lowercase();
    let scored: Vec<(i32, usize)> = match member_q {
        // "User::save": methods of the classes matching "User".
        Some(mq) => {
            let cq_lower = class_q.to_lowercase();
            let mq_lower = mq.to_lowercase();
            let class_scores: HashMap<(u32, u32), i32> = table
                .entries
                .par_iter()
                .filter(|e| e.kind == SearchKind::Class)
                .filter_map(|e| score_with(&e.name, &e.lower, class_q, &cq_lower).map(|s| ((e.file, e.item), s)))
                .collect();
            table
                .entries
                .par_iter()
                .enumerate()
                .filter(|(_, e)| e.kind == SearchKind::Method)
                .filter_map(|(i, e)| {
                    let cs = class_scores.get(&(e.file, e.item))?;
                    let ms = score_with(&e.name, &e.lower, mq, &mq_lower)?;
                    Some((cs / 4 + ms + bonus(e) - 100, i))
                })
                .collect()
        }
        None => table
            .entries
            .par_iter()
            .enumerate()
            .filter_map(|(i, e)| {
                let offset = match e.kind {
                    SearchKind::Class => 50,
                    // An empty query lists classes only.
                    _ if query.is_empty() => return None,
                    SearchKind::Method => -100,
                    SearchKind::Function => -80,
                };
                score_with(&e.name, &e.lower, query, &q_lower).map(|s| (s + bonus(e) + offset, i))
            })
            .collect(),
    };
    // Only the best `limit` are sorted: highest score first, then by name.
    let order = |a: &(i32, usize), b: &(i32, usize)| b.0.cmp(&a.0).then_with(|| table.entries[a.1].display.cmp(&table.entries[b.1].display));
    let mut scored = scored;
    if limit > 0 && scored.len() > limit {
        scored.select_nth_unstable_by(limit - 1, order);
    }
    scored.truncate(limit);
    scored.sort_by(order);
    let hits = scored.into_iter().filter_map(|(_, i)| {
        let e = &table.entries[i];
        let path = &table.paths[e.file as usize];
        let f = idx.files.get(path)?;
        let vendor = table.vendor[e.file as usize];
        Some(match e.kind {
            SearchKind::Class => {
                let c = f.symbols.classes.get(e.item as usize)?;
                SearchHit { kind: c.kind.clone(), name: c.name.clone(), detail: c.fqn.clone(), path: path.clone(), line: c.line, vendor }
            }
            SearchKind::Method => {
                let m = f.symbols.classes.get(e.item as usize)?.members.get(e.member as usize)?;
                SearchHit { kind: "method".into(), name: e.display.to_string(), detail: m.detail.clone(), path: path.clone(), line: m.line, vendor }
            }
            SearchKind::Function => {
                let fun = f.symbols.functions.get(e.item as usize)?;
                SearchHit { kind: "function".into(), name: e.display.to_string(), detail: fun.fqn.clone(), path: path.clone(), line: fun.line, vendor }
            }
        })
    });
    hits.collect()
}

/// References to each name across the project (name-based estimate).
#[tauri::command(async)]
pub fn index_usages(state: tauri::State<'_, IndexState>, names: Vec<String>) -> Result<Vec<u32>, String> {
    // A few hash lookups: cheap enough to answer right away.
    let idx = state.index.read().map_err(|e| e.to_string())?;
    Ok(names.iter().map(|n| idx.refs.get(n).copied().unwrap_or(0)).collect())
}

// ── Go to Definition / Find Usages ───────────────────────────

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Class { name: String },
    #[serde(rename_all = "camelCase")]
    Member { class: String, name: String, member_kind: Option<String> },
    Function { name: String, namespace: Option<String> },
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    path: String,
    line: u32,
    /// What was found: "App\Models\User", "User::save()", "helper()".
    name: String,
}

fn locate(idx: &ProjectIndex, target: &Target) -> Option<Location> {
    match target {
        Target::Class { name } => idx.find(name).map(|(path, c)| Location { path: path.clone(), line: c.line, name: c.fqn.clone() }),
        Target::Member { class, name, member_kind } => idx.find_member(class, name, member_kind.as_deref().unwrap_or("")).map(|(path, c, m)| Location {
            path,
            line: m.line,
            name: format!("{}::{}{}", c.name, if m.kind == "property" { "$" } else { "" }, if m.kind == "method" { format!("{}()", m.name) } else { m.name.clone() }),
        }),
        Target::Function { name, namespace } => idx.find_function(name, namespace.as_deref()).map(|(path, f)| Location { path: path.clone(), line: f.line, name: format!("{}()", f.fqn) }),
    }
}

/// Every declaration a rename must change: the class or function itself; for a member, its
/// declaration and the same member declared up and down the hierarchy (parents, interfaces, traits,
/// subclasses), so overrides and implementations keep matching.
fn declarations(idx: &ProjectIndex, target: &Target) -> Vec<Location> {
    let Target::Member { class, name, member_kind } = target else { return locate(idx, target).into_iter().collect() };
    let kind = member_kind.as_deref().unwrap_or("");
    let Some((_, declaring, member)) = idx.find_member(class, name, kind) else { return Vec::new() };
    let (base, kind) = (declaring.fqn.clone(), member.kind.clone());
    let same = |m: &Member| m.kind == kind && if kind == "method" { m.name.eq_ignore_ascii_case(name) } else { m.name == *name };
    let mut out: Vec<Location> = Vec::new();
    for (path, file) in &idx.files {
        for c in &file.symbols.classes {
            if !(idx.is_a(&c.fqn, &base) || idx.is_a(&base, &c.fqn)) {
                continue;
            }
            for m in c.members.iter().filter(|m| same(m)) {
                out.push(Location { path: path.clone(), line: m.line, name: format!("{}::{}", c.fqn, m.name) });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    out
}

/// Rename: the declarations to change with the usages (see `declarations`).
#[tauri::command]
pub async fn index_declarations(state: tauri::State<'_, IndexState>, target: Target) -> Result<Vec<Location>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(declarations(&*index.read().map_err(|e| e.to_string())?, &target)))
        .await
        .map_err(|e| e.to_string())?
}

/// Go to Definition: where a class, member or function is declared.
#[tauri::command]
pub async fn index_locate(state: tauri::State<'_, IndexState>, target: Target) -> Result<Option<Location>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(locate(&*index.read().map_err(|e| e.to_string())?, &target)))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageHit {
    path: String,
    line: u32,
    /// 1-based, UTF-16 (Monaco's columns).
    column: u32,
    end_column: u32,
    preview: String,
    /// Called on something whose type is unknown (`$x->save()`): maybe this member, maybe another
    /// class's member of the same name.
    dynamic: bool,
    /// Properties: "read" or "write" (`$this->x = …`, `+=`, `++`); empty for the rest.
    access: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagesResult {
    name: String,
    /// "Class", "Method", "Field", "Constant", "Function".
    kind: String,
    /// "\App\Entity\Photo.$uploader", "\App\Models\User::save()", "\App\Models\User".
    title: String,
    /// The class (or namespace) it belongs to, and the declaring file.
    container: String,
    declared_in: String,
    items: Vec<UsageHit>,
    /// Files searched.
    files: usize,
}

/// `$this->x = 1`, `+=`, `.=`, `??=`, `++` / `--`: the property is written.
fn is_write(after: &str, before: &str) -> bool {
    let a = after.trim_start();
    let assigned = (a.starts_with('=') && !a.starts_with("==") && !a.starts_with("=>"))
        || ["+=", "-=", "*=", "/=", ".=", "%=", "??=", "**=", "|=", "&=", "^=", "<<=", ">>=", "++", "--"].iter().any(|op| a.starts_with(op));
    assigned || before.trim_end().rsplit(|c: char| c.is_whitespace() || c == '(' || c == ';').find(|s| !s.is_empty()).is_some_and(|t| t.starts_with("++") || t.starts_with("--"))
}

const MAX_USAGES: usize = 5000;

/// Where each line of a text starts, so a file with many hits finds their lines by binary search
/// instead of counting newlines from the top for each one.
struct Lines<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        Lines { text, starts }
    }

    /// Line, 1-based UTF-16 column, and the line's text for a byte offset.
    fn position(&self, offset: usize) -> (u32, u32, &'a str) {
        let line = self.starts.partition_point(|&s| s <= offset);
        let start = self.starts[line - 1];
        let end = self.starts.get(line).map_or(self.text.len(), |&next| next - 1);
        let column = self.text[start..offset].encode_utf16().count() as u32 + 1;
        (line as u32, column, self.text[start..end].trim_end_matches('\r'))
    }

    fn line(&self, offset: usize) -> u32 {
        self.starts.partition_point(|&s| s <= offset) as u32
    }
}

/// What a Find Usages run reuses for every file: the member pattern, compiled once.
struct UsageMatcher {
    member: Option<Regex>,
}

impl UsageMatcher {
    fn new(target: &Target) -> Self {
        let member = match target {
            Target::Member { name, .. } => Some(Regex::new(&format!(r"(?i)(->|\?->|::)(\s*)(\$?)({})\b(\s*\()?", regex::escape(name))).unwrap()),
            _ => None,
        };
        UsageMatcher { member }
    }
}

/// Usages of a target in one file's text.
#[cfg(test)]
fn usages_in(idx: &ProjectIndex, path: &str, text: &str, target: &Target, class_fqn: Option<&str>) -> Vec<UsageHit> {
    usages_with(idx, &UsageMatcher::new(target), path, text, target, class_fqn)
}

/// Usages of a target in one file's text, with the run's compiled matcher.
fn usages_with(idx: &ProjectIndex, matcher: &UsageMatcher, path: &str, text: &str, target: &Target, class_fqn: Option<&str>) -> Vec<UsageHit> {
    let mut out = Vec::new();
    let lines = Lines::new(text);
    let hit = |out: &mut Vec<UsageHit>, start: usize, end: usize, dynamic: bool| {
        let (line, column, line_text) = lines.position(start);
        let width = text[start..end].encode_utf16().count() as u32;
        out.push(UsageHit { path: path.to_string(), line, column, end_column: column + width, preview: line_text.trim().to_string(), dynamic, access: "" });
    };
    // Names as PHP resolves them (imports, namespace): exact class and function references.
    // Parsed only when needed: a member search parses a file only for its `Class::` receivers.
    let arena = LocalArena::new();
    let file = std::cell::OnceCell::new();
    let parsed = std::cell::OnceCell::new();
    let names = || -> &Vec<(u32, u32, Vec<u8>)> {
        parsed.get_or_init(|| {
            let file = file.get_or_init(|| File::new(Cow::Owned(path.as_bytes().to_vec()), FileType::Host, Some(PathBuf::from(path)), Cow::Owned(text.as_bytes().to_vec())));
            let program = parse_file_borrowed_with_settings(&arena, file, ParserSettings::default());
            let resolved = NameResolver::new(&arena).resolve(program);
            let mut list: Vec<(u32, u32, Vec<u8>)> = resolved.iter().map(|(s, e, n, _)| (s, e, n.to_vec())).collect();
            list.sort_by_key(|(s, _, _)| *s);
            list
        })
    };
    // The resolved name covering an offset: binary search over the names sorted by start.
    let resolved_at = |offset: usize| {
        let list = names();
        let i = list.partition_point(|(s, _, _)| *s as usize <= offset);
        let (_, e, n) = list.get(i.checked_sub(1)?)?;
        (offset < *e as usize).then(|| String::from_utf8_lossy(n).trim_start_matches('\\').to_string())
    };

    match target {
        Target::Class { .. } => {
            let fqn = class_fqn.unwrap_or_default();
            for &(start, end, ref name) in names() {
                if !String::from_utf8_lossy(name).trim_start_matches('\\').eq_ignore_ascii_case(fqn) {
                    continue;
                }
                // The declaration itself (`class Post`) is not a usage.
                let before = text[..start as usize].trim_end();
                if ["class", "interface", "trait", "enum"].iter().any(|k| before.ends_with(k)) {
                    continue;
                }
                hit(&mut out, start as usize, end as usize, false);
            }
        }
        Target::Function { name, .. } => {
            let fqn = class_fqn.unwrap_or(name).trim_start_matches('\\');
            let global = !fqn.contains('\\');
            for &(start, end, ref resolved) in names() {
                let resolved = String::from_utf8_lossy(resolved);
                let resolved = resolved.trim_start_matches('\\');
                let written = &text[start as usize..end as usize];
                // `foo()` in a namespace falls back to the global foo() unless Ns\foo exists.
                let fallback = global && !written.contains('\\') && resolved.rsplit('\\').next().is_some_and(|n| n.eq_ignore_ascii_case(fqn)) && idx.find_function(resolved, None).is_none();
                let declaration = text[..start as usize].trim_end().ends_with("function");
                if (resolved.eq_ignore_ascii_case(fqn) || fallback) && !declaration && text[end as usize..].trim_start().starts_with('(') {
                    hit(&mut out, start as usize, end as usize, false);
                }
            }
        }
        Target::Member { name, member_kind, .. } => {
            let class = class_fqn.unwrap_or_default();
            let kind = member_kind.as_deref().unwrap_or("");
            let Some(re) = matcher.member.as_ref() else { return out };
            for m in re.captures_iter(text) {
                let (op, dollar, word, call) = (m.get(1).unwrap(), m.get(3).unwrap(), m.get(4).unwrap(), m.get(5));
                // PHP: methods are case-insensitive, properties and constants are not.
                let is_call = call.is_some();
                let ok = match kind {
                    "method" => is_call,
                    "property" => !is_call && (op.as_str() != "::" || !dollar.as_str().is_empty()),
                    "const" => !is_call && op.as_str() == "::" && dollar.as_str().is_empty(),
                    _ => true,
                };
                if !ok || (kind != "method" && word.as_str() != name) {
                    continue;
                }
                // What it is called on.
                let before = text[..op.start()].trim_end();
                let receiver: Option<String> = if before.ends_with("$this") {
                    idx.class_at(path, lines.line(op.start())).map(|c| c.fqn.clone())
                } else if let Some(word_start) = before.rfind(|c: char| !(c.is_alphanumeric() || c == '_' || c == '\\')).map(|i| i + 1).or(Some(0)) {
                    let ident = &before[word_start..];
                    if ident.is_empty() || before[..word_start].ends_with('$') || ident.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                        None
                    } else {
                        match ident.to_ascii_lowercase().as_str() {
                            "self" | "static" => idx.class_at(path, lines.line(op.start())).map(|c| c.fqn.clone()),
                            "parent" => idx.class_at(path, lines.line(op.start())).and_then(|c| c.extends.clone()),
                            _ if op.as_str() == "::" => resolved_at(word_start),
                            _ => None,
                        }
                    }
                } else {
                    None
                };
                let dynamic = match receiver {
                    // Known class: a usage when it is the class or inherits from it.
                    Some(r) => {
                        if !idx.is_a(&r, class) {
                            continue;
                        }
                        false
                    }
                    None => true,
                };
                hit(&mut out, word.start() - dollar.len(), word.end(), dynamic);
                if kind == "property" {
                    if let Some(last) = out.last_mut() {
                        last.access = if is_write(&text[word.end()..], before) { "write" } else { "read" };
                    }
                }
            }
        }
    }
    out.sort_by_key(|u| (u.line, u.column));
    out
}

/// Find Usages: classes and functions by resolved name (exact); members through `$this`, `self`,
/// `static`, `parent` and `Class::` (exact, checked against the class hierarchy) and on untyped
/// receivers (dynamic). Project files only (not vendor). `overrides`: unsaved editor texts.
#[tauri::command]
pub async fn index_find_usages(state: tauri::State<'_, IndexState>, target: Target, overrides: Option<HashMap<String, String>>, include_vendor: Option<bool>) -> Result<UsagesResult, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let idx = index.read().map_err(|e| e.to_string())?;
        let overrides = overrides.unwrap_or_default();
        // The declaration, to search for its real FQN.
        let (display, class_fqn, needle, kind, title, container, declared_in) = match &target {
            Target::Class { name } => {
                let (path, c) = idx.find(name).ok_or_else(|| format!("{name} is not in the index"))?;
                let kind = match c.kind.as_str() { "interface" => "Interface", "trait" => "Trait", "enum" => "Enum", _ => "Class" };
                let ns = c.fqn.rsplit_once('\\').map(|(ns, _)| ns.to_string()).unwrap_or_default();
                (c.fqn.clone(), c.fqn.clone(), c.name.clone(), kind, format!("\\{}", c.fqn), ns, path.clone())
            }
            Target::Member { class, name, member_kind } => {
                let (path, c, m) = idx.find_member(class, name, member_kind.as_deref().unwrap_or("")).ok_or_else(|| format!("{class}::{name} is not in the index"))?;
                let (kind, title) = match m.kind.as_str() {
                    "method" => ("Method", format!("\\{}::{}()", c.fqn, m.name)),
                    "property" => ("Field", format!("\\{}.${}", c.fqn, m.name)),
                    _ => ("Constant", format!("\\{}::{}", c.fqn, m.name)),
                };
                (format!("{}::{}", c.name, m.name), c.fqn.clone(), m.name.clone(), kind, title, c.name.clone(), path)
            }
            Target::Function { name, namespace } => {
                let (path, f) = idx.find_function(name, namespace.as_deref()).ok_or_else(|| format!("{name}() is not in the index"))?;
                let ns = f.fqn.rsplit_once('\\').map(|(ns, _)| ns.to_string()).unwrap_or_default();
                (format!("{}()", f.fqn), f.fqn.clone(), f.name.clone(), "Function", format!("\\{}()", f.fqn), ns, path.clone())
            }
        };
        let matcher = UsageMatcher::new(&target);
        // Files that can't contain the name are skipped: case-insensitive, on the raw bytes.
        let mentions = regex::bytes::RegexBuilder::new(&regex::escape(&needle)).case_insensitive(true).unicode(false).build().map_err(|e| e.to_string())?;
        let is_member = matches!(target, Target::Member { .. });
        let vendor = format!("{}/vendor/", idx.root);
        let with_vendor = include_vendor.unwrap_or(false);
        let paths: Vec<&String> = idx.files.keys().filter(|p| with_vendor || !p.starts_with(&vendor)).collect();
        let files = paths.len();
        let mut items: Vec<UsageHit> = crate::mago::analysis_pool().install(|| {
            paths
                .par_iter()
                .flat_map_iter(|path| {
                    let text: Cow<str> = match overrides.get(*path) {
                        Some(t) => Cow::Borrowed(t.as_str()),
                        None => {
                            // Members: the index already knows which names follow `->` / `::` in
                            // each file, so most files are never read.
                            if is_member && idx.files.get(*path).is_some_and(|f| !f.symbols.refs.iter().any(|(n, _)| n.eq_ignore_ascii_case(&needle))) {
                                return Vec::new();
                            }
                            let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
                            if !mentions.is_match(&bytes) {
                                return Vec::new();
                            }
                            Cow::Owned(String::from_utf8_lossy(&bytes).into_owned())
                        }
                    };
                    if !mentions.is_match(text.as_bytes()) {
                        return Vec::new();
                    }
                    usages_with(&idx, &matcher, path, &text, &target, Some(&class_fqn))
                })
                .collect()
        });
        items.sort_by(|a, b| a.dynamic.cmp(&b.dynamic).then_with(|| a.path.cmp(&b.path)).then_with(|| a.line.cmp(&b.line)).then_with(|| a.column.cmp(&b.column)));
        items.truncate(MAX_USAGES);
        Ok(UsagesResult { name: display, kind: kind.to_string(), title, container, declared_in, items, files })
    })
    .await
    .map_err(|e| e.to_string())?
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
    fn records_member_types_for_completion() {
        let src = r#"<?php
namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

/**
 * @property int $id
 * @property-read Team $team
 * @method static Builder active()
 * @mixin Builder
 */
class User extends Model
{
    public ?Team $owner = null;

    public function team(): Team { return new Team(); }

    public function rename(string $name): static { return $this; }

    /** @return Collection<int, Post> */
    public function posts(): Collection { return new Collection(); }

    /** @return list<Post> */
    public function drafts(): array { return []; }
}

enum Status: string { case Active = 'active'; }

/** @return User|null */
function current_user() { return null; }
"#;
        let s = scan("/p/app/Models/User.php", src.as_bytes());
        let c = s.classes.iter().find(|c| c.name == "User").unwrap();
        let m = |name: &str| c.members.iter().find(|m| m.name == name).unwrap_or_else(|| panic!("{name} in {:?}", c.members));
        assert_eq!(m("team").ty.as_deref(), Some(r"App\Models\Team"));
        assert_eq!(m("owner").ty.as_deref(), Some(r"App\Models\Team"), "nullable property");
        assert_eq!(m("rename").ty.as_deref(), Some("static"));
        let posts = m("posts");
        assert_eq!((posts.ty.as_deref(), posts.elem.as_deref()), (Some(r"Illuminate\Support\Collection"), Some(r"App\Models\Post")));
        assert_eq!(m("drafts").elem.as_deref(), Some(r"App\Models\Post"), "list<Post>");
        // Docblock members: @property, @property-read, static @method.
        assert_eq!(m("id").kind, "property");
        // Laravel style: the relation method and its dynamic property (@property-read) both exist.
        assert!(c.members.iter().any(|x| x.kind == "property" && x.name == "team" && x.ty.as_deref() == Some(r"App\Models\Team")));
        let active = m("active");
        assert!(active.kind == "method" && active.is_static, "{active:?}");
        assert_eq!(active.ty.as_deref(), Some(r"Illuminate\Database\Eloquent\Builder"));
        assert_eq!(c.mixins, vec![r"Illuminate\Database\Eloquent\Builder".to_string()]);
        let status = s.classes.iter().find(|c| c.name == "Status").unwrap();
        assert_eq!(status.members[0].ty.as_deref(), Some(r"App\Models\Status"), "an enum case is its enum");
        let f = s.functions.iter().find(|f| f.name == "current_user").unwrap();
        assert_eq!(f.ty.as_deref(), Some(r"App\Models\User"), "@return on a function");
    }

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
        assert!(refs.contains_key("Model") && refs.contains_key("HasName"));
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
        let aggregated = t3.elapsed();
        // The cache, as JSON (the format of early builds) and as it is now.
        let json = serde_json::to_vec(&idx.files).unwrap();
        let t4 = Instant::now();
        let back: HashMap<String, CachedFile> = serde_json::from_slice(&json).unwrap();
        let json_load = t4.elapsed();
        let bin = std::env::temp_dir().join("phpblitz-bench-index.bin");
        let t5 = Instant::now();
        save_cache(&bin, &idx);
        let bin_save = t5.elapsed();
        let t6 = Instant::now();
        let loaded = load_cache(&bin, &root);
        let bin_load = t6.elapsed();
        let bin_size = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
        eprintln!(
            "BENCH {} files, {} classes | list {:?} | parse+scan {:?} | aggregate {:?}",
            idx.files.len(), classes, listed, scanned, aggregated
        );
        eprintln!("BENCH cache JSON {} KB, load {:?} ({} files)", json.len() / 1024, json_load, back.len());
        eprintln!("BENCH cache binary {} KB, save {:?}, load {:?} ({} files)", bin_size / 1024, bin_save, bin_load, loaded.len());
        assert_eq!(loaded.len(), idx.files.len());
        let _ = std::fs::remove_file(bin);
        // Rough heap bytes: what declarations take vs per-file references.
        let str_bytes = |t: &str| t.len() + 24;
        let member_bytes = |m: &Member| str_bytes(&m.kind) + str_bytes(&m.name) + str_bytes(&m.detail) + m.params.as_deref().map_or(0, str_bytes) + str_bytes(&m.visibility) + 16;
        let decl: usize = idx.files.values().map(|f| {
            f.symbols.classes.iter().map(|c| str_bytes(&c.name) + str_bytes(&c.fqn) + str_bytes(&c.kind) + c.extends.as_deref().map_or(0, str_bytes) + c.implements.iter().chain(&c.traits).map(|t| str_bytes(t)).sum::<usize>() + c.members.iter().map(member_bytes).sum::<usize>() + 64).sum::<usize>()
                + f.symbols.functions.iter().map(|x| str_bytes(&x.name) + str_bytes(&x.fqn) + str_bytes(&x.params) + str_bytes(&x.detail) + 8).sum::<usize>()
        }).sum();
        let refs: usize = idx.files.values().map(|f| f.symbols.refs.iter().map(|(n, _)| str_bytes(n) + 8).sum::<usize>()).sum();
        let ref_count: usize = idx.files.values().map(|f| f.symbols.refs.len()).sum();
        let paths: usize = idx.files.keys().map(|k| str_bytes(k) * 2).sum();
        let totals: usize = idx.refs.keys().map(|k| str_bytes(k) + 8).sum();
        eprintln!("BENCH memory ~ declarations {} KB | per-file refs {} KB ({ref_count} entries) | ref totals {} KB ({} names) | paths {} KB", decl / 1024, refs / 1024, totals / 1024, idx.refs.len(), paths / 1024);
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

        // Cache: saved and loaded back; paths are relative, so it follows a moved project.
        let mut idx = ProjectIndex { root: r.clone(), ..Default::default() };
        for (p, mtime, size) in php_files(&r, &[]) {
            let symbols = scan(&p, &std::fs::read(&p).unwrap());
            idx.set(p, CachedFile { mtime, size, symbols });
        }
        let cache = root.join("index.bin");
        save_cache(&cache, &idx);
        let loaded = load_cache(&cache, &r);
        assert_eq!(loaded.len(), idx.files.len());
        let a = format!("{r}/app/A.php");
        assert_eq!(loaded[&a].symbols, idx.files[&a].symbols);
        assert_eq!(loaded[&a].mtime, idx.files[&a].mtime);
        let moved = load_cache(&cache, "/moved/project");
        assert_eq!(moved["/moved/project/app/A.php"].symbols, idx.files[&a].symbols);
        // Another format version, the old JSON cache, or garbage: ignored (the index is rebuilt).
        let mut old = std::fs::read(&cache).unwrap();
        old[CACHE_MAGIC.len()] = 2;
        std::fs::write(&cache, &old).unwrap();
        assert!(load_cache(&cache, &r).is_empty());
        std::fs::write(&cache, br#"{"version":2,"root":"x","files":{}}"#).unwrap();
        assert!(load_cache(&cache, &r).is_empty());
        let mut cut = CACHE_MAGIC.to_vec();
        cut.extend_from_slice(&CACHE_VERSION.to_le_bytes());
        cut.extend_from_slice(&[9, 9, 9]);
        std::fs::write(&cache, &cut).unwrap();
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


    fn project(files: &[(&str, &str)]) -> ProjectIndex {
        let mut idx = ProjectIndex { root: "/p".into(), ..Default::default() };
        for (path, text) in files {
            idx.set(path.to_string(), CachedFile { mtime: 1, size: 1, symbols: scan(path, text.as_bytes()) });
        }
        idx
    }

    const BASE: &str = "<?php\nnamespace App\\Models;\n\nabstract class Model\n{\n    public function save(): bool { return true; }\n    public static function find(int $id): ?static { return null; }\n}\n";
    const POST: &str = "<?php\nnamespace App\\Models;\n\nclass Post extends Model\n{\n    public string $title = '';\n    const DRAFT = 'draft';\n\n    public function publish(): void\n    {\n        $this->save();\n        self::find(1);\n        echo $this->title . self::DRAFT;\n    }\n}\n";
    const CTRL: &str = "<?php\nnamespace App\\Http;\n\nuse App\\Models\\Post;\nuse App\\Models\\Model as Base;\n\nfunction helper(): void {}\n\nfinal class PostController\n{\n    public function store(Post $post, $other): Post\n    {\n        $post->save();\n        $other->save();\n        Post::find(2);\n        Base::find(3);\n        \\App\\Models\\Post::find(4);\n        $p = new Post();\n        helper();\n        strlen('x');\n        return $post;\n    }\n}\n";

    fn idx3() -> ProjectIndex {
        project(&[("/p/app/Models/Model.php", BASE), ("/p/app/Models/Post.php", POST), ("/p/app/Http/PostController.php", CTRL)])
    }

    #[test]
    fn locates_classes_members_and_functions() {
        let idx = idx3();
        let at = |t: Target| locate(&idx, &t).map(|l| (l.path.rsplit('/').next().unwrap().to_string(), l.line, l.name));
        assert_eq!(at(Target::Class { name: "App\\Models\\Post".into() }), Some(("Post.php".into(), 4, "App\\Models\\Post".into())));
        // Inherited method: declared in the parent.
        assert_eq!(at(Target::Member { class: "App\\Models\\Post".into(), name: "save".into(), member_kind: Some("method".into()) }), Some(("Model.php".into(), 6, "Model::save()".into())));
        assert_eq!(at(Target::Member { class: "App\\Models\\Post".into(), name: "SAVE".into(), member_kind: None }).map(|x| x.1), Some(6), "methods are case-insensitive");
        assert_eq!(at(Target::Member { class: "App\\Models\\Post".into(), name: "title".into(), member_kind: Some("property".into()) }).map(|x| x.1), Some(6));
        assert_eq!(at(Target::Member { class: "App\\Models\\Post".into(), name: "DRAFT".into(), member_kind: None }).map(|x| x.1), Some(7));
        assert_eq!(at(Target::Function { name: "helper".into(), namespace: Some("App\\Http".into()) }).map(|x| x.2), Some("App\\Http\\helper()".into()));
        assert!(at(Target::Function { name: "nope".into(), namespace: None }).is_none());
        assert!(idx.is_a("App\\Models\\Post", "App\\Models\\Model") && !idx.is_a("App\\Models\\Model", "App\\Models\\Post"));
    }

    /// Renaming a method renames it where it is overridden too, but not in unrelated classes.
    #[test]
    fn finds_the_declarations_a_rename_changes() {
        let draft = "<?php\nnamespace App\\Models;\n\nclass Draft extends Post\n{\n    public function save(): bool { return false; }\n}\n";
        let other = "<?php\nnamespace App\\Other;\n\nclass Cache\n{\n    public function save(): bool { return true; }\n}\n";
        let idx = project(&[("/p/app/Models/Model.php", BASE), ("/p/app/Models/Post.php", POST), ("/p/app/Models/Draft.php", draft), ("/p/app/Other/Cache.php", other)]);
        let at = |t: Target| declarations(&idx, &t).into_iter().map(|l| (l.path.rsplit('/').next().unwrap().to_string(), l.line)).collect::<Vec<_>>();
        // From the subclass that inherits it: the base declaration and the override, not Cache::save.
        assert_eq!(at(Target::Member { class: "App\\Models\\Post".into(), name: "save".into(), member_kind: Some("method".into()) }), vec![("Draft.php".into(), 6), ("Model.php".into(), 6)]);
        assert_eq!(at(Target::Member { class: "App\\Models\\Draft".into(), name: "save".into(), member_kind: Some("method".into()) }), vec![("Draft.php".into(), 6), ("Model.php".into(), 6)]);
        assert_eq!(at(Target::Class { name: "App\\Models\\Post".into() }), vec![("Post.php".into(), 4)]);
        assert_eq!(at(Target::Member { class: "App\\Models\\Post".into(), name: "title".into(), member_kind: Some("property".into()) }), vec![("Post.php".into(), 6)]);
    }

    #[test]
    fn finds_usages() {
        let idx = idx3();
        let all = |t: Target, fqn: &str| -> Vec<(String, u32, bool)> {
            let mut v = Vec::new();
            for (path, text) in [("/p/app/Models/Model.php", BASE), ("/p/app/Models/Post.php", POST), ("/p/app/Http/PostController.php", CTRL)] {
                v.extend(usages_in(&idx, path, text, &t, Some(fqn)).into_iter().map(|u| (u.path.rsplit('/').next().unwrap().to_string(), u.line, u.dynamic)));
            }
            v
        };
        // Class: the import, the type hints, Post::find, the FQN call and new Post; not the alias of Model.
        let post = all(Target::Class { name: "Post".into() }, "App\\Models\\Post");
        assert_eq!(post.iter().filter(|u| u.0 == "PostController.php").map(|u| u.1).collect::<Vec<_>>(), vec![4, 11, 11, 15, 17, 18], "{post:?}");
        // Model::save(): $this->save() in Post (exact), $post->save() and $other->save() (dynamic).
        let save = all(Target::Member { class: "App\\Models\\Model".into(), name: "save".into(), member_kind: Some("method".into()) }, "App\\Models\\Model");
        assert_eq!(save, vec![("Post.php".into(), 11, false), ("PostController.php".into(), 13, true), ("PostController.php".into(), 14, true)]);
        // Model::find(): self::find in Post, Post::find, Base::find (alias), \App\Models\Post::find.
        let find = all(Target::Member { class: "App\\Models\\Model".into(), name: "find".into(), member_kind: Some("method".into()) }, "App\\Models\\Model");
        assert_eq!(find, vec![("Post.php".into(), 12, false), ("PostController.php".into(), 15, false), ("PostController.php".into(), 16, false), ("PostController.php".into(), 17, false)]);
        // Post::find() alone: Base::find (Model) is not a usage of Post's.
        let post_find = all(Target::Member { class: "App\\Models\\Post".into(), name: "find".into(), member_kind: Some("method".into()) }, "App\\Models\\Post");
        assert_eq!(post_find.iter().map(|u| u.1).collect::<Vec<_>>(), vec![12, 15, 17]);
        // Property and constant.
        assert_eq!(all(Target::Member { class: "App\\Models\\Post".into(), name: "title".into(), member_kind: Some("property".into()) }, "App\\Models\\Post"), vec![("Post.php".into(), 13, false)]);
        assert!(is_write(" = 1;", "$this->") && is_write(" .= 'x'", "") && is_write("++;", "") && is_write(" ??= []", ""));
        assert!(!is_write(" == 1", "") && !is_write(" => 1", "") && !is_write(";", "echo $this->") && !is_write("->save()", ""));
        assert!(is_write(";", "++$this->"));
        let rw = usages_in(&idx, "/p/x.php", "<?php class W extends App\\Models\\Post { function f() { $this->title = 'a'; echo $this->title; $this->title .= 'b'; } }", &Target::Member { class: "App\\Models\\Post".into(), name: "title".into(), member_kind: Some("property".into()) }, Some("App\\Models\\Post"));
        assert_eq!(rw.iter().map(|u| u.access).collect::<Vec<_>>(), vec!["write", "read", "write"]);
        assert_eq!(all(Target::Member { class: "App\\Models\\Post".into(), name: "DRAFT".into(), member_kind: Some("const".into()) }, "App\\Models\\Post"), vec![("Post.php".into(), 13, false)]);
        // Function: helper() resolved in its namespace; strlen() is not helper.
        assert_eq!(all(Target::Function { name: "helper".into(), namespace: None }, "App\\Http\\helper"), vec![("PostController.php".into(), 19, false)]);
        // Columns are 1-based UTF-16, like Monaco's.
        let first = usages_in(&idx, "/p/app/Http/PostController.php", CTRL, &Target::Class { name: "Post".into() }, Some("App\\Models\\Post"));
        assert_eq!((first[0].line, first[0].column, first[0].end_column), (4, 5, 20));
    }

    /// A file with thousands of hits: every position right (line table), static receivers resolved
    /// through the lazily parsed names, and fast enough to be a regression guard.
    #[test]
    fn many_usages_in_one_file() {
        let idx = idx3();
        let mut text = String::from("<?php\nnamespace App\\Http;\n\nuse App\\Models\\Post;\n\nfunction f(Post $post, $x): void\n{\n");
        let lines = 3000;
        for i in 0..lines {
            // Mixed widths before the hit (é is 2 bytes, 1 UTF-16 unit): columns must be in UTF-16.
            match i % 3 {
                0 => text.push_str("    $post->save();\n"),
                1 => text.push_str("    /* é */ $x->save();\n"),
                _ => text.push_str("    Post::find(1)->save();\n"),
            }
        }
        text.push_str("}\n");
        let target = Target::Member { class: "App\\Models\\Model".into(), name: "save".into(), member_kind: Some("method".into()) };
        let started = std::time::Instant::now();
        let hits = usages_in(&idx, "/p/app/Http/Many.php", &text, &target, Some("App\\Models\\Model"));
        let took = started.elapsed();
        assert_eq!(hits.len(), lines);
        assert_eq!((hits[0].line, hits[0].column, hits[0].end_column), (8, 12, 16));
        assert_eq!((hits[1].line, hits[1].column), (9, 17), "UTF-16 column: in bytes it would be 18");
        let last = hits.last().unwrap();
        assert_eq!(last.line, 7 + lines as u32);
        assert_eq!(last.preview, "Post::find(1)->save();");
        // Untyped receivers ($post, $x) are dynamic; Post::find(1)->save() is too (a call result).
        assert!(hits.iter().all(|h| h.dynamic));
        assert!(took < std::time::Duration::from_secs(2), "{took:?}");
        // `Post::find` is resolved through the file's imports.
        let finds = usages_in(&idx, "/p/app/Http/Many.php", &text, &Target::Member { class: "App\\Models\\Model".into(), name: "find".into(), member_kind: Some("method".into()) }, Some("App\\Models\\Model"));
        assert_eq!(finds.len(), lines / 3);
        assert!(finds.iter().all(|h| !h.dynamic), "Post::find is exact: Post extends Model");
    }

    #[test]
    fn kinds_for_the_files_of_some_folders() {
        let idx = idx3();
        let mut got = kinds_in(&idx, &["/p/app/Models".to_string()]);
        got.sort();
        assert_eq!(got, vec![("/p/app/Models/Model.php".to_string(), "class".to_string()), ("/p/app/Models/Post.php".to_string(), "class".to_string())]);
        assert!(kinds_in(&idx, &["/p/app".to_string()]).is_empty(), "only files directly in the folder");
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

    const USER_CTRL: &str = "<?php\nnamespace App\\Http\\Controllers;\n\nclass UserController\n{\n    public function save(): void {}\n    public function show(): void {}\n    private function secret(): void {}\n}\n";
    const SEARCH_USER: &str = "<?php\nnamespace App\\Models;\n\nclass User\n{\n    public function save(): bool { return true; }\n}\n\nfunction user_helper(): void {}\n";
    const VENDOR_UC: &str = "<?php\nnamespace Vendor;\n\nclass UnitConverter\n{\n}\n\nclass UserCache\n{\n}\n";

    fn search_index() -> ProjectIndex {
        project(&[("/p/app/Http/Controllers/UserController.php", USER_CTRL), ("/p/app/Models/User.php", SEARCH_USER), ("/p/vendor/acme/lib/src/Things.php", VENDOR_UC)])
    }

    fn names(hits: &[SearchHit]) -> Vec<String> {
        hits.iter().map(|h| h.name.clone()).collect()
    }

    #[test]
    fn search_ranks_humps_and_project_above_vendor() {
        let idx = search_index();
        let uc = names(&search(&idx, "UC", 10));
        assert_eq!(uc.first().map(String::as_str), Some("UserController"), "{uc:?}");
        // The vendor classes match too, below the project's.
        let at = |n: &str| uc.iter().position(|x| x == n).unwrap_or(usize::MAX);
        assert!(at("UserController") < at("UserCache") && at("UserController") < at("UnitConverter"), "{uc:?}");
        assert!(!uc.iter().any(|n| n.contains("secret")), "private methods aren't listed");
    }

    #[test]
    fn search_members_of_a_class_and_functions() {
        let idx = search_index();
        assert_eq!(names(&search(&idx, "User::save", 10)), vec!["User::save()", "UserController::save()"]);
        assert_eq!(names(&search(&idx, "UserController::sh", 10)), vec!["UserController::show()"]);
        assert!(names(&search(&idx, "user_hel", 10)).contains(&"user_helper()".to_string()));
        // Empty query: classes only, by name.
        assert_eq!(names(&search(&idx, "", 10)), vec!["User", "UserController", "UnitConverter", "UserCache"]);
        assert_eq!(search(&idx, "UC", 1).len(), 1, "the limit is applied");
    }

    #[test]
    fn search_table_follows_index_changes() {
        let mut idx = search_index();
        assert!(names(&search(&idx, "Order", 10)).is_empty());
        idx.set("/p/app/Models/Order.php".into(), CachedFile { mtime: 1, size: 1, symbols: scan("/p/app/Models/Order.php", b"<?php\nclass Order {}\n") });
        assert_eq!(names(&search(&idx, "Order", 10)), vec!["Order"]);
        idx.remove("/p/app/Models/Order.php");
        assert!(names(&search(&idx, "Order", 10)).is_empty());
    }
}

//! Mago, the Rust PHP toolchain, built into PHPBlitz.
//!
//! - **Lint** (`mago_check`): style and correctness rules for one file, straight from
//!   the editor's text. Needs no project scan, so it also works for unsaved buffers.
//! - **Analysis**: PHPStan-like type checking, in two phases:
//!   1. `mago_open` scans the project's declarations only (fast). From then on `mago_check`
//!      analyzes the files the user opens against them.
//!   2. `mago_analyze` analyzes every file in the background, without holding the engine, so
//!      open files keep being checked meanwhile. After it, edits re-analyze only what they affect.
//! - **No vendor/**: when composer.json has dependencies that are not installed, type analysis is
//!   mostly noise (every framework class is unknown, and so is everything typed with one: a
//!   1,150-file project showed 12,700 problems). Its problems are held back and counted until `composer
//!   install` has run; syntax errors and lint still show.
//! - **Formatting** (`mago_format`).
//!
//! Framework rules (Laravel, Symfony, PHPUnit, …) and the PHP version come from composer.json.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use mago_allocator::LocalArena;
use mago_analyzer::analysis_result::AnalysisResult;
use mago_analyzer::Analyzer;
use mago_codex::reference::SymbolReferences;
use mago_database::file::{File, FileId, FileType};
use mago_database::{Database, DatabaseReader};
use mago_linter::integration::{Integration, IntegrationSet};
use mago_orchestrator::service::format::FileFormatStatus;
use mago_orchestrator::service::incremental_analysis::IncrementalAnalysisService;
use mago_orchestrator::service::lint::LintMode;
use mago_orchestrator::{Orchestrator, OrchestratorConfiguration};
use mago_php_version::PHPVersion;
use mago_names::resolver::NameResolver;
use mago_reporting::{AnnotationKind, Issue, IssueCollection, Level};
use mago_semantics::SemanticsChecker;
use mago_syntax::parser::parse_file_with_settings;
use serde::Serialize;

/// PHP's built-in functions, classes and extensions, encoded by build.rs.
const PRELUDE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/prelude.bin"));

/// PHP's built-in declarations, decoded once; each analysis gets its own copy.
/// PHP's own classes and functions with their methods, as written (`SimpleXMLElement`,
/// `getPathname`, `realpath`): words the spell checker knows.
pub(crate) fn builtin_names() -> Vec<String> {
    let Ok(prelude) = prelude() else { return Vec::new() };
    let meta = &prelude.metadata;
    meta.class_likes
        .values()
        .map(|c| c.original_name.to_string())
        .chain(meta.function_likes.values().map(|f| f.original_name.to_string()))
        .collect()
}

fn prelude() -> Result<mago_prelude::Prelude, String> {
    static DECODED: OnceLock<Result<mago_prelude::Prelude, String>> = OnceLock::new();
    DECODED.get_or_init(|| mago_prelude::Prelude::decode(PRELUDE).map_err(|e| format!("Mago prelude: {e}"))).clone()
}

/// Composer packages that switch on Mago's framework-specific rules.
const INTEGRATIONS: &[(&str, Integration, &str)] = &[
    ("laravel/framework", Integration::Laravel, "Laravel"),
    ("symfony/framework-bundle", Integration::Symfony, "Symfony"),
    ("phpunit/phpunit", Integration::PHPUnit, "PHPUnit"),
    ("pestphp/pest", Integration::Pest, "Pest"),
    ("doctrine/orm", Integration::Doctrine, "Doctrine"),
    ("guzzlehttp/guzzle", Integration::Guzzle, "Guzzle"),
    ("monolog/monolog", Integration::Monolog, "Monolog"),
    ("nesbot/carbon", Integration::Carbon, "Carbon"),
    ("cakephp/cakephp", Integration::CakePHP, "CakePHP"),
    ("yiisoft/yii2", Integration::Yii, "Yii"),
    ("drupal/core", Integration::Drupal, "Drupal"),
    ("magento/framework", Integration::Magento, "Magento"),
];

/// Tells engines apart, so a background analysis never lands in a project opened after it started.
static GENERATION: AtomicU64 = AtomicU64::new(0);

struct Engine {
    /// Project root with forward slashes, as the UI sends paths.
    root: String,
    generation: u64,
    orchestrator: &'static Orchestrator<'static>,
    database: Database<'static>,
    /// Declarations only until the full analysis has run (`analyzed`), then everything.
    analysis: IncrementalAnalysisService,
    analyzed: bool,
    /// Files changed since the background analysis took its snapshot: re-analyzed when it lands.
    pending: Vec<FileId>,
    pending_deleted: bool,
    settings: mago_analyzer::settings::Settings,
    /// Analyzer checks turned off in mago.toml (`[analyzer] ignore`).
    analyzer_ignore: Vec<String>,
    /// Folders marked Excluded in the project tree (relative), kept for reloads.
    excludes: Vec<String>,
    /// Dependencies are declared in composer.json but vendor/ is missing.
    needs_install: bool,
    summary: ProjectSummary,
}

/// The engine is shared with blocking worker threads: Mago's work never runs on the main thread
/// (that freezes the window) or on the async runtime's few workers (that stalls file reads).
#[derive(Default)]
pub struct MagoState {
    engine: Arc<Mutex<Option<Engine>>>,
}

impl MagoState {
    /// Runs `f` with the engine on a blocking thread, its parallel work in the analysis pool.
    async fn with<T: Send + 'static>(&self, f: impl FnOnce(&mut Option<Engine>) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let engine = self.engine.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = engine.lock().map_err(|e| e.to_string())?;
            let slot: &mut Option<Engine> = &mut guard;
            analysis_pool().install(|| f(slot))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Mago runs its work in parallel on the current rayon pool. It gets most cores but not all: the
/// window, file reads and the language server stay responsive while a big project is analyzed.
pub(crate) fn analysis_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let threads = (cores / 2).max(cores.saturating_sub(2)).max(1);
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("mago-{i}"))
            // Mago's parser and analyzer recurse: deeply nested code needs more than the default
            // 2 MB (Mago's own CLI uses at least 8 MB). Reserved address space, not memory used.
            .stack_size(32 * 1024 * 1024)
            .build()
            .expect("analysis thread pool")
    })
}

/// Loads and analyzes a project in the analysis pool.
fn open_engine(root: &str, excludes: &[String]) -> Result<(Engine, ProjectSummary), String> {
    analysis_pool().install(|| Engine::open(root, excludes))
}

/// Project Errors, capped so a huge project doesn't send a giant message to the UI.
#[derive(Serialize)]
pub struct ProjectIssues {
    total: usize,
    /// Problems about unknown symbols hidden because vendor/ is missing.
    hidden: usize,
    /// False while only open files have been analyzed.
    analyzed: bool,
    files: Vec<FileIssues>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    /// 1-based line and UTF-16 column, the way Monaco counts.
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    severity: &'static str,
    code: String,
    message: String,
    help: Option<String>,
    /// "syntax", "lint" or "analysis"; also the category used in `@mago-expect lint:rule` comments.
    source: &'static str,
    /// Mago's automatic fixes for this problem, if any.
    fixes: Vec<Fix>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    title: String,
    /// "safe", "potentially-unsafe" or "unsafe".
    safety: &'static str,
    edits: Vec<FixEdit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixEdit {
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    files: usize,
    /// Problems in the whole project (0 until `analyzed`).
    issues: usize,
    /// Problems hidden because vendor/ is missing.
    hidden: usize,
    millis: u64,
    /// False after `mago_open` (declarations scanned), true after `mago_analyze`.
    analyzed: bool,
    php_version: String,
    integrations: Vec<String>,
    vendor: bool,
    /// composer.json declares dependencies but vendor/ is missing: `composer install` is needed.
    needs_install: bool,
    /// Path of mago.toml when the project has one.
    config_file: Option<String>,
    /// mago.toml could not be read; defaults were used.
    config_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIssues {
    path: String,
    diagnostics: Vec<Diagnostic>,
}

struct ProjectInfo {
    php: PHPVersion,
    integrations: IntegrationSet,
    names: Vec<String>,
    vendor: bool,
    needs_install: bool,
    /// Linter rule settings from mago.toml (`[linter.rules]`).
    rules: Option<mago_linter::settings::RulesSettings>,
    analyzer_ignore: Vec<String>,
    config_file: bool,
    config_error: Option<String>,
}

impl ProjectInfo {
    fn defaults() -> Self {
        ProjectInfo {
            php: PHPVersion::PHP84,
            integrations: IntegrationSet::empty(),
            names: Vec::new(),
            vendor: false,
            needs_install: false,
            rules: None,
            analyzer_ignore: Vec::new(),
            config_file: false,
            config_error: None,
        }
    }
}

/// Settings from composer.json, then mago.toml on top (the same file the `mago` CLI reads).
fn project_info(root: &Path) -> ProjectInfo {
    // Composer always writes vendor/autoload.php: an empty or half-written vendor/ (a failed
    // install) doesn't count as installed.
    let mut info = ProjectInfo { vendor: root.join("vendor/autoload.php").is_file(), ..ProjectInfo::defaults() };
    if let Some(json) = std::fs::read_to_string(root.join("composer.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        let packages: Vec<String> = ["require", "require-dev"]
            .iter()
            .filter_map(|k| json.get(*k).and_then(|v| v.as_object()))
            .flat_map(|o| o.keys().cloned())
            .collect();
        // Packages are "vendor/name"; `php` and `ext-*` are not installed by Composer.
        info.needs_install = !info.vendor && packages.iter().any(|p| p.contains('/'));
        for (package, integration, name) in INTEGRATIONS {
            if packages.iter().any(|p| p == package) {
                info.integrations.insert(*integration);
                info.names.push(name.to_string());
            }
        }
        // "^8.2" or ">=8.1 <8.4": the lowest version the project supports.
        if let Some(version) = json.pointer("/require/php").and_then(|v| v.as_str()).and_then(lowest_php_version) {
            info.php = version;
        }
    }
    apply_mago_toml(root, &mut info);
    info
}

fn apply_mago_toml(root: &Path, info: &mut ProjectInfo) {
    let Ok(text) = std::fs::read_to_string(root.join("mago.toml")) else { return };
    info.config_file = true;
    let value: toml::Value = match toml::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            info.config_error = Some(format!("mago.toml: {e}"));
            return;
        }
    };
    if let Some(version) = value.get("php-version").and_then(|v| v.as_str()) {
        match version.parse::<PHPVersion>() {
            Ok(v) => info.php = v,
            Err(_) => info.config_error = Some(format!("mago.toml: unknown php-version \"{version}\"")),
        }
    }
    if let Some(linter) = value.get("linter") {
        if let Some(rules) = linter.get("rules") {
            match rules.clone().try_into::<mago_linter::settings::RulesSettings>() {
                Ok(r) => info.rules = Some(r),
                Err(e) => info.config_error = Some(format!("mago.toml [linter.rules]: {e}")),
            }
        }
        if let Some(list) = linter.get("integrations").and_then(|v| v.as_array()) {
            info.integrations = IntegrationSet::empty();
            info.names.clear();
            for item in list {
                if let Ok(integration) = item.clone().try_into::<Integration>() {
                    info.integrations.insert(integration);
                    info.names.push(integration.to_string());
                }
            }
        }
    }
    // `ignore = ["code", { code = "other", in = [...] }]`: path-scoped entries are treated as global.
    if let Some(list) = value.get("analyzer").and_then(|a| a.get("ignore")).and_then(|v| v.as_array()) {
        info.analyzer_ignore = list
            .iter()
            .filter_map(|e| e.as_str().map(String::from).or_else(|| e.get("code").and_then(|c| c.as_str()).map(String::from)))
            .collect();
    }
}

fn lowest_php_version(constraint: &str) -> Option<PHPVersion> {
    let digits: String = constraint.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let mut parts = digits.split('.').filter_map(|p| p.parse::<u32>().ok());
    let major = parts.next()?;
    let minor = parts.next().unwrap_or(0);
    (major >= 7).then(|| PHPVersion::new(major, minor, 0))
}

fn configuration(root: &str, info: &ProjectInfo, excluded: &[String]) -> OrchestratorConfiguration<'static> {
    // The configuration lives as long as the leaked orchestrator that borrows it.
    // Generated code and caches (Laravel, Symfony), excluded.
    // Packages' data folders (locale tables) hold no declarations: not read at all.
    let mut excludes: Vec<&'static str> = vec!["node_modules", "storage", "bootstrap/cache", "var/cache", "var/log", ".blitz", crate::project::VENDOR_DATA_GLOB];
    excludes.extend(excluded.iter().filter(|e| !e.is_empty() && !e.contains("..")).map(|e| &*Box::leak(e.clone().into_boxed_str())));
    let mut linter_settings = mago_linter::settings::Settings { php_version: info.php, integrations: info.integrations, ..Default::default() };
    if let Some(rules) = &info.rules {
        linter_settings.rules = rules.clone();
    }
    OrchestratorConfiguration {
        php_version: info.php,
        paths: vec![root.to_string()],
        // Dependencies give the analyzer types, but are never checked themselves.
        includes: if info.vendor { vec![format!("{root}/vendor")] } else { vec![] },
        patches: vec![],
        excludes,
        extensions: vec!["php"],
        glob: Default::default(),
        parser_settings: Default::default(),
        analyzer_settings: analyzer_settings(info),
        linter_settings,
        guard_settings: Default::default(),
        formatter_settings: Default::default(),
        disable_default_analyzer_plugins: false,
        analyzer_plugins: vec![],
        use_progress_bars: false,
        use_colors: false,
    }
}

fn analyzer_settings(info: &ProjectInfo) -> mago_analyzer::settings::Settings {
    mago_analyzer::settings::Settings { version: info.php, ..Default::default() }
}

/// A process-wide orchestrator for files outside an opened project (sample project, formatting).
fn standalone() -> &'static Orchestrator<'static> {
    static ORCHESTRATOR: std::sync::OnceLock<&'static Orchestrator<'static>> = std::sync::OnceLock::new();
    ORCHESTRATOR.get_or_init(|| {
        Box::leak(Box::new(Orchestrator::new(configuration(".", &ProjectInfo::defaults(), &[]))))
    })
}

// ── Positions ─────────────────────────────────────────────────

/// 1-based line and UTF-16 column of a byte offset.
fn position(file: &File, offset: u32) -> (u32, u32) {
    let offset = offset.min(file.size);
    let line = file.line_number(offset);
    let start = file.get_line_start_offset(line).unwrap_or(0) as usize;
    let prefix = String::from_utf8_lossy(&file.contents[start..offset as usize]);
    (line + 1, prefix.encode_utf16().count() as u32 + 1)
}

fn to_diagnostics(file: &File, issues: &IssueCollection, source: &'static str, out: &mut Vec<Diagnostic>) {
    for issue in issues.iter() {
        if let Some(d) = to_diagnostic(file, issue, source) {
            out.push(d);
        }
    }
}

fn to_diagnostic(file: &File, issue: &Issue, source: &'static str) -> Option<Diagnostic> {
    let primary = issue.annotations.iter().find(|a| matches!(a.kind, AnnotationKind::Primary)).or(issue.annotations.first())?;
    let span = primary.span;
    if span.file_id != file.id {
        return None;
    }
    let (line, column) = position(file, span.start.offset);
    let (end_line, end_column) = position(file, span.end.offset.max(span.start.offset));
    let code = issue.code.clone().unwrap_or_default();
    // "mixed" findings are useful but noisy in untyped code: show them as weak warnings.
    let severity = match issue.level {
        Level::Error if code.starts_with("mixed-") => "info",
        Level::Error => "error",
        Level::Warning if code.starts_with("mixed-") => "info",
        Level::Warning => "warning",
        Level::Help | Level::Note => "info",
    };
    let is_syntax = issue.code.as_deref().is_none_or(|c| c == "parse");
    // Parse errors keep the useful part ("Unexpected token `}`…") in the annotation.
    let message = match (&primary.message, is_syntax) {
        (Some(detail), true) if !detail.is_empty() => format!("Syntax error: {detail}"),
        _ => issue.message.to_string(),
    };
    let help = issue.help.as_ref().map(|h| h.to_string());
    let fixes = issue
        .edits
        .get(&file.id)
        .filter(|edits| !edits.is_empty())
        .map(|edits| {
            let safety = edits.iter().map(|e| e.safety).max().unwrap_or_default();
            vec![Fix {
                title: match &help {
                    Some(h) => h.trim_end_matches('.').to_string(),
                    None => format!("Fix '{code}'"),
                },
                safety: match safety {
                    mago_text_edit::Safety::Safe => "safe",
                    mago_text_edit::Safety::PotentiallyUnsafe => "potentially-unsafe",
                    _ => "unsafe",
                },
                edits: edits
                    .iter()
                    .map(|e| {
                        let (line, column) = position(file, e.range.start);
                        let (end_line, end_column) = position(file, e.range.end.max(e.range.start));
                        FixEdit { line, column, end_line, end_column, text: String::from_utf8_lossy(&e.new_text).into_owned() }
                    })
                    .collect(),
            }]
        })
        .unwrap_or_default();
    Some(Diagnostic {
        line,
        column,
        end_line,
        end_column,
        severity,
        code,
        message,
        help,
        source: if is_syntax { "syntax" } else { source },
        fixes,
    })
}

fn relative<'a>(root: &str, path: &'a str) -> Option<&'a str> {
    path.strip_prefix(root)?.strip_prefix('/')
}

// ── Commands ──────────────────────────────────────────────────

/// Loads a project and scans its declarations (phase 1, fast). `mago_analyze` does the rest.
#[tauri::command]
pub async fn mago_open(state: tauri::State<'_, MagoState>, root: String, excludes: Option<Vec<String>>) -> Result<ProjectSummary, String> {
    let excludes = excludes.unwrap_or_default();
    let (engine, summary) = tauri::async_runtime::spawn_blocking(move || open_engine(&root, &excludes)).await.map_err(|e| e.to_string())??;
    state
        .with(move |slot| {
            drop(slot.replace(engine));
            Ok(())
        })
        .await?;
    Ok(summary)
}

/// Analyzes the whole project (phase 2) without holding the engine: open files keep being checked
/// meanwhile. Returns `None` when there was nothing to do or another project was opened meanwhile.
#[tauri::command]
pub async fn mago_analyze(state: tauri::State<'_, MagoState>) -> Result<Option<ProjectSummary>, String> {
    let snapshot = state
        .with(|slot| {
            Ok(slot.as_mut().filter(|e| !e.analyzed).map(|e| {
                e.pending.clear();
                e.pending_deleted = false;
                (e.generation, e.orchestrator, e.database.read_only())
            }))
        })
        .await?;
    let Some((generation, orchestrator, database)) = snapshot else { return Ok(None) };
    let started = Instant::now();
    let service = tauri::async_runtime::spawn_blocking(move || analysis_pool().install(|| Engine::analyze_all(orchestrator, database)))
        .await
        .map_err(|e| e.to_string())??;
    let millis = started.elapsed().as_millis() as u64;
    state
        .with(move |slot| match slot.as_mut().filter(|e| e.generation == generation && !e.analyzed) {
            Some(engine) => engine.finish(service, millis).map(Some),
            None => Ok(None),
        })
        .await
}

impl Engine {
    /// Phase 1: reads the project and scans its declarations (no function bodies).
    fn open(root: &str, excludes: &[String]) -> Result<(Engine, ProjectSummary), String> {
        let started = Instant::now();
        let root = root.trim_end_matches('/').to_string();
        // Mago's database borrows its configuration for its whole life: keep both for the app's life.
        // Each open (a project switch, a changed mago.toml) leaks these few small values; Mago's
        // lifetimes don't allow owning them in the engine yet.
        let root_static: &'static str = Box::leak(root.clone().into_boxed_str());
        let workspace: &'static Path = Path::new(root_static);
        let info = project_info(workspace);
        let orchestrator: &'static Orchestrator<'static> = Box::leak(Box::new(Orchestrator::new(configuration(root_static, &info, excludes))));
        let prelude = prelude()?;
        let database = orchestrator.load_database(workspace, true, Some(prelude.database), None).map_err(|e| e.to_string())?;
        let mut analysis = orchestrator.get_incremental_analysis_service(database.read_only(), prelude.metadata, prelude.symbol_references);
        analysis.set_scan_only(true);
        analysis.analyze_without_collecting().map_err(|e| e.to_string())?;
        let summary = ProjectSummary {
            files: database.read_only().files_with_type(FileType::Host).count(),
            issues: 0,
            hidden: 0,
            millis: started.elapsed().as_millis() as u64,
            analyzed: false,
            php_version: info.php.to_string(),
            integrations: info.names.clone(),
            vendor: info.vendor,
            needs_install: info.needs_install,
            config_file: info.config_file.then(|| format!("{root}/mago.toml")),
            config_error: info.config_error.clone(),
        };
        let engine = Engine {
            root,
            generation: GENERATION.fetch_add(1, Ordering::Relaxed) + 1,
            orchestrator,
            database,
            analysis,
            analyzed: false,
            pending: Vec::new(),
            pending_deleted: false,
            settings: analyzer_settings(&info),
            analyzer_ignore: info.analyzer_ignore,
            excludes: excludes.to_vec(),
            needs_install: info.needs_install,
            summary: summary.clone(),
        };
        Ok((engine, summary))
    }

    /// Phase 2, the slow part: a full analysis of a snapshot of the project.
    fn analyze_all(orchestrator: &'static Orchestrator<'static>, database: mago_database::ReadDatabase) -> Result<IncrementalAnalysisService, String> {
        let prelude = prelude()?;
        let mut service = orchestrator.get_incremental_analysis_service(database, prelude.metadata, prelude.symbol_references);
        service.analyze_without_collecting().map_err(|e| e.to_string())?;
        Ok(service)
    }

    /// Takes the full analysis, catching up with files changed while it ran.
    fn finish(&mut self, mut service: IncrementalAnalysisService, millis: u64) -> Result<ProjectSummary, String> {
        if !self.pending.is_empty() || self.pending_deleted {
            service.update_database(self.database.read_only());
            let hint = if self.pending_deleted { None } else { Some(self.pending.as_slice()) };
            service.analyze_incremental_without_collecting(hint).map_err(|e| e.to_string())?;
        }
        self.pending.clear();
        self.pending_deleted = false;
        self.analysis = service;
        self.analyzed = true;
        let issues = self.project_issues(0);
        self.summary.issues = issues.total;
        self.summary.hidden = issues.hidden;
        self.summary.millis += millis;
        self.summary.analyzed = true;
        Ok(self.summary.clone())
    }

    #[cfg(test)]
    fn open_analyzed(root: &str, excludes: &[String]) -> Result<(Engine, ProjectSummary), String> {
        let (mut engine, _) = Engine::open(root, excludes)?;
        let service = Engine::analyze_all(engine.orchestrator, engine.database.read_only())?;
        let summary = engine.finish(service, 0)?;
        Ok((engine, summary))
    }

    /// Drops analyzer findings turned off in mago.toml, and all of them while vendor/ is missing.
    fn keep(&self, d: &Diagnostic) -> bool {
        d.source != "analysis" || !(self.analyzer_ignore.contains(&d.code) || self.hidden(d))
    }

    /// Type analysis problems while vendor/ is missing.
    fn hidden(&self, d: &Diagnostic) -> bool {
        self.needs_install && d.source == "analysis"
    }

    /// Phase 1: analyzes one file against the declarations scanned so far.
    fn analyze_file(&self, file: &File) -> IssueCollection {
        let arena = LocalArena::new();
        let program = parse_file_with_settings(&arena, file, Default::default());
        let resolved = NameResolver::new(&arena).resolve(program);
        let mut issues = IssueCollection::new();
        for error in program.errors.iter() {
            issues.push(Issue::from(error));
        }
        issues.extend(SemanticsChecker::new(self.settings.version).check(file, program, &resolved));
        let registry = self.orchestrator.get_analyzer_plugin_registry();
        let mut result = AnalysisResult::new(SymbolReferences::new());
        let analyzer = Analyzer::new(&arena, file, &resolved, self.analysis.codebase(), &registry, self.settings.clone());
        if let Err(e) = analyzer.analyze(program, &mut result) {
            issues.push(Issue::error(format!("Analysis error: {e}")));
        }
        issues.extend(result.issues);
        issues
    }

    /// Lint + analysis of one project file's current text (incremental once the project is analyzed).
    fn check(&mut self, path: &str, content: String) -> Result<Vec<Diagnostic>, String> {
        let rel = relative(&self.root, path).ok_or("file is outside the project")?.to_string();
        let id = FileId::new(rel.as_bytes());
        let bytes = content.into_bytes();
        if self.database.read_only().get(&id).is_ok() {
            self.database.update(id, Cow::Owned(bytes));
        } else {
            self.database.add(File::new(Cow::Owned(rel.into_bytes()), FileType::Host, Some(std::path::PathBuf::from(path)), Cow::Owned(bytes)));
        }
        let file = self.database.read_only().get(&id).map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        let lint = self.orchestrator.get_lint_service(self.database.read_only());
        to_diagnostics(&file, &lint.lint_file(&file, LintMode::Full, None, false), "lint", &mut out);

        // Declarations first (cheap in phase 1), so the file sees its own edits.
        self.analysis.update_database(self.database.read_only());
        self.analysis.analyze_incremental_without_collecting(Some(&[id])).map_err(|e| e.to_string())?;
        if self.analyzed {
            if let Some(issues) = self.analysis.get_file_diagnostics(&id) {
                to_diagnostics(&file, issues, "analysis", &mut out);
            }
        } else {
            if !self.pending.contains(&id) {
                self.pending.push(id);
            }
            to_diagnostics(&file, &self.analyze_file(&file), "analysis", &mut out);
        }
        out.retain(|d| self.keep(d));
        out.sort_by_key(|d| (d.line, d.column));
        Ok(out)
    }

    /// Files changed or deleted on disk (git checkout, composer, another editor): updates them all,
    /// then runs one incremental analysis instead of one per file.
    fn sync(&mut self, changed: &[String], removed: &[String]) -> Result<(), String> {
        let mut touched = false;
        let mut deleted = false;
        for path in removed {
            let Some(rel) = relative(&self.root, path) else { continue };
            if self.database.delete(FileId::new(rel.as_bytes())) {
                touched = true;
                deleted = true;
            }
        }
        let mut ids = Vec::new();
        for path in changed {
            let Some(rel) = relative(&self.root, path) else { continue };
            let Ok(bytes) = std::fs::read(path) else { continue };
            let id = FileId::new(rel.as_bytes());
            match self.database.read_only().get(&id) {
                Ok(f) if f.contents.as_ref() == bytes.as_slice() => continue,
                Ok(_) => {
                    self.database.update(id, Cow::Owned(bytes));
                }
                Err(_) => {
                    self.database.add(File::new(Cow::Owned(rel.as_bytes().to_vec()), FileType::Host, Some(std::path::PathBuf::from(path)), Cow::Owned(bytes)));
                }
            }
            ids.push(id);
            touched = true;
        }
        if !touched {
            return Ok(());
        }
        if !self.analyzed {
            self.pending.extend_from_slice(&ids);
            self.pending_deleted |= deleted;
        }
        self.analysis.update_database(self.database.read_only());
        // A deleted file can't be hashed: then let Mago compare everything.
        let hint = if deleted { None } else { Some(ids.as_slice()) };
        self.analysis.analyze_incremental_without_collecting(hint).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The project's errors and warnings, at most `limit` of them (`total` and `hidden` count them
    /// all). Weak warnings (`info`) are only shown in open files.
    fn project_issues(&self, limit: usize) -> ProjectIssues {
        let mut result = ProjectIssues { total: 0, hidden: 0, analyzed: self.analyzed, files: Vec::new() };
        if !self.analyzed {
            return result;
        }
        let db = self.database.read_only();
        let mut sent = 0;
        for file in db.files_with_type(FileType::Host) {
            let Some(issues) = self.analysis.get_file_diagnostics(&file.id) else { continue };
            let mut diagnostics = Vec::new();
            to_diagnostics(&file, issues, "analysis", &mut diagnostics);
            result.hidden += diagnostics.iter().filter(|d| self.hidden(d)).count();
            diagnostics.retain(|d| d.severity != "info" && self.keep(d));
            if diagnostics.is_empty() {
                continue;
            }
            result.total += diagnostics.len();
            if sent >= limit {
                continue;
            }
            diagnostics.sort_by_key(|d| (d.line, d.column));
            diagnostics.truncate(limit - sent);
            sent += diagnostics.len();
            result.files.push(FileIssues { path: format!("{}/{}", self.root, String::from_utf8_lossy(&file.name)), diagnostics });
        }
        result.files.sort_by(|a, b| a.path.cmp(&b.path));
        result
    }
}

/// Lint only, for text outside an analyzed project (the sample project, unsaved files).
fn lint_standalone(path: &str, content: String) -> Vec<Diagnostic> {
    let name = path.rsplit('/').next().unwrap_or("file.php").to_string();
    let file = File::ephemeral(Cow::Owned(name.into_bytes()), Cow::Owned(content.into_bytes()));
    let issues = standalone().get_lint_service(mago_database::ReadDatabase::empty()).lint_file(&file, LintMode::Full, None, false);
    let mut out = Vec::new();
    to_diagnostics(&file, &issues, "lint", &mut out);
    out
}

#[tauri::command]
pub async fn mago_close(state: tauri::State<'_, MagoState>) -> Result<(), String> {
    // Dropping a big project's database takes a moment: not on the main thread.
    state
        .with(|slot| {
            drop(slot.take());
            Ok(())
        })
        .await
}

/// Checks one file's current text: lint always, plus incremental analysis when the
/// file belongs to the opened project.
#[tauri::command]
pub async fn mago_check(state: tauri::State<'_, MagoState>, path: String, content: String) -> Result<Vec<Diagnostic>, String> {
    state
        .with(move |slot| match slot.as_mut().filter(|e| relative(&e.root, &path).is_some()) {
            // A project with its own mago.toml: its levels, as the mago CLI applies them.
            Some(engine) if engine.summary.config_file.is_some() => engine.check(&path, content),
            Some(engine) => engine.check(&path, content).map(apply_levels),
            None => Ok(apply_levels(lint_standalone(&path, content))),
        })
        .await
}

// ── Lint levels from PHPBlitz's settings (projects without mago.toml) ───────
//
// Mago's defaults are tuned for CI, where a design hint ("too many methods") failing the build is
// a choice. In the editor that reads as an error on code that works, so PHPBlitz's settings can
// change a rule's level by category (Maintainability → weak warning by default) or one by one.

#[derive(Default, serde::Deserialize)]
pub struct Levels {
    /// Category ("maintainability", "security"…) → "error", "warning", "weak" or "off".
    #[serde(default)]
    categories: HashMap<String, String>,
    /// Rule code ("sensitive-parameter") → the same; wins over its category.
    #[serde(default)]
    rules: HashMap<String, String>,
}

static LEVELS: std::sync::LazyLock<std::sync::RwLock<Levels>> = std::sync::LazyLock::new(Default::default);

/// Every lint rule's category, by code.
static CATEGORIES: std::sync::LazyLock<HashMap<&'static str, &'static str>> = std::sync::LazyLock::new(|| {
    let settings = mago_linter::settings::Settings { integrations: IntegrationSet::all(), ..Default::default() };
    mago_linter::registry::RuleRegistry::build(&settings, None, true).rules().iter().map(|r| (r.meta().code, category_key(r.meta().category))).collect()
});

fn category_key(c: mago_linter::category::Category) -> &'static str {
    use mago_linter::category::Category::*;
    match c {
        Clarity => "clarity",
        BestPractices => "best-practices",
        Consistency => "consistency",
        Deprecation => "deprecation",
        Maintainability => "maintainability",
        Redundancy => "redundancy",
        Security => "security",
        Safety => "safety",
        Correctness => "correctness",
    }
}

fn apply_levels(mut out: Vec<Diagnostic>) -> Vec<Diagnostic> {
    let levels = LEVELS.read().unwrap();
    if levels.categories.is_empty() && levels.rules.is_empty() {
        return out;
    }
    out.retain_mut(|d| {
        if d.source != "lint" {
            return true;
        }
        let level = levels.rules.get(&d.code).or_else(|| CATEGORIES.get(d.code.as_str()).and_then(|c| levels.categories.get(*c)));
        match level.map(String::as_str) {
            Some("off") => false,
            Some("error") => (d.severity = "error", true).1,
            Some("warning") => (d.severity = "warning", true).1,
            Some("weak") => (d.severity = "info", true).1,
            _ => true,
        }
    });
    out
}

/// PHPBlitz's lint levels (Settings ▸ PHP ▸ Mago), for projects without a mago.toml.
#[tauri::command]
pub async fn mago_set_levels(levels: Levels) -> Result<(), String> {
    *LEVELS.write().unwrap() = levels;
    Ok(())
}

#[derive(Serialize)]
pub struct RuleInfo {
    code: &'static str,
    name: &'static str,
    category: &'static str,
    description: &'static str,
}

/// Mago's lint rules, for the settings page.
#[tauri::command]
pub async fn mago_rules() -> Result<Vec<RuleInfo>, String> {
    let settings = mago_linter::settings::Settings { integrations: IntegrationSet::all(), ..Default::default() };
    let mut rules: Vec<RuleInfo> = mago_linter::registry::RuleRegistry::build(&settings, None, true)
        .rules()
        .iter()
        .map(|r| {
            let m = r.meta();
            RuleInfo { code: m.code, name: m.name, category: category_key(m.category), description: m.description }
        })
        .collect();
    rules.sort_by_key(|r| r.code);
    Ok(rules)
}

/// Project files changed or deleted on disk: reads the changed ones, drops the deleted ones, and
/// re-checks what depends on them, in one analysis.
#[tauri::command]
pub async fn mago_sync(state: tauri::State<'_, MagoState>, changed: Vec<String>, removed: Vec<String>) -> Result<(), String> {
    state
        .with(move |slot| match slot.as_mut() {
            Some(engine) => engine.sync(&changed, &removed),
            None => Ok(()),
        })
        .await
}

/// Analysis results across the project, for the Problems ▸ Project Errors view (at most `limit`).
#[tauri::command]
pub async fn mago_project_issues(state: tauri::State<'_, MagoState>, limit: Option<usize>) -> Result<ProjectIssues, String> {
    let limit = limit.unwrap_or(5000);
    state.with(move |slot| Ok(slot.as_ref().map(|e| e.project_issues(limit)).unwrap_or(ProjectIssues { total: 0, hidden: 0, analyzed: false, files: Vec::new() }))).await
}

/// Turns a rule off in the project's mago.toml, then reloads the project with it.
#[tauri::command]
pub async fn mago_disable_rule(state: tauri::State<'_, MagoState>, category: String, code: String) -> Result<ProjectSummary, String> {
    let (root, excludes) = state.with(|slot| slot.as_ref().map(|e| (e.root.clone(), e.excludes.clone())).ok_or_else(|| "No project is open in Mago".to_string())).await?;
    disable_rule(Path::new(&root), &category, &code)?;
    let (engine, summary) = tauri::async_runtime::spawn_blocking(move || open_engine(&root, &excludes)).await.map_err(|e| e.to_string())??;
    state
        .with(move |slot| {
            drop(slot.replace(engine));
            Ok(())
        })
        .await?;
    Ok(summary)
}

/// Returns the path of the project's mago.toml, creating one like `mago init` would when missing.
#[tauri::command]
pub async fn mago_ensure_config(state: tauri::State<'_, MagoState>) -> Result<String, String> {
    state
        .with(|slot| {
            let root = slot.as_ref().map(|e| e.root.clone()).ok_or("No project is open in Mago")?;
            ensure_config(Path::new(&root))?;
            Ok(format!("{root}/mago.toml"))
        })
        .await
}

/// Writes `[linter.rules] code = { enabled = false }` or adds the code to `[analyzer] ignore`,
/// keeping the rest of the file (comments, order) as it was.
fn disable_rule(root: &Path, category: &str, code: &str) -> Result<(), String> {
    if code.is_empty() || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid rule name: {code}"));
    }
    ensure_config(root)?;
    let path = root.join("mago.toml");
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut doc = text.parse::<toml_edit::DocumentMut>().map_err(|e| format!("mago.toml: {e}"))?;
    match category {
        "lint" => {
            let mut off = toml_edit::InlineTable::new();
            off.insert("enabled", false.into());
            let linter = doc.entry("linter").or_insert(toml_edit::table()).as_table_mut().ok_or("[linter] is not a table")?;
            let rules = linter.entry("rules").or_insert(toml_edit::table()).as_table_mut().ok_or("[linter.rules] is not a table")?;
            rules.insert(code, toml_edit::value(off));
        }
        "analysis" => {
            let analyzer = doc.entry("analyzer").or_insert(toml_edit::table()).as_table_mut().ok_or("[analyzer] is not a table")?;
            let ignore = analyzer.entry("ignore").or_insert(toml_edit::value(toml_edit::Array::new())).as_array_mut().ok_or("[analyzer] ignore is not a list")?;
            if !ignore.iter().any(|v| v.as_str() == Some(code)) {
                ignore.push(code);
            }
        }
        other => return Err(format!("Rules of kind '{other}' can't be disabled")),
    }
    std::fs::write(&path, doc.to_string()).map_err(|e| e.to_string())
}

/// Creates mago.toml from composer.json the way `mago init` does, so the `mago` CLI works too.
fn ensure_config(root: &Path) -> Result<(), String> {
    let path = root.join("mago.toml");
    if path.exists() {
        return Ok(());
    }
    let info = project_info(root);
    let mut paths: Vec<String> = Vec::new();
    if let Some(json) = std::fs::read_to_string(root.join("composer.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        for key in ["/autoload/psr-4", "/autoload-dev/psr-4"] {
            for dirs in json.pointer(key).and_then(|v| v.as_object()).into_iter().flat_map(|o| o.values()) {
                let list = dirs.as_array().cloned().unwrap_or_else(|| vec![dirs.clone()]);
                for dir in list.iter().filter_map(|d| d.as_str()) {
                    let dir = dir.trim_end_matches('/').to_string();
                    if !dir.is_empty() && !paths.contains(&dir) {
                        paths.push(dir);
                    }
                }
            }
        }
    }
    if paths.is_empty() {
        paths = ["src", "app", "tests"].iter().filter(|d| root.join(d).is_dir()).map(|d| d.to_string()).collect();
    }
    let quote = |items: &[String]| items.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(", ");
    let integrations: Vec<String> = info.names.iter().map(|n| n.to_lowercase()).collect();
    let php = format!("{}.{}", info.php.major(), info.php.minor());
    let text = format!(
        "# Mago configuration, read by PHPBlitz and by the `mago` command line tool.\n\
         # Reference: https://mago.carthage.software/\n\n\
         php-version = \"{php}\"\n\n\
         [source]\n\
         paths = [{paths}]\n\
         includes = [\"vendor\"]\n\n\
         [linter]\n\
         integrations = [{integrations}]\n\n\
         [linter.rules]\n\
         # rule-name = {{ enabled = false }}\n\n\
         [analyzer]\n\
         ignore = []\n",
        paths = quote(&paths),
        integrations = quote(&integrations),
    );
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Formats PHP source. Returns None when it is already formatted.
#[tauri::command]
pub async fn mago_format(state: tauri::State<'_, MagoState>, content: String) -> Result<Option<String>, String> {
    let orchestrator = state.with(|slot| Ok(slot.as_ref().map(|e| e.orchestrator).unwrap_or_else(standalone))).await?;
    // Formatting a big file takes a moment: on a blocking thread, not an async worker.
    let status = tauri::async_runtime::spawn_blocking(move || {
        let file = File::ephemeral(Cow::Borrowed(b"format.php"), Cow::Owned(content.into_bytes()));
        orchestrator.format_file(&file).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    match status {
        FileFormatStatus::Unchanged => Ok(None),
        FileFormatStatus::Changed(bytes) => String::from_utf8(bytes).map(Some).map_err(|e| e.to_string()),
        FileFormatStatus::FailedToParse(e) => Err(format!("Can't format: the file has a syntax error ({e})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn settings_change_lint_levels() {
        assert_eq!(CATEGORIES.get("too-many-methods"), Some(&"maintainability"));
        assert_eq!(CATEGORIES.get("sensitive-parameter"), Some(&"security"));
        let d = |code: &str, severity: &'static str, source: &'static str| Diagnostic {
            line: 1, column: 1, end_line: 1, end_column: 2, severity, code: code.into(), message: String::new(), help: None, source, fixes: Vec::new(),
        };
        *LEVELS.write().unwrap() = Levels {
            categories: [("maintainability".to_string(), "weak".to_string())].into(),
            rules: [("sensitive-parameter".to_string(), "off".to_string()), ("cyclomatic-complexity".to_string(), "warning".to_string())].into(),
        };
        let out = apply_levels(vec![
            d("too-many-methods", "error", "lint"),
            d("cyclomatic-complexity", "error", "lint"),
            d("sensitive-parameter", "error", "lint"),
            d("too-many-methods", "error", "analysis"),
        ]);
        *LEVELS.write().unwrap() = Levels::default();
        let got: Vec<_> = out.iter().map(|d| (d.code.as_str(), d.severity, d.source)).collect();
        // Category, then the rule's own level (it wins); "off" removes it; analysis isn't touched.
        assert_eq!(got, [("too-many-methods", "info", "lint"), ("cyclomatic-complexity", "warning", "lint"), ("too-many-methods", "error", "analysis")]);
    }

    #[test]
    fn reads_php_version_from_constraints() {
        assert_eq!(lowest_php_version("^8.2").map(|v| v.to_string()), Some("8.2.0".into()));
        assert_eq!(lowest_php_version(">=8.1 <8.4").map(|v| v.to_string()), Some("8.1.0".into()));
        assert_eq!(lowest_php_version("8.3.*").map(|v| v.to_string()), Some("8.3.0".into()));
        assert!(lowest_php_version("*").is_none());
    }

    #[test]
    fn columns_count_utf16_units() {
        let file = File::ephemeral(Cow::Borrowed(b"t.php"), Cow::Borrowed("<?php\n$é = 1; $x;\n".as_bytes()));
        let offset = "<?php\n$é = 1; ".len() as u32; // byte offset of `$x`
        assert_eq!(position(&file, offset), (2, 9));
    }

    #[test]
    fn lints_a_file_from_memory() {
        let out = lint_standalone("C:/x/t.php", "<?php\nfunction f() { return 1 }\n".into());
        assert!(
            out.iter().any(|d| d.severity == "error" && d.line == 2 && d.source == "syntax"),
            "expected a syntax error on line 2, got {:?}",
            out.iter().map(|d| (d.line, d.severity, d.source, &d.code, &d.message)).collect::<Vec<_>>()
        );
    }

    /// A small Laravel-like project on disk: open, check an edit incrementally, list project issues.
    #[test]
    fn analyzes_a_project_incrementally() {
        let dir = std::env::temp_dir().join(format!("phpblitz-mago-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("app")).unwrap();
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        std::fs::write(dir.join("vendor/autoload.php"), "<?php
").unwrap();
        std::fs::write(dir.join("composer.json"), r#"{"require":{"php":"^8.2","laravel/framework":"^11.0"},"require-dev":{"phpunit/phpunit":"^11"}}"#).unwrap();
        std::fs::write(
            dir.join("app/Greeter.php"),
            "<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class Greeter\n{\n    public function greet(string $name): string\n    {\n        return 'Hello ' . $name;\n    }\n}\n",
        )
        .unwrap();
        let caller = "<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class Caller\n{\n    public function run(Greeter $g): string\n    {\n        return $g->greet('x');\n    }\n}\n";
        std::fs::write(dir.join("app/Caller.php"), caller).unwrap();
        let root = crate::fs::norm(&dir);

        let (mut engine, summary) = Engine::open_analyzed(&root, &[]).expect("open project");
        assert_eq!(summary.files, 2);
        assert_eq!(summary.php_version, "8.2.0");
        assert_eq!(summary.integrations, vec!["Laravel", "PHPUnit"]);
        assert!(engine.project_issues(usize::MAX).files.iter().all(|f| f.diagnostics.iter().all(|d| d.severity != "error")), "clean project has no errors");

        // Typing: call a method that doesn't exist, and pass an int where a string is expected.
        let path = format!("{root}/app/Caller.php");
        let broken = caller.replace("$g->greet('x')", "$g->great(42)");
        let found = engine.check(&path, broken).expect("check");
        let missing = found.iter().find(|d| d.source == "analysis" && d.severity == "error").expect("analysis error for great()");
        assert_eq!(missing.line, 11);
        assert_eq!(missing.column, 20, "points at `great`: {}", missing.message);

        // Fixing it clears the error again (incremental update of the same file).
        let fixed = engine.check(&path, caller.to_string()).expect("check");
        assert!(fixed.iter().all(|d| d.severity != "error"), "{:?}", fixed.iter().map(|d| &d.message).collect::<Vec<_>>());

        // Changing the callee's signature surfaces an error in the caller (cross-file).
        let greeter = format!("{root}/app/Greeter.php");
        let int_only = std::fs::read_to_string(dir.join("app/Greeter.php")).unwrap().replace("string $name", "int $name");
        engine.check(&greeter, int_only).expect("check greeter");
        let caller_now = engine.check(&path, caller.to_string()).expect("check caller");
        assert!(caller_now.iter().any(|d| d.source == "analysis" && d.line == 11), "caller sees the new signature");

        // Deleting the callee (e.g. `git checkout` removed it): the caller now references a missing class.
        engine.sync(&[], std::slice::from_ref(&greeter)).expect("remove");
        let orphan = engine.project_issues(usize::MAX).files.into_iter().find(|f| f.path.ends_with("Caller.php")).expect("caller has issues");
        assert!(orphan.diagnostics.iter().any(|d| d.message.contains("Greeter")), "{:?}", orphan.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>());

        // The cap: at most `limit` problems are sent, with the real total.
        let capped = engine.project_issues(1);
        assert_eq!(capped.files.iter().map(|f| f.diagnostics.len()).sum::<usize>(), 1);
        assert!(capped.total >= 1);

        // It comes back on disk (checking out the branch again): one sync reads it and the caller is fine.
        engine.sync(std::slice::from_ref(&greeter), &[]).expect("sync");
        let back = engine.project_issues(usize::MAX).files.into_iter().find(|f| f.path.ends_with("Caller.php"));
        assert!(back.is_none_or(|f| f.diagnostics.iter().all(|d| !d.message.contains("Greeter"))), "caller sees Greeter again");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_project(name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("phpblitz-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (rel, text) in files {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    /// Phase 1 checks open files right away; edits made while phase 2 runs are caught up when it
    /// lands. Without vendor/, type analysis is held back and counted; lint still shows.
    #[test]
    fn checks_open_files_before_the_full_analysis() {
        let caller = r#"<?php

declare(strict_types=1);

namespace App;

use Symfony\Component\HttpFoundation\Response;

final class Caller
{
    public function run(Greeter $g): Response
    {
        $a = $b = $g->great();
        return new Response($a . $b);
    }
}
"#;
        let dir = temp_project(
            "mago-phases",
            &[
                ("composer.json", r#"{"require":{"php":"^8.2","ext-json":"*","symfony/framework-bundle":"^7.0"}}"#),
                ("app/Greeter.php", "<?php

namespace App;

final class Greeter
{
    public function greet(): string
    {
        return 'hi';
    }
}
"),
                ("app/Caller.php", caller),
            ],
        );
        let root = crate::fs::norm(&dir);
        let path = format!("{root}/app/Caller.php");
        let analysis = |found: &[Diagnostic]| found.iter().filter(|d| d.source == "analysis").map(|d| (d.line, d.code.clone())).collect::<Vec<_>>();

        // No vendor/: lint shows, type analysis is held back.
        let (mut engine, summary) = Engine::open(&root, &[]).unwrap();
        assert!(summary.needs_install, "symfony is required but vendor/ is missing");
        let found = engine.check(&path, caller.into()).unwrap();
        assert!(found.iter().any(|d| d.code == "no-multi-assignments"), "lint still runs");
        assert!(analysis(&found).is_empty(), "{:?}", analysis(&found));
        let service = Engine::analyze_all(engine.orchestrator, engine.database.read_only()).unwrap();
        let summary = engine.finish(service, 0).unwrap();
        assert_eq!(summary.issues, 0);
        assert!(summary.hidden >= 1, "held-back problems are counted");

        // An empty vendor/ (a failed install) still counts as not installed.
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        assert!(Engine::open(&root, &[]).unwrap().1.needs_install, "vendor/ without autoload.php");

        // Installed (vendor/autoload.php): phase 1 analyzes the open file against the scanned declarations.
        std::fs::write(dir.join("vendor/autoload.php"), "<?php
").unwrap();
        let (mut engine, summary) = Engine::open(&root, &[]).unwrap();
        assert!(!summary.analyzed && !summary.needs_install);
        assert!(!engine.project_issues(100).analyzed);
        let found = engine.check(&path, caller.into()).unwrap();
        assert!(analysis(&found).iter().any(|(line, code)| *line == 13 && code == "non-existent-method"), "great() is missing: {:?}", analysis(&found));

        // Phase 2 snapshots the project; the user fixes the call meanwhile.
        let snapshot = engine.database.read_only();
        engine.pending.clear();
        engine.check(&path, caller.replace("great", "greet")).unwrap();
        let service = Engine::analyze_all(engine.orchestrator, snapshot).unwrap();
        let summary = engine.finish(service, 0).unwrap();
        assert!(summary.analyzed);
        let issues = engine.project_issues(usize::MAX);
        let all = issues.files.iter().flat_map(|f| f.diagnostics.iter().map(|d| (d.line, d.code.clone()))).collect::<Vec<_>>();
        assert!(!all.iter().any(|(_, code)| code == "non-existent-method"), "the edit made during phase 2 counts: {all:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `PHPBLITZ_MAGO_BENCH=<project root> cargo test --release mago_bench -- --nocapture`
    #[test]
    fn mago_bench() {
        let Ok(root) = std::env::var("PHPBLITZ_MAGO_BENCH") else { return };
        // Working set of this process, in MB (Windows; for the benchmark only).
        let mem = || {
            let out = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &format!("(Get-Process -Id {}).WorkingSet64", std::process::id())]).output().ok()?;
            String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok().map(|b| b / 1_048_576)
        };
        eprintln!("memory before: {:?} MB", mem());
        if std::env::var("PHPBLITZ_MAGO_STEPS").is_ok() {
            let prelude = mago_prelude::Prelude::decode(PRELUDE).unwrap();
            eprintln!("  step: prelude decoded: {:?} MB ({} KB encoded)", mem(), PRELUDE.len() / 1024);
            let root_static: &'static str = Box::leak(root.clone().into_boxed_str());
            let info = project_info(Path::new(root_static));
            let orchestrator: &'static Orchestrator<'static> = Box::leak(Box::new(Orchestrator::new(configuration(root_static, &info, &[]))));
            let database = orchestrator.load_database(Path::new(root_static), true, Some(prelude.database), None).unwrap();
            let bytes: usize = database.read_only().files().map(|f| f.contents.len()).sum();
            eprintln!("  step: database loaded: {:?} MB ({} files, {} MB of source)", mem(), database.read_only().files().count(), bytes / 1_048_576);
            let mut analysis = orchestrator.get_incremental_analysis_service(database.read_only(), prelude.metadata, prelude.symbol_references);
            analysis.set_scan_only(true);
            analysis.analyze_without_collecting().unwrap();
            eprintln!("  step: declarations scanned: {:?} MB", mem());
            return;
        }
        let (mut engine, scanned) = Engine::open(&root, &[]).unwrap();
        eprintln!("memory after phase 1: {:?} MB", mem());
        eprintln!("phase 1 (declarations): {} files in {} ms, needs_install={}", scanned.files, scanned.millis, scanned.needs_install);
        let started = Instant::now();
        let service = Engine::analyze_all(engine.orchestrator, engine.database.read_only()).unwrap();
        let summary = engine.finish(service, 0).unwrap();
        eprintln!("memory after phase 2: {:?} MB", mem());
        eprintln!("phase 2 (everything): {} ms, {} problems shown, {} hidden", started.elapsed().as_millis(), summary.issues, summary.hidden);
        let mut by_code = std::collections::BTreeMap::<String, usize>::new();
        for f in engine.project_issues(usize::MAX).files {
            for d in f.diagnostics {
                *by_code.entry(format!("{} {}", d.severity, d.code)).or_default() += 1;
            }
        }
        let mut top: Vec<_> = by_code.into_iter().collect();
        top.sort_by_key(|a| std::cmp::Reverse(a.1));
        for (code, n) in top.iter().take(15) {
            eprintln!("  {n:>6}  {code}");
        }
        if let Ok(code) = std::env::var("PHPBLITZ_MAGO_SAMPLE") {
            for f in engine.project_issues(usize::MAX).files {
                for d in f.diagnostics.iter().filter(|d| d.code == code).take(2) {
                    eprintln!("  {}:{} {}", f.path, d.line, d.message);
                }
            }
        }
    }

    #[test]
    fn skips_excluded_folders() {
        let dir = temp_project(
            "mago-excludes",
            &[("app/Mine.php", "<?php\n\nnamespace App;\n\nfinal class Mine {}\n"), ("plugins/big/Theirs.php", "<?php\n\nfinal class Theirs {}\n"), ("plugins/big/More.php", "<?php\n\nfinal class More {}\n")],
        );
        let root = crate::fs::norm(&dir);
        let (_, all) = Engine::open_analyzed(&root, &[]).unwrap();
        let (_, mine) = Engine::open_analyzed(&root, &["plugins".to_string()]).unwrap();
        assert_eq!(all.files, 3);
        assert_eq!(mine.files, 1, "plugins/ is excluded");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shows_fixes_from_mago() {
        // Discovery: which issues in typical code come with an automatic fix.
        let src = "<?php\n\nnamespace App;\n\nclass A\n{\n    public function f($x)\n    {\n        if ($x == true) { return array(1, 2); }\n        $a = $b = 0;\n        return null;\n    }\n}\n";
        let out = lint_standalone("C:/p/A.php", src.into());
        for d in &out {
            eprintln!("{}:{} [{}] {} fixes={}", d.line, d.column, d.code, d.message, d.fixes.iter().map(|f| format!("{} ({}, {} edits)", f.title, f.safety, f.edits.len())).collect::<Vec<_>>().join("; "));
        }
        assert!(out.iter().any(|d| !d.fixes.is_empty()), "expected at least one fixable issue");
    }

    #[test]
    fn suppression_comments_and_mago_toml() {
        let caller = "<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class Caller\n{\n    public function run(): int\n    {\n        $a = $b = 1;\n        return $a + $b;\n    }\n}\n";
        let dir = temp_project(
            "config",
            &[
                ("composer.json", r#"{"require":{"php":"^8.3","laravel/framework":"^11"},"autoload":{"psr-4":{"App\\":"app/"}},"autoload-dev":{"psr-4":{"Tests\\":"tests/"}}}"#),
                ("vendor/autoload.php", "<?php
"),
                ("app/Caller.php", caller),
                ("app/Missing.php", "<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class Missing\n{\n    public function run(Caller $c): void\n    {\n        $c->nope();\n    }\n}\n"),
            ],
        );
        let root = crate::fs::norm(&dir);
        let caller_path = format!("{root}/app/Caller.php");
        let missing_path = format!("{root}/app/Missing.php");
        let (mut engine, _) = Engine::open_analyzed(&root, &[]).unwrap();

        // 1. The lint warning shows, and a comment above the line hides it.
        let before = engine.check(&caller_path, caller.into()).unwrap();
        assert!(before.iter().any(|d| d.code == "no-multi-assignments"), "{:?}", before.iter().map(|d| &d.code).collect::<Vec<_>>());
        let suppressed = caller.replace("        $a = $b = 1;", "        // @mago-expect lint:no-multi-assignments\n        $a = $b = 1;");
        let after = engine.check(&caller_path, suppressed).unwrap();
        assert!(after.iter().all(|d| d.code != "no-multi-assignments"), "comment suppresses the rule: {:?}", after.iter().map(|d| (&d.code, &d.message)).collect::<Vec<_>>());

        // 2. The analyzer error shows, and a comment hides it too.
        let missing = engine.check(&missing_path, std::fs::read_to_string(dir.join("app/Missing.php")).unwrap()).unwrap();
        let analysis_code = missing.iter().find(|d| d.source == "analysis" && d.severity == "error").expect("analysis error for nope()").code.clone();
        let commented = std::fs::read_to_string(dir.join("app/Missing.php"))
            .unwrap()
            .replace("        $c->nope();", &format!("        // @mago-expect analysis:{analysis_code}\n        $c->nope();"));
        let hidden = engine.check(&missing_path, commented).unwrap();
        assert!(hidden.iter().all(|d| d.code != analysis_code), "analysis comment suppresses: {:?}", hidden.iter().map(|d| (&d.code, &d.message)).collect::<Vec<_>>());

        // 3. Disabling both in mago.toml (created like `mago init`) and reloading.
        disable_rule(&dir, "lint", "no-multi-assignments").unwrap();
        disable_rule(&dir, "analysis", &analysis_code).unwrap();
        disable_rule(&dir, "analysis", &analysis_code).unwrap(); // idempotent
        let toml_text = std::fs::read_to_string(dir.join("mago.toml")).unwrap();
        assert!(toml_text.contains("php-version = \"8.3\""), "{toml_text}");
        assert!(toml_text.contains("paths = [\"app\", \"tests\"]"), "{toml_text}");
        assert!(toml_text.contains("integrations = [\"laravel\"]"), "{toml_text}");
        assert!(toml_text.contains("no-multi-assignments = { enabled = false }"), "{toml_text}");
        assert_eq!(toml_text.matches(&format!("\"{analysis_code}\"")).count(), 1, "{toml_text}");
        assert!(toml_text.contains("# rule-name = { enabled = false }"), "comments are kept: {toml_text}");

        let (mut engine, summary) = Engine::open_analyzed(&root, &[]).unwrap();
        assert!(summary.config_error.is_none(), "{:?}", summary.config_error);
        assert_eq!(summary.integrations, vec!["Laravel"]);
        let caller_now = engine.check(&caller_path, caller.into()).unwrap();
        assert!(caller_now.iter().all(|d| d.code != "no-multi-assignments"), "rule disabled in mago.toml");
        let missing_now = engine.check(&missing_path, std::fs::read_to_string(dir.join("app/Missing.php")).unwrap()).unwrap();
        assert!(missing_now.iter().all(|d| d.code != analysis_code), "analyzer check ignored via mago.toml");
        assert!(engine.project_issues(usize::MAX).files.iter().flat_map(|f| &f.diagnostics).all(|d| d.code != analysis_code));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn formats_code() {
        let file = File::ephemeral(Cow::Borrowed(b"x.php"), Cow::Borrowed(b"<?php\nfunction  f( $a,$b ){return $a+$b ;}\n"));
        match standalone().format_file(&file).expect("format") {
            FileFormatStatus::Changed(bytes) => assert!(String::from_utf8(bytes).unwrap().contains("function f($a, $b)")),
            other => panic!("expected a change, got {other:?}"),
        }
    }
}

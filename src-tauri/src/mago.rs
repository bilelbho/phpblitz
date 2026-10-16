//! Mago, the Rust PHP toolchain, built into PHPBlitz.
//!
//! - **Lint** (`mago_check`): style and correctness rules for one file, straight from
//!   the editor's text. Needs no project scan, so it also works for unsaved buffers.
//! - **Analysis** (`mago_open`, `mago_check`): PHPStan-like type checking over the whole
//!   project, kept up to date incrementally: an edit re-analyzes only what it affects.
//! - **Formatting** (`mago_format`).
//!
//! Framework rules (Laravel, Symfony, PHPUnit, …) and the PHP version come from composer.json.

use std::borrow::Cow;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use mago_database::file::{File, FileId, FileType};
use mago_database::{Database, DatabaseReader};
use mago_linter::integration::{Integration, IntegrationSet};
use mago_orchestrator::service::format::FileFormatStatus;
use mago_orchestrator::service::incremental_analysis::IncrementalAnalysisService;
use mago_orchestrator::service::lint::LintMode;
use mago_orchestrator::{Orchestrator, OrchestratorConfiguration};
use mago_php_version::PHPVersion;
use mago_reporting::{AnnotationKind, Issue, IssueCollection, Level};
use serde::Serialize;

/// PHP's built-in functions, classes and extensions, encoded by build.rs.
const PRELUDE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/prelude.bin"));

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

struct Engine {
    /// Project root with forward slashes, as the UI sends paths.
    root: String,
    orchestrator: &'static Orchestrator<'static>,
    database: Database<'static>,
    analysis: IncrementalAnalysisService,
    /// Analyzer checks turned off in mago.toml (`[analyzer] ignore`).
    analyzer_ignore: Vec<String>,
    /// Folders marked Excluded in the project tree (relative), kept for reloads.
    excludes: Vec<String>,
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

/// Mago runs its work in parallel on the current rayon pool. Like IntelliJ's indexing, it gets
/// most cores but not all: the window, file reads and the language server stay responsive while a
/// big project is analyzed.
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    files: usize,
    issues: usize,
    millis: u64,
    php_version: String,
    integrations: Vec<String>,
    vendor: bool,
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
            rules: None,
            analyzer_ignore: Vec::new(),
            config_file: false,
            config_error: None,
        }
    }
}

/// Settings from composer.json, then mago.toml on top (the same file the `mago` CLI reads).
fn project_info(root: &Path) -> ProjectInfo {
    let mut info = ProjectInfo { vendor: root.join("vendor").is_dir(), ..ProjectInfo::defaults() };
    if let Some(json) = std::fs::read_to_string(root.join("composer.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        let packages: Vec<String> = ["require", "require-dev"]
            .iter()
            .filter_map(|k| json.get(*k).and_then(|v| v.as_object()))
            .flat_map(|o| o.keys().cloned())
            .collect();
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
    let mut excludes: Vec<&'static str> = vec!["node_modules", "storage", "bootstrap/cache"];
    excludes.extend(excluded.iter().filter(|e| !e.is_empty() && !e.contains("..")).map(|e| &*Box::leak(e.clone().into_boxed_str())));
    let mut linter_settings = mago_linter::settings::Settings::default();
    linter_settings.php_version = info.php;
    linter_settings.integrations = info.integrations;
    if let Some(rules) = &info.rules {
        linter_settings.rules = rules.clone();
    }
    let mut analyzer_settings = mago_analyzer::settings::Settings::default();
    analyzer_settings.version = info.php;
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
        analyzer_settings,
        linter_settings,
        guard_settings: Default::default(),
        formatter_settings: Default::default(),
        disable_default_analyzer_plugins: false,
        analyzer_plugins: vec![],
        use_progress_bars: false,
        use_colors: false,
    }
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

/// Loads a project and analyzes it fully. Later `mago_check` calls are incremental.
#[tauri::command]
pub async fn mago_open(state: tauri::State<'_, MagoState>, root: String, excludes: Option<Vec<String>>) -> Result<ProjectSummary, String> {
    let excludes = excludes.unwrap_or_default();
    let (engine, summary) = tauri::async_runtime::spawn_blocking(move || open_engine(&root, &excludes)).await.map_err(|e| e.to_string())??;
    state.with(move |slot| Ok(drop(slot.replace(engine)))).await?;
    Ok(summary)
}

impl Engine {
    fn open(root: &str, excludes: &[String]) -> Result<(Engine, ProjectSummary), String> {
        let started = Instant::now();
        let root = root.trim_end_matches('/').to_string();
        // Mago's database borrows its configuration for its whole life: keep both for the app's life.
        let root_static: &'static str = Box::leak(root.clone().into_boxed_str());
        let workspace: &'static Path = Path::new(root_static);
        let info = project_info(workspace);
        let orchestrator: &'static Orchestrator<'static> = Box::leak(Box::new(Orchestrator::new(configuration(root_static, &info, excludes))));
        let prelude = mago_prelude::Prelude::decode(PRELUDE).map_err(|e| format!("Mago prelude: {e}"))?;
        let database = orchestrator.load_database(workspace, true, Some(prelude.database), None).map_err(|e| e.to_string())?;
        let mut analysis = orchestrator.get_incremental_analysis_service(database.read_only(), prelude.metadata, prelude.symbol_references);
        let result = analysis.analyze().map_err(|e| e.to_string())?;
        let ignored = |code: &Option<String>| code.as_ref().is_some_and(|c| info.analyzer_ignore.contains(c));
        let summary = ProjectSummary {
            files: database.read_only().files_with_type(FileType::Host).count(),
            issues: result.issues.iter().filter(|i| !ignored(&i.code)).count(),
            millis: started.elapsed().as_millis() as u64,
            php_version: info.php.to_string(),
            integrations: info.names.clone(),
            vendor: info.vendor,
            config_file: info.config_file.then(|| format!("{root}/mago.toml")),
            config_error: info.config_error.clone(),
        };
        Ok((Engine { root, orchestrator, database, analysis, analyzer_ignore: info.analyzer_ignore, excludes: excludes.to_vec() }, summary))
    }

    /// Drops analyzer findings turned off in mago.toml.
    fn keep(&self, d: &Diagnostic) -> bool {
        d.source != "analysis" || !self.analyzer_ignore.contains(&d.code)
    }

    /// Lint + incremental analysis of one project file's current text.
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

        self.analysis.update_database(self.database.read_only());
        self.analysis.analyze_incremental(Some(&[id])).map_err(|e| e.to_string())?;
        if let Some(issues) = self.analysis.get_file_diagnostics(&id) {
            to_diagnostics(&file, issues, "analysis", &mut out);
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
        self.analysis.update_database(self.database.read_only());
        // A deleted file can't be hashed: then let Mago compare everything.
        let hint = if deleted { None } else { Some(ids.as_slice()) };
        self.analysis.analyze_incremental(hint).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn project_issues(&self, limit: usize) -> ProjectIssues {
        let db = self.database.read_only();
        let mut out = Vec::new();
        let mut total = 0;
        let mut sent = 0;
        for file in db.files_with_type(FileType::Host) {
            let Some(issues) = self.analysis.get_file_diagnostics(&file.id) else { continue };
            let mut diagnostics = Vec::new();
            to_diagnostics(&file, issues, "analysis", &mut diagnostics);
            diagnostics.retain(|d| self.keep(d));
            if diagnostics.is_empty() {
                continue;
            }
            total += diagnostics.len();
            if sent >= limit {
                continue;
            }
            diagnostics.sort_by_key(|d| (d.line, d.column));
            diagnostics.truncate(limit - sent);
            sent += diagnostics.len();
            out.push(FileIssues { path: format!("{}/{}", self.root, String::from_utf8_lossy(&file.name)), diagnostics });
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        ProjectIssues { total, files: out }
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
    state.with(|slot| Ok(drop(slot.take()))).await
}

/// Checks one file's current text: lint always, plus incremental analysis when the
/// file belongs to the opened project.
#[tauri::command]
pub async fn mago_check(state: tauri::State<'_, MagoState>, path: String, content: String) -> Result<Vec<Diagnostic>, String> {
    state
        .with(move |slot| match slot.as_mut().filter(|e| relative(&e.root, &path).is_some()) {
            Some(engine) => engine.check(&path, content),
            None => Ok(lint_standalone(&path, content)),
        })
        .await
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
    state.with(move |slot| Ok(slot.as_ref().map(|e| e.project_issues(limit)).unwrap_or(ProjectIssues { total: 0, files: Vec::new() }))).await
}

/// Turns a rule off in the project's mago.toml, then reloads the project with it.
#[tauri::command]
pub async fn mago_disable_rule(state: tauri::State<'_, MagoState>, category: String, code: String) -> Result<ProjectSummary, String> {
    let (root, excludes) = state.with(|slot| slot.as_ref().map(|e| (e.root.clone(), e.excludes.clone())).ok_or_else(|| "No project is open in Mago".to_string())).await?;
    disable_rule(Path::new(&root), &category, &code)?;
    let (engine, summary) = tauri::async_runtime::spawn_blocking(move || open_engine(&root, &excludes)).await.map_err(|e| e.to_string())??;
    state.with(move |slot| Ok(drop(slot.replace(engine)))).await?;
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
        php = format!("{}.{}", info.php.major(), info.php.minor()),
        paths = quote(&paths),
        integrations = quote(&integrations),
    );
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Formats PHP source. Returns None when it is already formatted.
#[tauri::command]
pub async fn mago_format(state: tauri::State<'_, MagoState>, content: String) -> Result<Option<String>, String> {
    let orchestrator = state.with(|slot| Ok(slot.as_ref().map(|e| e.orchestrator).unwrap_or_else(standalone))).await?;
    let file = File::ephemeral(Cow::Borrowed(b"format.php"), Cow::Owned(content.into_bytes()));
    match orchestrator.format_file(&file).map_err(|e| e.to_string())? {
        FileFormatStatus::Unchanged => Ok(None),
        FileFormatStatus::Changed(bytes) => String::from_utf8(bytes).map(Some).map_err(|e| e.to_string()),
        FileFormatStatus::FailedToParse(e) => Err(format!("Can't format: the file has a syntax error ({e})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        std::fs::write(dir.join("composer.json"), r#"{"require":{"php":"^8.2","laravel/framework":"^11.0"},"require-dev":{"phpunit/phpunit":"^11"}}"#).unwrap();
        std::fs::write(
            dir.join("app/Greeter.php"),
            "<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class Greeter\n{\n    public function greet(string $name): string\n    {\n        return 'Hello ' . $name;\n    }\n}\n",
        )
        .unwrap();
        let caller = "<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class Caller\n{\n    public function run(Greeter $g): string\n    {\n        return $g->greet('x');\n    }\n}\n";
        std::fs::write(dir.join("app/Caller.php"), caller).unwrap();
        let root = crate::fs::norm(&dir);

        let (mut engine, summary) = Engine::open(&root, &[]).expect("open project");
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
        engine.sync(&[], &[greeter.clone()]).expect("remove");
        let orphan = engine.project_issues(usize::MAX).files.into_iter().find(|f| f.path.ends_with("Caller.php")).expect("caller has issues");
        assert!(orphan.diagnostics.iter().any(|d| d.message.contains("Greeter")), "{:?}", orphan.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>());

        // The cap: at most `limit` problems are sent, with the real total.
        let capped = engine.project_issues(1);
        assert_eq!(capped.files.iter().map(|f| f.diagnostics.len()).sum::<usize>(), 1);
        assert!(capped.total >= 1);

        // It comes back on disk (checking out the branch again): one sync reads it and the caller is fine.
        engine.sync(&[greeter.clone()], &[]).expect("sync");
        let back = engine.project_issues(usize::MAX).files.into_iter().find(|f| f.path.ends_with("Caller.php"));
        assert!(back.map_or(true, |f| f.diagnostics.iter().all(|d| !d.message.contains("Greeter"))), "caller sees Greeter again");

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

    #[test]
    fn skips_excluded_folders() {
        let dir = temp_project(
            "mago-excludes",
            &[("app/Mine.php", "<?php\n\nnamespace App;\n\nfinal class Mine {}\n"), ("plugins/big/Theirs.php", "<?php\n\nfinal class Theirs {}\n"), ("plugins/big/More.php", "<?php\n\nfinal class More {}\n")],
        );
        let root = crate::fs::norm(&dir);
        let (_, all) = Engine::open(&root, &[]).unwrap();
        let (_, mine) = Engine::open(&root, &["plugins".to_string()]).unwrap();
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
                ("app/Caller.php", caller),
                ("app/Missing.php", "<?php\n\ndeclare(strict_types=1);\n\nnamespace App;\n\nfinal class Missing\n{\n    public function run(Caller $c): void\n    {\n        $c->nope();\n    }\n}\n"),
            ],
        );
        let root = crate::fs::norm(&dir);
        let caller_path = format!("{root}/app/Caller.php");
        let missing_path = format!("{root}/app/Missing.php");
        let (mut engine, _) = Engine::open(&root, &[]).unwrap();

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

        let (mut engine, summary) = Engine::open(&root, &[]).unwrap();
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

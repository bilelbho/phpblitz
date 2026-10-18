//! JavaScript and TypeScript projects inside the PHP project (a Laravel `resources/js`, a Vue or
//! React front end, a Node tool…). The editor's TypeScript service runs in a web worker and can't
//! read the disk, so this module hands it the files it needs to understand a project:
//! - `js_read_sources`: the project's own .js/.ts/.jsx/.tsx files.
//! - `js_type_files`: the type definitions (.d.ts) of the packages in `package.json`, from
//!   `node_modules`, and of the packages those definitions use, with their `package.json` files
//!   (TypeScript reads `types` and `exports` from them).
//!
//! Both have size limits, so a huge `node_modules` can't flood the editor.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use crate::fs::norm;

/// A source file larger than this is generated or minified: not worth analyzing.
const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
const MAX_TYPE_FILE_BYTES: u64 = 3 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 2_000;
const MAX_PACKAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 40 * 1024 * 1024;
/// How many folders up to look for `node_modules` (workspaces hoist packages to the top).
const MAX_PARENTS: usize = 4;
/// Ships its own copy of the standard library types, which the editor already has.
const SKIPPED_PACKAGES: [&str; 2] = ["typescript", "@types/typescript"];

#[derive(Serialize)]
pub struct JsFile {
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsTypes {
    files: Vec<JsFile>,
    /// Packages listed in `package.json` but not installed (`npm install` hasn't run).
    missing: Vec<String>,
    /// Whether any `node_modules` folder was found.
    has_node_modules: bool,
    /// The size limit was reached: some packages' types were left out.
    truncated: bool,
}

#[tauri::command]
pub async fn js_read_sources(paths: Vec<String>) -> Result<Vec<JsFile>, String> {
    tauri::async_runtime::spawn_blocking(move || read_sources(&paths)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn js_type_files(root: String) -> Result<JsTypes, String> {
    tauri::async_runtime::spawn_blocking(move || type_files(Path::new(&root))).await.map_err(|e| e.to_string())
}

fn read_sources(paths: &[String]) -> Vec<JsFile> {
    paths
        .par_iter()
        .filter_map(|path| {
            if fs::metadata(path).ok()?.len() > MAX_SOURCE_BYTES {
                return None;
            }
            let content = String::from_utf8(fs::read(path).ok()?).ok()?;
            (!is_minified(&content)).then(|| JsFile { path: path.clone(), content })
        })
        .collect()
}

/// Bundler output: a few very long lines.
fn is_minified(text: &str) -> bool {
    text.len() > 20_000 && text.lines().take(20).any(|l| l.len() > 5_000)
}

/// Dependency names from a `package.json` (all kinds when `all`, else what a package needs at
/// run time: its dependencies and peer dependencies).
fn dependencies(manifest: &serde_json::Value, all: bool) -> Vec<String> {
    let kinds: &[&str] = if all {
        &["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    } else {
        &["dependencies", "peerDependencies"]
    };
    let mut out = Vec::new();
    for kind in kinds {
        if let Some(map) = manifest.get(kind).and_then(|v| v.as_object()) {
            out.extend(map.keys().cloned());
        }
    }
    out
}

/// `@types/node` for `node`, `@types/babel__core` for `@babel/core`.
fn types_package(name: &str) -> Option<String> {
    if name.starts_with("@types/") {
        return None;
    }
    Some(format!("@types/{}", name.trim_start_matches('@').replace('/', "__")))
}

fn node_modules_dirs(root: &Path) -> Vec<PathBuf> {
    root.ancestors().take(MAX_PARENTS + 1).map(|dir| dir.join("node_modules")).filter(|d| d.is_dir()).collect()
}

fn type_files(root: &Path) -> JsTypes {
    let mut result = JsTypes { files: Vec::new(), missing: Vec::new(), has_node_modules: false, truncated: false };
    let Some(manifest) = fs::read_to_string(root.join("package.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else {
        return result;
    };
    let modules = node_modules_dirs(root);
    result.has_node_modules = !modules.is_empty();

    let mut queue: VecDeque<(String, bool)> = dependencies(&manifest, true).into_iter().map(|n| (n, true)).collect();
    let mut seen = HashSet::new();
    let mut total = 0usize;
    while let Some((name, direct)) = queue.pop_front() {
        if !seen.insert(name.clone()) || SKIPPED_PACKAGES.contains(&name.as_str()) {
            continue;
        }
        // The DefinitelyTyped package goes right after the package itself.
        if let Some(types) = types_package(&name) {
            queue.push_front((types, false));
        }
        let Some(dir) = modules.iter().map(|m| m.join(&name)).find(|d| d.join("package.json").is_file()) else {
            if direct && !name.starts_with("@types/") {
                result.missing.push(name);
            }
            continue;
        };
        if total >= MAX_TOTAL_BYTES {
            result.truncated = true;
            continue;
        }
        let Ok(manifest_text) = fs::read_to_string(dir.join("package.json")) else { continue };
        let files = declarations(&dir);
        let size: usize = files.iter().map(|f| f.content.len()).sum();
        if total + size > MAX_TOTAL_BYTES {
            result.truncated = true;
            continue;
        }
        total += size + manifest_text.len();
        let has_types = !files.is_empty();
        result.files.push(JsFile { path: norm(&dir.join("package.json")), content: manifest_text.clone() });
        result.files.extend(files);
        // What the definitions import comes from the package's own dependencies.
        if has_types {
            if let Ok(m) = serde_json::from_str::<serde_json::Value>(&manifest_text) {
                queue.extend(dependencies(&m, false).into_iter().map(|n| (n, false)));
            }
        }
    }
    result
}

fn is_declaration(name: &str) -> bool {
    name.ends_with(".d.ts") || name.ends_with(".d.mts") || name.ends_with(".d.cts")
}

/// The package's .d.ts files (not those of packages nested in its own node_modules).
fn declarations(dir: &Path) -> Vec<JsFile> {
    let mut paths = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            if kind.is_dir() {
                if name != "node_modules" && !name.starts_with('.') {
                    stack.push(entry.path());
                }
            } else if is_declaration(&name) && entry.metadata().is_ok_and(|m| m.len() <= MAX_TYPE_FILE_BYTES) {
                paths.push(entry.path());
                if paths.len() >= MAX_PACKAGE_FILES {
                    stack.clear();
                    break;
                }
            }
        }
    }
    let mut size = 0usize;
    let mut out = Vec::new();
    for path in paths {
        let Ok(content) = fs::read_to_string(&path) else { continue };
        size += content.len();
        if size > MAX_PACKAGE_BYTES {
            break;
        }
        out.push(JsFile { path: norm(&path), content });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn collects_package_types_and_what_they_use() {
        let tmp = std::env::temp_dir().join(format!("phpblitz-js-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        write(&tmp, "package.json", r#"{"dependencies":{"react":"^18","left-pad":"1"},"devDependencies":{"vite":"5","typescript":"5"}}"#);
        write(&tmp, "node_modules/react/package.json", r#"{"name":"react"}"#);
        write(&tmp, "node_modules/react/index.js", "module.exports = {}");
        write(&tmp, "node_modules/@types/react/package.json", r#"{"dependencies":{"csstype":"3"}}"#);
        write(&tmp, "node_modules/@types/react/index.d.ts", "export {}");
        write(&tmp, "node_modules/csstype/package.json", "{}");
        write(&tmp, "node_modules/csstype/index.d.ts", "export {}");
        write(&tmp, "node_modules/vite/package.json", "{}");
        write(&tmp, "node_modules/vite/client.d.ts", "");
        write(&tmp, "node_modules/vite/node_modules/esbuild/main.d.ts", "");
        write(&tmp, "node_modules/typescript/package.json", "{}");
        write(&tmp, "node_modules/typescript/lib/lib.d.ts", "");

        let found = type_files(&tmp);
        let rel: HashSet<String> = found.files.iter().map(|f| f.path.trim_start_matches(&norm(&tmp)).to_string()).collect();
        for want in [
            "/node_modules/react/package.json",
            "/node_modules/@types/react/index.d.ts",
            "/node_modules/csstype/index.d.ts",
            "/node_modules/vite/client.d.ts",
        ] {
            assert!(rel.contains(want), "{want} in {rel:?}");
        }
        assert!(!rel.iter().any(|p| p.contains("esbuild") || p.contains("typescript")), "{rel:?}");
        assert_eq!(found.missing, vec!["left-pad".to_string()]);
        assert!(found.has_node_modules);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn skips_minified_sources() {
        assert!(is_minified(&"x".repeat(30_000)));
        assert!(!is_minified(&"let a = 1;\n".repeat(3_000)));
    }
}

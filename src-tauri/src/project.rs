// Which folders of a project each feature skips, in one place. The lists differ on purpose: vendor/
// is indexed (classes and types of the dependencies) but left out of Go to File and Find in Files,
// and Symfony's var/ (cache, logs) is never worth indexing. Folders the user marked Excluded are
// skipped by all of them.

use std::collections::HashSet;

/// Version control and tool state: nothing looks inside.
pub const TOOL_DIRS: &[&str] = &[".git", ".svn", ".hg", ".idea", ".blitz"];

/// Installed packages, caches and build output.
pub const GENERATED_DIRS: &[&str] = &["node_modules", "storage", "target", "dist", ".cache"];

/// Composer's dependencies.
pub const DEPENDENCY_DIR: &str = "vendor";

/// Data folders inside packages (`vendor/symfony/intl/Resources/data`: locale tables as PHP arrays).
/// No classes or functions, yet about half of a Symfony app's vendor source: the index and Mago
/// skip them.
pub const VENDOR_DATA_GLOB: &str = "**/vendor/**/Resources/data/**";

/// Whether a folder is a package's data folder (see [`VENDOR_DATA_GLOB`]); `path` with `/`.
pub fn is_vendor_data(path: &str) -> bool {
    path.ends_with("/Resources/data") && path.contains("/vendor/")
}

/// The file watcher: folders it never watches, at any depth (huge, or tool state).
pub const NEVER_WATCHED: &[&str] = &["node_modules", ".cache", ".git", ".svn", ".hg", ".idea", ".blitz"];

/// The file watcher: top-level folders whose changes are never reported (generated output).
pub const UNREPORTED: &[&str] = &["node_modules", "storage", "target", "dist", ".cache", ".idea", ".blitz"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Purpose {
    /// The file list (Go to File, the JS projects).
    Files,
    /// Find in Files (which also follows .gitignore).
    Search,
    /// The symbol index: the project's PHP and its dependencies.
    Index,
}

/// Whether a folder with this name is skipped for `purpose`.
pub fn skips(name: &str, purpose: Purpose) -> bool {
    if TOOL_DIRS.contains(&name) || GENERATED_DIRS.contains(&name) {
        return true;
    }
    match purpose {
        Purpose::Files | Purpose::Search => name == DEPENDENCY_DIR,
        Purpose::Index => name == "var",
    }
}

/// Folders marked Excluded, as absolute paths (forward slashes).
#[derive(Default)]
pub struct Excluded(HashSet<String>);

impl Excluded {
    /// From paths relative to the project (as the UI keeps them) or absolute ones.
    pub fn new(root: &str, folders: &[String]) -> Self {
        let root = root.trim_end_matches('/');
        Excluded(
            folders
                .iter()
                .map(|f| f.replace('\\', "/"))
                .map(|f| f.trim_end_matches('/').to_string())
                .filter(|f| !f.is_empty() && !f.contains(".."))
                .map(|f| if f.starts_with('/') || f.as_bytes().get(1) == Some(&b':') { f } else { format!("{root}/{}", f.trim_start_matches('/')) })
                .map(|f| f.to_lowercase())
                .collect(),
        )
    }

    /// `path`: absolute, forward slashes. Case doesn't matter (Windows and macOS file systems).
    pub fn contains(&self, path: &str) -> bool {
        !self.0.is_empty() && self.0.contains(&path.trim_end_matches('/').to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn package_data_folders_are_skipped() {
        assert!(is_vendor_data("C:/p/vendor/symfony/intl/Resources/data"));
        // The project's own data, and vendor code folders, are not.
        assert!(!is_vendor_data("C:/p/src/Resources/data"));
        assert!(!is_vendor_data("C:/p/vendor/symfony/intl/Resources"));
        assert!(!is_vendor_data("C:/p/vendor/acme/lib/src/Data"));
    }

    #[test]
    fn purposes_differ_only_where_they_should() {
        for name in [".git", ".idea", ".blitz", "node_modules", "storage", "dist"] {
            assert!(skips(name, Purpose::Files) && skips(name, Purpose::Search) && skips(name, Purpose::Index), "{name}");
        }
        assert!(skips("vendor", Purpose::Files) && skips("vendor", Purpose::Search));
        assert!(!skips("vendor", Purpose::Index), "dependencies are indexed");
        assert!(skips("var", Purpose::Index) && !skips("var", Purpose::Files));
        assert!(!skips("app", Purpose::Index) && !skips("src", Purpose::Search));
    }

    #[test]
    fn the_watcher_skips_what_the_rest_skips() {
        for name in TOOL_DIRS {
            assert!(NEVER_WATCHED.contains(name) || UNREPORTED.contains(name), "{name}");
        }
        for name in GENERATED_DIRS {
            assert!(UNREPORTED.contains(name), "{name}");
        }
        assert!(!NEVER_WATCHED.contains(&DEPENDENCY_DIR) && !UNREPORTED.contains(&DEPENDENCY_DIR), "composer updates must reach the index");
    }

    #[test]
    fn excluded_folders_relative_or_absolute() {
        let ex = Excluded::new("C:/work/shop", &["public/build".into(), "C:/work/shop/legacy/".into(), "../escape".into(), "".into()]);
        assert!(ex.contains("C:/work/shop/public/build"));
        assert!(ex.contains("c:/WORK/shop/legacy"));
        assert!(!ex.contains("C:/work/shop/public"));
        assert!(!ex.contains("C:/work/escape"));
        assert!(!Excluded::default().contains("C:/work/shop"));
    }
}

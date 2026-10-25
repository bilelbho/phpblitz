//! Restricted Mode: a project opened without being trusted runs no programs. The UI marks its root
//! when it opens it that way; every command that starts a program in a folder (Git, PHP, Composer,
//! test runs, language servers) asks [`check`] first. The terminal is not limited: it runs only what
//! the user types.

use std::sync::Mutex;

static RESTRICTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The refusal the UI shows (and recognizes by its start).
pub const REFUSED: &str = "Restricted Mode: PHPBlitz doesn't run programs in this project until you trust it.";

/// Forward slashes, no trailing slash, and on Windows one case: paths compare as the OS does.
fn key(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_end_matches('/');
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

fn inside(dir: &str, root: &str) -> bool {
    dir == root || dir.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

/// Marks a project root restricted (opened in Restricted Mode) or not (trusted, or closed).
#[tauri::command]
pub fn trust_restrict(root: String, restricted: bool) {
    let root = key(&root);
    let mut list = RESTRICTED.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|r| *r != root);
    if restricted {
        list.push(root);
    }
}

/// Refuses a program that would run in a restricted project (its folder or one inside it).
pub fn check(cwd: &str) -> Result<(), String> {
    let dir = key(cwd);
    let list = RESTRICTED.lock().unwrap_or_else(|e| e.into_inner());
    if list.iter().any(|root| inside(&dir, root)) {
        Err(REFUSED.into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_a_project_and_its_folders_only() {
        trust_restrict("C:\\work\\shop\\".into(), true);
        assert!(check("C:/work/shop").is_err());
        assert!(check("C:/work/shop/vendor/bin").is_err());
        assert!(check("C:/work/shop-admin").is_ok());
        assert!(check("C:/work").is_ok());
        if cfg!(windows) {
            assert!(check("c:/Work/Shop").is_err());
        }
        trust_restrict("C:/work/shop".into(), false);
        assert!(check("C:/work/shop").is_ok());
    }
}

//! Spell checking for code: the words inside names (camelCase, snake_case), comments and strings,
//! checked against an English dictionary (Hunspell en_US from SCOWL, in dictionaries/), the usual
//! words of programming and the project's own dictionary (.blitz/project.json, set by the UI).
//!
//! Left alone, to keep the noise down: words shorter than 4 letters, all-caps words (acronyms),
//! words without a vowel (abbreviations: `cnt`, `btn`), and anything with non-ASCII letters.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, PoisonError, RwLock};

use spellbook::Dictionary;

const AFF: &str = include_str!("../dictionaries/en_US.aff");
const DIC: &str = include_str!("../dictionaries/en_US.dic");
const MIN_LEN: usize = 4;

/// Words of programming that aren't English (or are, but not in the dictionary).
const CODE_WORDS: &str = "
    php namespace namespaces foreach elseif endif endforeach endwhile endfor endswitch isset unset stdclass
    bool boolean int integer float args argv argc param params config configs auth admin http https html
    json yaml mysql pgsql sqlite utf ascii async await enum enums impl init func lang util utils repo repos
    dirs temp tmp src libs env dev prod apps ctx req res errs msgs vals vars nums uuid uuids guid ulid
    oauth smtp cron regex regexp middleware middlewares laravel symfony eloquent artisan blade livewire
    inertia vite webpack composer phpunit pest mockery faker carbon guzzle psr dto dtos crud orm dbal
    doctrine twig jquery vue typescript javascript nodejs github gitlab docker redis nginx apache localhost
    hostname hostnames username usernames timestamp timestamps datetime datetimes timezone timezones
    webhook webhooks todo todos fixme readonly nullable iterable callable stringable countable traversable
    jsonable arrayable htmlable metadata plugin plugins builtin dropdown dropdowns checkbox checkboxes
    frontend backend login logout signup sidebar navbar tooltip tooltips popup popups mutex enqueue dequeue
    upsert upserts lookup lookups sublist subquery subqueries subdomain subdomains authed authenticatable
    authorizable notifiable fillable guarded casts hasher hashable mailable mailables queueable dispatchable
    uncached prepend prepends prepended polyfill polyfills kebab slug slugs rehash utc gmt iso rfc mime
    png jpg jpeg gif svg webp pdf csv xlsx zip yml ini toml npm pnpm yarn bun deno cli api apis url urls
    uri uris sql xml css dom ajax http2 ttl uuid4 phpdoc phpstan psalm mago rector pint xdebug opcache
    fpm cgi sapi pdo mysqli mbstring iconv intl bcmath gmp curl openssl sodium redis memcached apcu
    stdin stdout stderr eof bom lf crlf tabs str strlen strtolower strtoupper ucfirst lcfirst sprintf
    printf implode explode preg substr strpos stripos trim rtrim ltrim nullsafe instanceof clone
    fn typeof keyof readonly abstract static async yield interface interfaces trait traits closure closures
    getter getters setter setters serializer deserializer serializable unserialize iterator iterators
    accessor accessors mutator mutators enqueued dequeued param initializer initializers
    middleware validator validators sanitizer sanitizers formatter formatters linter linters
    tokenizer tokenizers lexer lexers parser parsers codegen workspace workspaces monorepo
    namespaced unicode wildcard wildcards rollback rollbacks changelog changelogs refactor refactors
    refactoring dataset datasets substring substrings whitelist blacklist allowlist denylist
    unprocessable unauthorized unauthenticated csrf xss cors cookie cookies favicon viewport
    const goto insteadof enddeclare declare require include once endswitch elseif finally namespace
    schemas gmail expr
    href src srcset alt autofocus autocomplete autoplay nowrap maxlength minlength readonly novalidate
    colspan rowspan tabindex onclick onchange onsubmit enctype formaction textarea iframe noopener
    noreferrer nofollow viewbox stylesheet charset doctype tbody thead tfoot
    ";

struct Speller {
    dict: Dictionary,
    code: HashSet<String>,
    /// The project's own words (lowercase).
    project: HashSet<String>,
}

static SPELLER: LazyLock<RwLock<Speller>> = LazyLock::new(|| {
    let dict = Dictionary::new(AFF, DIC).expect("the bundled en_US dictionary parses");
    RwLock::new(Speller { dict, code: CODE_WORDS.split_whitespace().map(str::to_string).collect(), project: HashSet::new() })
});
/// Words already looked up (lowercase → known), so a file's repeated words cost once.
static CACHE: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

impl Speller {
    fn known(&self, word: &str) -> bool {
        let lower = word.to_ascii_lowercase();
        if let Some(&k) = CACHE.lock().unwrap().get(&lower) {
            return k;
        }
        let known = self.code.contains(&lower)
            || self.project.contains(&lower)
            || BUILTIN_WORDS.contains(&lower)
            || self.dict.check(word)
            || self.dict.check(&lower)
            || self.dict.check(&capitalize(&lower))
            || american(&lower).is_some_and(|us| self.dict.check(&us));
        CACHE.lock().unwrap().insert(lower, known);
        known
    }
}

/// Words of PHP's own class, function and method names (`SimpleXMLElement` → simple, xml, element).
static BUILTIN_WORDS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    let mut words = HashSet::new();
    for name in crate::mago::builtin_names() {
        for part in name.split('\\') {
            words.extend(split_words(part).into_iter().map(|(s, e)| part[s..e].to_ascii_lowercase()));
        }
    }
    words
});

/// The American spelling of a British one, to check that instead: behaviour → behavior,
/// initialise → initialize, centre → center, cancelled → canceled.
fn american(lower: &str) -> Option<String> {
    let swaps: [(&str, &str); 8] = [
        ("our", "or"),
        ("ours", "ors"),
        ("ise", "ize"),
        ("ised", "ized"),
        ("ising", "izing"),
        ("isation", "ization"),
        ("tre", "ter"),
        ("lled", "led"),
    ];
    swaps.iter().find_map(|(gb, us)| lower.strip_suffix(gb).filter(|stem| stem.len() >= 3).map(|stem| format!("{stem}{us}")))
}

fn capitalize(word: &str) -> String {
    let mut c = word.chars();
    c.next().map(|f| f.to_ascii_uppercase().to_string() + c.as_str()).unwrap_or_default()
}

/// A word worth checking: long enough, not an acronym, has a vowel (not an abbreviation).
fn worth_checking(word: &str) -> bool {
    word.len() >= MIN_LEN
        && word.bytes().all(|b| b.is_ascii_alphabetic())
        && !word.bytes().all(|b| b.is_ascii_uppercase())
        && word.bytes().any(|b| b"aeiouyAEIOUY".contains(&b))
}

/// The words of a name: `getAuthPasswordAStito` → get, Auth, Password, A, Stito; `HTTPServer` →
/// HTTP, Server; `user_name` → user, name. Byte ranges into `token` (ASCII only).
fn split_words(token: &str) -> Vec<(usize, usize)> {
    let b = token.as_bytes();
    let mut words = Vec::new();
    let mut start = None;
    for i in 0..=b.len() {
        let c = b.get(i).copied();
        let boundary = match c {
            None => true,
            Some(c) if !c.is_ascii_alphabetic() => true,
            Some(c) => {
                let prev = if i > 0 { b[i - 1] } else { b'_' };
                let next = b.get(i + 1).copied().unwrap_or(b'_');
                // lower→Upper (getAuth), or the last capital of a run before a lowercase (HTTPServer).
                c.is_ascii_uppercase() && prev.is_ascii_alphabetic() && (prev.is_ascii_lowercase() || next.is_ascii_lowercase())
            }
        };
        if boundary {
            if let Some(s) = start.take() {
                words.push((s, i));
            }
        }
        if matches!(c, Some(c) if c.is_ascii_alphabetic()) && start.is_none() {
            start = Some(i);
        }
    }
    words
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Typo {
    /// Where the misspelled word starts, in UTF-16 code units (the editor's offsets).
    offset: usize,
    length: usize,
    word: String,
}

/// Byte ranges of the lines that only name things from elsewhere: `use` and `namespace` (PHP),
/// `import … from` (JavaScript). Their words aren't checked, and count as known in the file.
fn import_lines(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if ["use ", "namespace ", "import ", "export * from", "} from "].iter().any(|p| t.starts_with(p)) {
            out.push((start, start + line.len()));
        }
        start += line.len();
    }
    out
}

/// The tokens (runs of letters, digits and `_`) of a text: byte start, end and UTF-16 start.
fn tokens(text: &str) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::new();
    let mut utf16 = 0;
    let mut start: Option<(usize, usize)> = None;
    for (i, ch) in text.char_indices() {
        if ch.is_alphanumeric() || ch == '_' {
            start.get_or_insert((i, utf16));
        } else if let Some((b, u)) = start.take() {
            out.push((b, i, u));
        }
        utf16 += ch.len_utf16();
    }
    if let Some((b, u)) = start {
        out.push((b, text.len(), u));
    }
    out
}

#[cfg(test)]
fn find_typos(speller: &Speller, text: &str) -> Vec<Typo> {
    find_typos_with(speller, text, &HashSet::new())
}

/// `known`: more words that are spelled right (lowercase): the project's class names.
fn find_typos_with(speller: &Speller, text: &str, known: &HashSet<String>) -> Vec<Typo> {
    let skipped = import_lines(text);
    let in_skipped = |b: usize| skipped.iter().any(|&(s, e)| b >= s && b < e);
    let all = tokens(text);
    // Words of imported and declared names count as known in the whole file (Totp, Scheb…).
    let mut local: HashSet<String> = HashSet::new();
    for &(b, e, _) in &all {
        if in_skipped(b) {
            let token = &text[b..e];
            local.extend(split_words(token).into_iter().map(|(s, e)| token[s..e].to_ascii_lowercase()));
        }
    }
    let mut typos = Vec::new();
    for &(b, e, u16_start) in &all {
        let token = &text[b..e];
        // Names with a digit are identifiers, not words: kimai2_users, md5, utf8mb4.
        if in_skipped(b) || !token.is_ascii() || token.bytes().any(|c| c.is_ascii_digit()) {
            continue;
        }
        for (s, e) in split_words(token) {
            let word = &token[s..e];
            if !worth_checking(word) {
                continue;
            }
            let lower = word.to_ascii_lowercase();
            // A project word in the plural counts too: teamlead → teamleads.
            let project = |w: &str| local.contains(w) || known.contains(w);
            let plural_of_project = ["es", "s"].iter().any(|end| lower.strip_suffix(end).is_some_and(|stem| stem.len() >= 3 && project(stem)));
            if project(&lower) || plural_of_project || speller.known(word) {
                continue;
            }
            // ASCII: bytes and UTF-16 units are the same inside the token.
            typos.push(Typo { offset: u16_start + s, length: e - s, word: word.to_string() });
        }
    }
    typos
}

/// Words of the names the project declares (`App\Entity\TimesheetMeta` → app, entity, timesheet,
/// meta; `hasTeamleadRole` → has, teamlead, role), rebuilt when the index changes.
/// The index revision they're of (0: none yet), and the words.
static INDEX_WORDS: LazyLock<Mutex<(u64, std::sync::Arc<HashSet<String>>)>> = LazyLock::new(|| Mutex::new((0, Default::default())));

/// Rebuilt only when the index changed since the last time (any change: a renamed method too).
fn index_words(state: &crate::index::IndexState) -> std::sync::Arc<HashSet<String>> {
    let mut cache = INDEX_WORDS.lock().unwrap_or_else(PoisonError::into_inner);
    match crate::index::declared_names(state, cache.0) {
        Ok(Some((revision, names))) => {
            let mut words = HashSet::new();
            for name in &names {
                for part in name.split('\\') {
                    words.extend(split_words(part).into_iter().map(|(s, e)| part[s..e].to_ascii_lowercase()));
                }
            }
            *cache = (revision, std::sync::Arc::new(words));
        }
        Ok(None) => {}
        Err(_) => return Default::default(),
    }
    cache.1.clone()
}

/// The misspelled words of a text (a whole file).
#[tauri::command]
pub async fn spell_check(index: tauri::State<'_, crate::index::IndexState>, text: String) -> Result<Vec<Typo>, String> {
    let index = index.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let known = index_words(&index);
        find_typos_with(&SPELLER.read().unwrap_or_else(PoisonError::into_inner), &text, &known)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Corrections for a word, in its capitalization (Stito → Stint, Stipo…), at most `max`.
#[tauri::command]
pub async fn spell_suggest(word: String, max: usize) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let speller = SPELLER.read().unwrap_or_else(PoisonError::into_inner);
        let mut out = Vec::new();
        speller.dict.suggest(&word, &mut out);
        if out.is_empty() && word.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
            speller.dict.suggest(&word.to_ascii_lowercase(), &mut out);
        }
        let capital = word.chars().next().is_some_and(|c| c.is_ascii_uppercase());
        let mut seen = HashSet::new();
        Ok(out
            .into_iter()
            .filter(|s| s.bytes().all(|b| b.is_ascii_alphabetic()))
            .map(|s| if capital { capitalize(&s) } else { s })
            .filter(|s| seen.insert(s.clone()))
            .take(max)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The project's dictionary (.blitz/project.json): these words count as spelled right.
#[tauri::command]
pub async fn spell_set_words(words: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        SPELLER.write().unwrap_or_else(PoisonError::into_inner).project = words.iter().map(|w| w.to_ascii_lowercase()).collect();
        CACHE.lock().unwrap().clear();
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn typos(text: &str) -> Vec<String> {
        find_typos(&SPELLER.read().unwrap(), text).into_iter().map(|t| t.word).collect()
    }

    #[test]
    fn splits_names_into_words() {
        fn words(t: &str) -> Vec<&str> {
            split_words(t).into_iter().map(|(s, e)| &t[s..e]).collect()
        }
        assert_eq!(words("getAuthPasswordAStito"), ["get", "Auth", "Password", "A", "Stito"]);
        assert_eq!(words("HTTPServer"), ["HTTP", "Server"]);
        assert_eq!(words("user_name2"), ["user", "name"]);
    }

    #[test]
    fn finds_the_misspelled_word_in_a_name() {
        assert_eq!(typos("public function getAuthPasswordAStito(): string"), ["Stito"]);
        // Code words, acronyms, short words and abbreviations are fine.
        assert!(typos("$config = json_encode($args); // HTTPS url idx btn namespace foreach").is_empty());
        // A comment with a typo.
        assert_eq!(typos("// Recieve the payload"), ["Recieve"]);
    }

    #[test]
    fn offsets_are_utf16() {
        let found = find_typos(&SPELLER.read().unwrap(), "// café Recieve");
        assert_eq!(found, [Typo { offset: 8, length: 7, word: "Recieve".into() }]);
    }

    #[test]
    fn suggests_and_learns_words() {
        let rt = tauri::async_runtime::block_on(spell_suggest("Recieve".into(), 5)).unwrap();
        assert!(rt.contains(&"Receive".to_string()), "{rt:?}");
        // A word only this test uses (the tests share the speller and run in parallel).
        assert_eq!(typos("loadQwertzLayout"), ["Qwertz"]);
        tauri::async_runtime::block_on(spell_set_words(vec!["Qwertz".into()])).unwrap();
        assert!(typos("loadQwertzLayout").is_empty());
        tauri::async_runtime::block_on(spell_set_words(vec![])).unwrap();
    }

    #[test]
    fn imports_project_names_and_identifiers_are_not_typos() {
        let file = r#"<?php

namespace App\Entity;

use Scheb\TwoFactorBundle\Model\Totp\TotpConfiguration;
use KevinPapst\TablerBundle\Model\UserInterface;

#[ORM\Table(name: 'kimai2_users')]
class User
{
    // Recieve the TOTP secret for Scheb's bundle
    public function getTotpSecret(): string { return md5('x'); }
    public function getTimesheetMeta(): TimesheetMeta {}
}
"#;
        // Imported names count in the whole file; kimai2_users and md5 are identifiers.
        let index: HashSet<String> = ["app", "entity", "timesheet", "meta"].map(String::from).into();
        let found: Vec<String> = find_typos_with(&SPELLER.read().unwrap(), file, &index).into_iter().map(|t| t.word).collect();
        assert_eq!(found, ["Recieve"]);
    }

    #[test]
    fn php_builtins_and_british_spellings_are_words() {
        let code = r##"$path = realpath(dirname($file)); ksort($list); $n = intval($s);
// The behaviour of colour handling: initialise it once (Recieve stays a typo).
try { $x = new SimpleXMLElement($xml); $f->getPathname(); } catch (Throwable $e) {}
<input autofocus maxlength="5" href="#">"##;
        assert_eq!(typos(code), ["Recieve"]);
    }
}

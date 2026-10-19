//! Spell checking for code: the words inside names (camelCase, snake_case), comments and strings,
//! checked against an English dictionary (Hunspell en_US from SCOWL, in dictionaries/), the usual
//! words of programming and the project's own dictionary (.blitz/project.json, set by the UI).
//!
//! Left alone, to keep the noise down: words shorter than 4 letters, all-caps words (acronyms),
//! words without a vowel (abbreviations: `cnt`, `btn`), and anything with non-ASCII letters.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, RwLock};

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
            || self.dict.check(word)
            || self.dict.check(&lower)
            || self.dict.check(&capitalize(&lower));
        CACHE.lock().unwrap().insert(lower, known);
        known
    }
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

fn find_typos(speller: &Speller, text: &str) -> Vec<Typo> {
    let mut typos = Vec::new();
    // Runs of letters, digits and _ (names and words); a run with non-ASCII letters is skipped.
    let mut utf16 = 0;
    let mut token_start: Option<(usize, usize)> = None; // (byte, utf16)
    let mut ascii = true;
    let flush = |start: Option<(usize, usize)>, end_byte: usize, ascii: bool, typos: &mut Vec<Typo>| {
        let Some((byte, u16_start)) = start else { return };
        if !ascii {
            return;
        }
        let token = &text[byte..end_byte];
        for (s, e) in split_words(token) {
            let word = &token[s..e];
            if worth_checking(word) && !speller.known(word) {
                // ASCII: bytes and UTF-16 units are the same inside the token.
                typos.push(Typo { offset: u16_start + s, length: e - s, word: word.to_string() });
            }
        }
    };
    for (i, ch) in text.char_indices() {
        let part_of_token = ch.is_alphanumeric() || ch == '_';
        if part_of_token {
            if token_start.is_none() {
                token_start = Some((i, utf16));
                ascii = true;
            }
            ascii &= ch.is_ascii();
        } else if token_start.is_some() {
            flush(token_start.take(), i, ascii, &mut typos);
        }
        utf16 += ch.len_utf16();
    }
    flush(token_start.take(), text.len(), ascii, &mut typos);
    typos
}

/// The misspelled words of a text (a whole file).
#[tauri::command]
pub async fn spell_check(text: String) -> Result<Vec<Typo>, String> {
    tauri::async_runtime::spawn_blocking(move || find_typos(&SPELLER.read().unwrap(), &text)).await.map_err(|e| e.to_string())
}

/// Corrections for a word, in its capitalization (Stito → Stint, Stipo…), at most `max`.
#[tauri::command]
pub async fn spell_suggest(word: String, max: usize) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let speller = SPELLER.read().unwrap();
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
        SPELLER.write().unwrap().project = words.iter().map(|w| w.to_ascii_lowercase()).collect();
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
}

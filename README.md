# PHPBlitz

A fast PHP IDE built with Tauri v2 (Rust) and React + Monaco.

## Run

```bash
npm install
npm run tauri dev     # desktop app
npm run dev           # UI only, in a browser (sample project only)
npm run tauri build   # installer in src-tauri/target/release/bundle
```

Needs Rust (rustup), Node 20+, and on Windows the MSVC build tools and WebView2.
PHP, Git and Composer on PATH enable syntax checking, tests, the Commit panel and package updates.

### Errors as you type and formatting (Mago, built in)

[Mago](https://github.com/carthage-software/mago) is linked into the Rust core (`src-tauri/src/mago.rs`), so nothing
extra needs installing:

- **Linter**: style and correctness rules on every edit, including syntax errors.
- **Analyzer**: PHPStan-like type checks across the project, re-run incrementally on each edit.
  Problems ▸ *Project Errors* lists everything; *Re-analyze Project* runs it again.
- **Formatter**: Reformat Code (Ctrl+Alt+L).

The PHP version and framework rules (Laravel, Symfony, PHPUnit, Pest, Doctrine…) come from `composer.json`.
Run `composer install` so framework classes are known to the analyzer.

### Code intelligence (language server)

PHPBlitz talks to a PHP language server over LSP. Install one (PHPantom is preferred, php-lsp is the fallback):

```bash
cargo install phpantom_lsp
cargo install php-lsp
```

PHPBlitz finds them on PATH or in `~/.cargo/bin` when you open a folder. The status bar shows which one runs.
Without a server, a built-in regex index gives basic completion and structure.

| Shortcut | Action |
| --- | --- |
| Ctrl+Click, Ctrl+B, F12 | Go to declaration |
| Alt+F7 | Find usages |
| Shift+F6 | Rename |
| Ctrl+Alt+B | Go to implementation |
| Ctrl+Q | Quick documentation |
| Ctrl+P | Parameter info |
| Ctrl+Alt+L | Reformat code |
| Ctrl+Shift+F / Ctrl+Shift+R | Find in Files / Replace in Files |

## Layout

| Path | What |
| --- | --- |
| `src-tauri/src/lib.rs` | Wires the Rust modules and commands together |
| `src-tauri/src/fs.rs`, `process.rs` | Files; running git/php/composer and shell commands |
| `src-tauri/src/lsp.rs` | Starts language servers and relays LSP messages to the UI |
| `src-tauri/src/watcher.rs` | Watches the project for outside changes (git, composer, other editors) |
| `src-tauri/src/pty.rs` | Terminal shells in a pseudo-terminal (ConPTY on Windows); detects PowerShell, cmd, Git Bash, WSL |
| `src-tauri/src/search.rs` | Find in Files / Replace in Files (ripgrep's walker + regex) |
| `src-tauri/src/mago.rs` | Mago lint, incremental analysis and formatting (`build.rs` embeds PHP's built-in definitions) |
| `src/terminal/manager.ts` | Terminal tabs: xterm.js views and their shells, kept alive while the panel is hidden |
| `src/settings.ts` | Settings (Ctrl+Alt+S) saved per machine; the Terminal page lives in `components/SettingsDialog.tsx` |
| `src/mago.ts` | UI side of Mago: checks, project issues, formatter |
| `src/lsp/` | LSP client (`client.ts`) and Monaco integration (`monacoBridge.ts`) |
| `src/backend/` | `Backend` interface; `DiskBackend` (real folder via Rust) and `SampleBackend` (in-memory demo) |
| `src/useWorkspace.ts` | All state for an open project: tabs, index, git, composer, tests, terminal |
| `src/php.ts` | Regex-based PHP structure, class index, type guessing and Laravel routes |
| `src/monaco.ts` | Offline Monaco setup, theme, PHP member completion |
| `src/mock.ts` | Still mocked: database data and AI replies |
| `src/components/` | UI: tool windows, editor, panels, Search Everywhere |

## Real vs. mocked

Real: open folder, file tree, editing and saving, PHP class index and `->` / `::` completion,
structure, Laravel routes, `php -l` errors, Git status and commit/push, Composer packages
(`composer outdated` / `update`), PHPUnit, an interactive terminal (tabs you can drag to reorder, any installed shell), breakpoints in the gutter.

Mocked for now: database connections, AI assistant, Xdebug debugging.

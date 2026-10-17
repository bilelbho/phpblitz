# PHPBlitz

**A fast, open source PHP IDE.** Built with Rust and [Tauri](https://tauri.app), with the
[Monaco](https://microsoft.github.io/monaco-editor/) editor and [Mago](https://github.com/carthage-software/mago)
for PHP analysis. Free for everyone, including commercial use.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

PHPBlitz takes its workflow from the IDEs PHP developers already know: tool windows, Search
Everywhere, Find Usages, Rename, Alt+Enter fixes, the same keyboard shortcuts. It's an independent
project, written from scratch, and opens big projects quickly on modest machines.

> PHPBlitz is young (version 0.x). Expect rough edges, and please
> [report what you find](https://github.com/bilelbho/phpblitz/issues).

## Download

Get the latest version from [Releases](https://github.com/bilelbho/phpblitz/releases):

| System | File |
| --- | --- |
| Windows 10/11 | `PHPBlitz_x.y.z_x64-setup.exe` (installer) or `.msi` |
| Ubuntu, Debian | `.deb` |
| Fedora, openSUSE | `.rpm` |
| Other Linux | `.AppImage` |

PHP, Git and Composer on your PATH turn on running PHP, tests, the Git tools and package updates.

## What it does

- **Editor**: PHP highlighting, completion, rendered doc comments, bookmarks, soft wrap, Markdown preview,
  TODO comments (with a TODO tool window).
- **Navigation without a language server**: Go to Definition (Ctrl+B), Find Usages (Alt+F7), Show
  Usages (Ctrl+Alt+F7) and Rename (Shift+F6) work from PHPBlitz's own index of your project and `vendor/`,
  cached in the project's `.blitz` folder.
- **Errors as you type**: Mago's linter and PHPStan-like analyzer are built in. Open files are checked
  right away; the whole project is analyzed in the background. Framework rules (Laravel, Symfony,
  PHPUnit, Doctrine…) come from `composer.json`.
- **Git**: change markers, diff viewer, commit, push and pull, branches, log with graph, annotations
  (blame), stash.
- **Databases**: PostgreSQL, MySQL/MariaDB and SQLite: schema tree, query consoles, table data, table
  editing. Passwords stay in your system's credential store.
- **Debugging**: Xdebug 3 step debugging with breakpoints, variables, watches and inline values.
- **Terminal**: real shells in tabs (PowerShell, cmd, Git Bash, WSL, bash, zsh…).
- **Composer**: installed packages, available updates.

Optional: a PHP language server adds more completion and refactorings when found on your PATH
(`cargo install phpantom_lsp`, or `cargo install php-lsp`).

### Project settings

PHPBlitz keeps per-project files in a `.blitz` folder in your project, like `.idea`:

| File | What | Commit it? |
| --- | --- | --- |
| `project.json` | PHP settings, Excluded folders | Yes, to share them |
| `workspace.json` | Bookmarks, recent files, data sources, debugger watches | No (git-ignored) |
| `cache/` | The symbol index | No (git-ignored) |

## Build from source

You need [Rust](https://rustup.rs) (stable) and [Node.js](https://nodejs.org) 20 or newer.

- **Windows**: the Microsoft C++ Build Tools and WebView2 (included in Windows 11).
- **Ubuntu/Debian**:

  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev libxdo-dev pkg-config patchelf file
  ```

Then:

```bash
npm install
npm run tauri dev     # run the desktop app
npm run tauri build   # installers, in src-tauri/target/release/bundle
npm run dev           # the UI alone in a browser, with a sample project
```

Tests: `cargo test` in `src-tauri`, `npx tsc --noEmit` for the UI.

### Where things are

| Path | What |
| --- | --- |
| `src-tauri/src/` | The Rust core: files, symbol index (`index.rs`), Mago (`mago.rs`), search, Git and process runner, terminal (`pty.rs`), databases (`db.rs`), Xdebug (`xdebug.rs`), file watcher, `.blitz` folder |
| `src/useWorkspace.ts` | The state of an open project: tabs, index, analysis, Git, Composer, terminal |
| `src/components/` | The UI: editor, tool windows, dialogs |
| `src/backend/` | `DiskBackend` (a real folder, through Rust) and `SampleBackend` (the in-browser demo) |
| `scripts/third-party-notices.mjs` | Regenerates `THIRD_PARTY_NOTICES.md` after dependency changes |

## Contributing

Issues and pull requests are welcome. By contributing, you agree that your contribution is licensed
under the Apache License 2.0, like the rest of PHPBlitz.

## License

PHPBlitz is open source under the [Apache License 2.0](LICENSE). You may use, change and share it,
commercially too. When you redistribute it or build on it, keep the license and the [NOTICE](NOTICE)
file, and mark the files you changed.

## Thank you

PHPBlitz stands on the work of many open source projects, among them:

- [Tauri](https://tauri.app): the app framework
- [Monaco Editor](https://github.com/microsoft/monaco-editor): the code editor
- [Mago](https://github.com/carthage-software/mago): PHP parser, linter, analyzer and formatter
- [React](https://react.dev): the UI
- [xterm.js](https://xtermjs.org): the terminal
- [ripgrep](https://github.com/BurntSushi/ripgrep)'s crates: Find in Files
- [notify](https://github.com/notify-rs/notify): file watching
- [rust-postgres](https://github.com/sfackler/rust-postgres), [rust-mysql-simple](https://github.com/blackbeam/rust-mysql-simple), [rusqlite](https://github.com/rusqlite/rusqlite): databases
- [keyring](https://crates.io/crates/keyring): passwords in the system's credential store
- [marked](https://marked.js.org) and [DOMPurify](https://github.com/cure53/DOMPurify): Markdown preview
- [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/): the fonts

All 600+ packages, with their licenses, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and in the app (Help ▸ Open Source Licenses).

## Trademarks

PHPBlitz is an independent project. It is not affiliated with, endorsed by or sponsored by
JetBrains s.r.o. PhpStorm, IntelliJ IDEA and JetBrains are trademarks of JetBrains s.r.o. Other
product names are trademarks of their owners and are used only to describe compatibility.

# Contributing to PHPBlitz

Thank you for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/bilelbho/phpblitz/issues/new/choose) and include:

- your system (Windows 11, Ubuntu 24.04…) and the PHPBlitz version (Help ▸ About);
- what you did, what you expected, and what happened (a screenshot helps);
- for slowness: the report from **Help ▸ Startup Performance** (*Copy Report*), and roughly how
  big the project is (number of PHP files, with or without `vendor/`).

Security problems go through a private report instead: see [SECURITY.md](SECURITY.md).

## Making a change

1. Build it: see *Build from source* in the [README](README.md#build-from-source).
2. Keep pull requests focused: one fix or feature each.
3. Before sending, run the checks CI runs:

   ```bash
   npx tsc --noEmit                 # types
   npm run lint                     # ESLint
   npm test                         # front-end tests (Vitest)
   cd src-tauri && cargo test        # Rust tests
   cargo clippy --all-targets -- -D warnings
   cargo fmt --check                 # formatting (src-tauri/rustfmt.toml)
   ```

   For changes to the UI, also run the smoke tests: they start the app and go through the main
   flows (opening a project, search, navigation, editing, dialogs, terminal) on a small project.

   ```bash
   cargo install tauri-driver --locked   # once
   npm run smoke:build                   # the debug app, with the UI built in
   npm run smoke
   ```

   On Windows they also need msedgedriver for your WebView2 version, in `.smoke-tools/edgedriver/`
   (or its path in `PHPBLITZ_NATIVE_DRIVER`); on Linux, WebKitWebDriver (`webkit2gtk-driver`).
   The app runs with a fresh profile in a temporary folder: your own settings aren't touched.

4. Match the code around you: its naming, its comments (short, saying *why*), its idioms. The Rust
   code is written in a wide style (lines up to 160 characters); format it with `cargo fmt`.
   Rust 1.99 or newer is needed (Mago requires it).
5. If you add or update a dependency, regenerate the credits:
   `node scripts/third-party-notices.mjs`. New dependencies must have a license compatible with
   Apache 2.0 (MIT, BSD, ISC, Apache, Zlib, MPL for unmodified use…); no GPL or AGPL.

## Rules that keep the project safe

- **Clean-room only.** Write code from public documentation and observable behavior. Never copy,
  translate or decompile code, icons, themes or assets from proprietary software (PhpStorm and
  other JetBrains products included), and don't paste code whose license you don't know.
- **Your contribution is Apache 2.0.** By sending a pull request, you agree that it's licensed
  under the [Apache License 2.0](LICENSE), like the rest of PHPBlitz, and that you have the right
  to contribute it. Add your name or GitHub handle to [AUTHORS](AUTHORS) in your first pull
  request: the About dialog lists everyone there.
- **No telemetry.** The only thing PHPBlitz fetches on its own is the update check (which can be
  turned off); changes must keep it that way.

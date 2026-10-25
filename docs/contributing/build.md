# Build from source

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

Checks: `npx tsc --noEmit`, `npm run lint` and `npm test` for the UI; `cargo test` and
`cargo clippy` in `src-tauri`.

## Where things are

| Path | What |
| --- | --- |
| `src-tauri/src/` | The Rust core: files, symbol index (`index.rs`), Mago (`mago.rs`), search, Git and process runner, terminal (`pty.rs`), databases (`db.rs`), Xdebug (`xdebug.rs`), file watcher, `.blitz` folder |
| `src/useWorkspace.ts` | The state of an open project: tabs, index, analysis, Git, Composer, terminal |
| `src/components/` | The UI: editor, tool windows, dialogs |
| `src/backend/` | `DiskBackend` (a real folder, through Rust) and `SampleBackend` (the in-browser demo) |
| `docs/` | This site: Markdown pages, built with [VitePress](https://vitepress.dev) |

## This documentation

The pages are Markdown files in [`docs/`](https://github.com/bilelbho/phpblitz/tree/main/docs).
Every page has an *Edit this page on GitHub* link at the bottom.

```bash
npm run docs:dev      # the site with live reload
npm run docs:build    # the static site, in docs/.vitepress/dist
```

The [keyboard shortcuts](../reference/shortcuts) page is generated from the app's keymaps
(`src/keymap`), so it needs no editing when shortcuts change.

## Contributing

Issues and pull requests are welcome; see
[CONTRIBUTING.md](https://github.com/bilelbho/phpblitz/blob/main/CONTRIBUTING.md). PHPBlitz is a
clean-room project: please don't contribute anything copied or decompiled from proprietary software.

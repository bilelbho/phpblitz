# PHPBlitz UI checklist

Manual/exploratory QA of the desktop app (dev build, `npx tauri dev`), driven through its UI on
**test copies only**: `C:\demo\kimai` (big Symfony project), `C:\demo\acme-shop` (small Laravel-style
demo), `C:\demo\trust-test` (tiny untrusted Git project). Settings, layouts and presets of the dev
profile are backed up before and restored after.

Priority: **C** Critical · **H** High · **M** Medium · **L** Low
Status: `Not tested` · `Passed` · `Failed` (bug logged in UI_QA_REPORT.md) · `N/A`

**Not applicable to this app** (a local desktop IDE: no server, no accounts):
login/logout, user roles and admin areas, HTTP 404/error pages, deep links and URL navigation,
browser back/forward, mobile and tablet sizes. In their place: the window at small sizes
(900×600 minimum for a project, 640×480 for the welcome window), Back/Forward *navigation* in the
editor, and an untrusted project (Restricted Mode) as the "less trusted role".

Coverage: **94 / 174 tested (54%)** · Critical: 18 / 18 · (18 Critical, 49 High, 90 Medium, 17 Low)

---

## 1. Startup, welcome and onboarding

| ID | Item | Pri | Status |
|---|---|---|---|
| W-01 | App starts, window appears with no flash or blank screen | C | Passed |
| W-02 | Reopens the last project at startup (setting on) | H | Passed |
| W-03 | Welcome: recent projects list (name, path, branch, color badge) | H | Passed |
| W-04 | Welcome: search/filter recent projects (text, no match, special chars) | M | Passed (filter, no match) |
| W-05 | Welcome: open a recent project | C | Passed |
| W-06 | Welcome: a recent project whose folder is missing (shown as missing, can be removed) | M | Not tested |
| W-07 | Welcome: remove a project from the recent list | M | Not tested |
| W-08 | Welcome: Open… (folder picker, cancel) | H | Not tested (system folder picker: user check) |
| W-09 | Welcome: Clone Repository dialog (empty URL, bad URL, cancel) — no real clone | M | Not tested |
| W-10 | Welcome: New Project dialog (fields, validation, cancel) — not created | M | Not tested |
| W-11 | Welcome: empty state (no recent projects) | M | Passed |
| W-12 | Welcome: Customize opens onboarding | M | Not tested |
| W-13 | Welcome: gear menu (Check for Updates, About, Licenses) | L | Not tested |
| W-14 | Welcome: window controls (minimize, maximize, close) and window drag | M | Not tested |
| O-01 | Onboarding: shows on first launch only (fresh profile) | H | Passed |
| O-02 | Onboarding: theme Light / Dark / System and the four theme cards | M | Passed |
| O-03 | Onboarding: layout Classic / Focus | M | Passed |
| O-04 | Onboarding: base keymap grid | M | Passed |
| O-05 | Onboarding: AI agents detection and "How to install" links | L | Passed |
| O-06 | Onboarding: Vim, Trust all projects, MCP, update check switches | M | Passed |
| O-07 | Onboarding: Finish Setup button and Ctrl+Enter; Help ▸ Onboarding reopens it | M | Passed (Help ▸ Onboarding not reopened) |
| O-08 | Onboarding: keyboard only (Tab through, Space/Enter on switches, focus visible) | M | Passed |

## 2. Trust / Restricted Mode

| ID | Item | Pri | Status |
|---|---|---|---|
| T-01 | Untrusted project asks before anything runs | C | Passed |
| T-02 | Stay in Restricted Mode: no Git/PHP/LSP; status bar shows Restricted Mode | C | Passed |
| T-03 | Restricted: user actions that run programs (Git commit, tests, Composer) fail clearly | H | Passed |
| T-04 | Trust from the status bar reopens the project with everything running | H | Passed |
| T-05 | "Trust all projects in" parent folder | M | Not tested |
| T-06 | Esc = Stay restricted, Enter = Trust; dialog focus | M | Passed |
| T-07 | Settings ▸ Trusted Projects: list, remove, Add Folder…, turn the question off | M | Not tested |

## 3. Workspace shell (both layouts)

| ID | Item | Pri | Status |
|---|---|---|---|
| S-01 | Project opens: tree, editor area, status bar, indexing progress | C | Passed |
| S-02 | Classic: top bar widgets (project, branch, run config, icons) | H | Passed |
| S-03 | Classic: tool window stripes, open/close each tool window | H | Passed |
| S-04 | Classic: splitters resize, sizes kept after reopen | M | Not tested |
| S-05 | Focus: tabs in the top bar, columns, groups | H | Passed |
| S-06 | Focus: drag a panel (beside, above/below, into a group, icon position) | M | Not tested |
| S-07 | Focus: icons side menu (top/bottom/left/right) | L | Not tested |
| S-08 | Focus: presets (save, rename, delete, restore default) | M | Not tested |
| S-09 | Focus: F6 / Ctrl+Shift+F6 / Ctrl+Shift+F12 | M | Not tested |
| S-10 | Focus: narrow window folds icons into ⋯, window buttons always visible | M | Not tested |
| S-11 | Focus: main menu button on the left, menu opens at the left | M | Not tested |
| S-12 | Focus: empty space beside tabs drags the window | L | Not tested |
| S-13 | Switch layout Classic ⇄ Focus at runtime (View ▸ Layout) | H | Passed |
| S-14 | Main menu: every top-level menu opens; items run or are disabled correctly | H | Passed |
| S-15 | Main menu modes: hamburger / merged / separate row | L | Not tested |
| S-16 | Project switcher popup: open projects, recent, colors incl. "no color", Close Project | M | Not tested |
| S-17 | Window at minimum size (900×600): nothing overlaps or is unclickable | M | Failed → fixed (QA-07) |
| S-18 | Zoom In/Out/Reset (UI zoom) | L | Not tested |
| S-19 | Compact mode, tool window names, tool window bars toggles | L | Not tested |
| S-20 | Close Project returns to the welcome screen | H | Passed |
| S-21 | Error boundary: a panel that fails shows "Reload panel" | M | Not tested |

## 4. Project tree

| ID | Item | Pri | Status |
|---|---|---|---|
| P-01 | Expand/collapse folders, keyboard arrows, Enter opens | C | Passed |
| P-02 | Single click previews, double click opens (preview tab) | M | Not tested |
| P-03 | Context menu: New File/Folder/PHP Class (dialogs, validation, special chars) | H | Passed |
| P-04 | Rename file (dialog, invalid names, existing name) | H | Passed |
| P-05 | Delete (confirmation) — on a scratch file only | H | Not tested (asks through a native confirmation dialog: user check) |
| P-06 | Copy / Cut / Paste, Copy Path | M | Not tested |
| P-07 | Mark directory as (Excluded, Sources…) | M | Not tested |
| P-08 | Reveal in Explorer, Open in Terminal | L | Not tested |
| P-09 | Collapse all / expand, Select opened file, toolbar buttons | M | Not tested |
| P-10 | Speed search (typing in the tree) | M | Not tested |
| P-11 | Drag and drop to move a file | M | Not tested |
| P-12 | External change (file created/deleted outside) appears | H | Passed |
| P-13 | Big folder (vendor/) performance | M | Not tested |

## 5. Editor

| ID | Item | Pri | Status |
|---|---|---|---|
| E-01 | Open, edit, save (Ctrl+S), dirty mark, Save All | C | Passed |
| E-02 | Undo/redo, multiple carets, duplicate line, comment line | H | Passed (multiple carets not driven) |
| E-03 | Tabs: close, close others/all, reopen closed, preview tab, tab limit, reorder by drag | H | Passed (reorder by drag not driven) |
| E-04 | Tabs context menu and "All tabs" list | M | Passed |
| E-05 | Completion (PHP, member, variables), last row fully visible | H | Passed |
| E-06 | Go to Declaration (Ctrl+B / Ctrl+click) | C | Passed |
| E-07 | Find Usages popup and tool window | H | Passed |
| E-08 | Rename refactoring (symbol, across files, open and closed files) | H | Passed |
| E-09 | Alt+Enter intentions / quick fixes, lightbulb | H | Passed |
| E-10 | Hover/Quick documentation (Ctrl+Q), doc comment rendering | M | Not tested |
| E-11 | Find (Ctrl+F) / Replace (Ctrl+R) bar: regex, case, no matches, long text | H | Passed |
| E-12 | Inspections counter and problems in the gutter | H | Passed |
| E-13 | Spell check: typo underline, fix renames | M | Not tested |
| E-14 | Usage counts (code vision) and inlay hints | M | Not tested |
| E-15 | Folding, sticky scroll, soft wrap Alt+Z | M | Not tested |
| E-16 | Bookmarks (F11, mnemonic, list Shift+F11) | M | Not tested |
| E-17 | Editor context menu (every item) | M | Not tested |
| E-18 | Surround With (Ctrl+Alt+T) | L | Not tested |
| E-19 | Read-only lock in the status bar | M | Not tested |
| E-20 | Large file (> 2.5 MB) banner and behavior | M | Not tested |
| E-21 | Paste: big text, emoji, special characters, CRLF | M | Not tested |
| E-22 | Font size zoom in the editor (Ctrl+wheel / menu) | L | Not tested |
| E-23 | Markdown: editor/split/preview, scroll sync, run code block | M | Not tested |
| E-24 | Vim mode: modes, motions, :w, :q, Esc, Ctrl keys | M | Not tested |
| E-25 | Status bar: line:col, LF/CRLF, encoding, indentation, breadcrumbs navigation | M | Not tested |
| E-26 | Local History (dialog, revert) | M | Not tested |
| E-27 | Reload file changed on disk (clean and dirty cases) | H | Passed (clean file; the edited-file case asks through a native dialog: user check) |

## 6. File viewers and languages

| ID | Item | Pri | Status |
|---|---|---|---|
| F-01 | Images: open PNG/JPG/ICO, zoom, fit, 1:1, Ctrl+wheel | M | Not tested |
| F-02 | SVG: code + preview, broken SVG message | M | Not tested |
| F-03 | CSV: table view, text view colors, quoted fields, big CSV | M | Not tested |
| F-04 | YAML / JSON / XML / .env / Twig / shell coloring | M | Not tested |
| F-05 | Unknown extension guessed from content (symfony.lock) | L | Not tested |
| F-06 | Binary / non-UTF-8 file: clear error | M | Not tested |

## 7. Navigation and search

| ID | Item | Pri | Status |
|---|---|---|---|
| N-01 | Search Everywhere (Double Shift): tabs All/Classes/Files/Symbols/Actions/Text | C | Failed → fixed (QA-01) |
| N-02 | Search: no results, very long query, special chars, emoji | M | Passed |
| N-03 | Go to File / Class / Symbol | H | Passed |
| N-04 | Recent Files (Ctrl+E) and Recent Locations (Ctrl+Shift+E) | M | Not tested |
| N-05 | Back / Forward / Last Edit Location | H | Passed |
| N-06 | Find in Files (Ctrl+Shift+F): scope, regex, results, open result | H | Passed |
| N-07 | Replace in Files — on a scratch folder only | M | Not tested |
| N-08 | File Structure popup (Ctrl+F12) and Structure tool window | M | Not tested |
| N-09 | Navigation bar popups in the status bar | L | Not tested |
| N-10 | Find Action (Ctrl+Shift+A) runs actions | M | Not tested |

## 8. Tool windows

| ID | Item | Pri | Status |
|---|---|---|---|
| X-01 | Problems: file / project tabs, re-analyze, jump to problem | H | Passed |
| X-02 | Terminal: open, type, multiple tabs, splits, close, rename | C | Passed |
| X-03 | Terminal: find in terminal, copy/paste, links | M | Not tested |
| X-04 | Git: commit panel (changes, diff, message history, AI message button) — no real commit | H | Passed |
| X-05 | Git: log with graph, branches popup, diff view | H | Passed |
| X-06 | Git dialogs: push/new branch/stash/reset — opened and cancelled only | M | Passed after fix (QA-05) |
| X-07 | Diff view: side by side, theme on first open | M | Passed |
| X-08 | Tests: run PHPUnit (gutter icon, results tree, failures, stop, rerun) | H | Passed (stop during a run not driven) |
| X-09 | Debug: start listening, debug panel (no live session) | M | Not tested |
| X-10 | Database: data source dialog validation, SQLite test DB, table view, query console | M | Not tested |
| X-11 | Composer panel: packages list, scripts (no install) | M | Not tested |
| X-12 | npm panel: scripts list | L | Not tested |
| X-13 | Endpoints panel (routes) | M | Passed (panel renders; no routes in that demo) |
| X-14 | TODO tool window | L | Not tested |
| X-15 | Notifications panel and balloons (actions, dismiss) | M | Not tested |
| X-16 | AI panel: no provider state, settings link (no real API calls) | M | Not tested |
| X-17 | Hide/close tool windows, maximize, toggle via shortcuts | M | Not tested |

## 9. Settings and dialogs

| ID | Item | Pri | Status |
|---|---|---|---|
| D-01 | Settings: open, page tree, search box, OK / Cancel / Apply / Reset to defaults | C | Passed |
| D-02 | PHP page: interpreters (add/edit/remove dialogs, invalid path), language level | H | Passed (page renders; interpreter add/edit dialogs not opened) |
| D-03 | Mago page: rule levels, search | M | Passed (page renders) |
| D-04 | Debug page: port validation (letters, 0, 99999) | M | Passed |
| D-05 | Appearance: theme, sync OS, zoom, fonts, layout, main menu, toggles | H | Passed (page renders; Sync with OS kept after OK and reload) |
| D-06 | Keymap: switch preset, change a key, conflicts, reset, import/export (cancelled) | H | Passed (preset switch, filter by name and keys, Cancel; changing a key not driven) |
| D-07 | Editor pages: General, Gutter icons, Tabs, Surround, Color scheme, Font, Inlay hints | M | Passed (pages render) |
| D-08 | Terminal page: shell, font, options | M | Passed (page renders) |
| D-09 | AI page: providers, keys (no real key), agents, MCP | M | Passed (page renders) |
| D-10 | Trusted Projects page | M | Passed (page renders) |
| D-11 | Settings: Cancel discards, OK keeps, values survive restart | C | Passed |
| D-12 | Keyboard Shortcuts dialog (search by name/keys) | M | Not tested |
| D-13 | About / Open Source Licenses | L | Not tested |
| D-14 | Startup Performance and Error Log dialogs (copy report) | L | Not tested |
| D-15 | Every dialog: Esc closes, Enter confirms, focus trapped, focus visible | H | Failed → fixed (QA-05) |

## 10. Accessibility and visual

| ID | Item | Pri | Status |
|---|---|---|---|
| A-01 | Keyboard: Tab order through top bar, tree, editor, panels | H | Passed |
| A-02 | Focus visible on buttons, inputs, tree rows, menus | H | Failed → fixed (QA-06) |
| A-03 | Icon-only buttons have labels (aria-label/title) | M | Passed |
| A-04 | Contrast of muted text in dark and light themes | M | Not tested |
| A-05 | Light theme / High Contrast: every panel readable | M | Not tested |
| A-06 | Text overflow: long file names, long paths, long branch names | M | Not tested |
| A-07 | Console errors and warnings on every screen | C | Failed → fixed (QA-02, QA-04); no other console errors on the screens visited |
| A-08 | Failed IPC calls / unhandled promise rejections | C | Failed → fixed (QA-03); otherwise only Tauri callback warnings after reloads (dev reloads) |

## 11. Stability

| ID | Item | Pri | Status |
|---|---|---|---|
| ST-01 | Open/close a project 5× in a row (no leak of processes, memory) | C | Passed |
| ST-02 | Open/close 30 tabs quickly | H | Failed → fixed (QA-04) |
| ST-03 | Rapid clicks / double clicks on top bar and tool buttons | H | Passed |
| ST-04 | Fast typing and undo storm in the editor | H | Passed |
| ST-05 | Window resize storm (both layouts) | M | Passed |
| ST-06 | Reload the window mid-edit: unsaved changes handling | C | Not tested (asks through a native Save / Don't Save dialog: user check) |
| ST-07 | Reload during indexing / analysis | H | Passed |
| ST-08 | Offline: update check, AI request, docs links fail gracefully | M | Not tested |
| ST-09 | Idle 5+ minutes then use: everything still responds | M | Not tested |
| ST-10 | Memory and DOM size after the journeys (no runaway growth) | H | Passed (heap 73 → 73 MB after the stress runs) |
| ST-11 | Child processes (language server, pty) after closing projects | C | Passed |
| ST-12 | Save during an external change: no lost or duplicated content | C | Passed (clean file; the edited-file case asks through a native dialog: user check) |

## 12. Newer features

| ID | Item | Pri | Status |
|---|---|---|---|
| H-01 | HTTP Client: ▶ / Ctrl+Enter sends; response body, headers, sent request; errors (missing variable, bad URL) | H | Passed |
| H-02 | HTTP Client: environments, named responses, cookies | H | Passed |
| H-03 | HTTP Client: Requests view (form) edits the text and back; Ctrl+Z in the text | H | Passed |
| H-04 | HTTP Client: file body and multipart upload | M | Passed |
| H-05 | HTTP Client: history kept after a restart; Clear History; opened from View ▸ Tool Windows / Ctrl+E / Tools | M | Passed |
| C-01 | Coverage: run with coverage, Coverage window, editor marks, toggle, report kept after a restart | H | Passed |
| C-02 | Coverage: no driver / no source folders gives a clear message | M | Not tested |
| L-01 | Live templates (fore, pubf…), postfix ($x.nn), Tab still indents | H | Passed |
| L-02 | Emmet HTML and CSS; Settings ▸ Live Templates (add, hide, switches) | M | Not tested |
| K-01 | Services: Docker not running / not installed message; compose services listed from the file | M | Passed |
| K-02 | Services with Docker running: up, stop, logs, inspect | M | Not tested |
| G-01 | Git: conflicts dialog, merge editor, Continue / Abort banner (other repository line too) | H | Passed |
| G-02 | Git: partial commit, changelists, shelf, stash tab, patches | M | Not tested |
| G-03 | Git: interactive rebase dialog, compare branches, cherry-pick, inline blame | M | Not tested |
| G-04 | Git: pull requests list (GitHub CLI), create PR dialog — no real PR | M | Not tested |
| G-05 | Git console lists every repository's commands | L | Not tested |

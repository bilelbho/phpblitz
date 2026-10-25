# Install

<script setup>
import Downloads from '../.vitepress/theme/Downloads.vue';
</script>

<Downloads />

::: warning PHPBlitz is young
Version 0.x: the everyday editing, navigation, analysis and Git features work; the debugger, the
database tools and the AI agent support are newer. Expect rough edges, and please
[report what you find](https://github.com/bilelbho/phpblitz/issues).
:::

## The first launch

Each release lists every file's SHA-256 checksum in `SHA256SUMS.txt`. The apps aren't signed by a
certificate yet, so the first launch needs one extra step. Check the checksum first (see
[SECURITY.md](https://github.com/bilelbho/phpblitz/blob/main/SECURITY.md#known-limits)).

- **Windows:** SmartScreen may warn about an unknown publisher: choose *More info ▸ Run anyway*.
- **macOS:** the first time, macOS refuses to open it. Go to *System Settings ▸ Privacy & Security*
  and click *Open Anyway* next to PHPBlitz.
- **Windows portable:** needs the WebView2 runtime, which Windows 11 and updated Windows 10 include.

## What else to install

PHPBlitz edits, navigates and analyzes PHP on its own. These on your `PATH` turn on more:

| Tool | Turns on |
| --- | --- |
| PHP | Running scripts and tests, the debugger (with Xdebug) |
| Composer | Installing and updating packages, `composer install` from the IDE |
| Git | The Git tools: changes, commit, branches, log, blame |
| A PHP language server (optional) | More completion and refactorings: `cargo install phpantom_lsp` or `cargo install php-lsp` |

## Updates

PHPBlitz checks for new versions in the background and asks to restart when one is downloaded.
*Help ▸ Check for Updates* checks now; Settings ▸ Appearance & Behavior ▸ Appearance turns the
check off. The portable version updates by downloading the new zip.

Next: [your first project](./first-project).

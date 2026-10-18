# Security

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately instead:
on GitHub, open the repository's **Security** tab and click **Report a vulnerability**.

Include what you found, how to reproduce it (a small project or file that triggers it is ideal),
the PHPBlitz version (Help ▸ About) and your system. You'll get an answer within a week. Once a fix
is released, you're credited in the release notes, unless you prefer not to be.

## Supported versions

PHPBlitz is young (0.x): security fixes go into the next release. Please update to the
[latest release](https://github.com/bilelbho/phpblitz/releases/latest) before reporting.

## How PHPBlitz handles your code and data

An IDE opens projects that may come from anywhere, so these are the rules PHPBlitz follows:

- **Opening a project doesn't run it.** PHP files are read and parsed (for the index and Mago's
  analysis), never executed. Project code runs only when you start it: tests, the debugger, a PHP
  file you run, the terminal or Composer. Git commands you start can run the repository's
  own Git hooks, as with any Git client.
- **Programs come from your PATH.** PHP, Git, Composer and language servers are the ones installed
  on your machine; PHPBlitz doesn't download programs.
- **No telemetry, no account.** The one request PHPBlitz makes on its own is the update check:
  a few seconds after startup and every six hours it downloads `latest.json` from this repository's
  GitHub Releases, a plain HTTPS request with nothing about you or your projects in it. Turn it off
  in Settings ▸ Appearance & Behavior ▸ Appearance ▸ Updates. Otherwise the network is used only
  for what you start: Git push and pull, Composer, a database connection, a link you open.
- **Updates are signed.** An update is installed only if its signature matches the PHPBlitz update
  key, whose public half is built into the app (`plugins.updater.pubkey` in `tauri.conf.json`), and
  the signature names the version it was made for, so an old release can't be passed off as a new
  one. The signing key is kept outside the repository and used only by the release builds.
- **Passwords stay in your system's credential store** (Windows Credential Manager, the Secret
  Service on Linux: GNOME Keyring or KWallet), never in project files. `.blitz/workspace.json`
  holds your data sources' host and user name, and is git-ignored.
- **Text from projects is never trusted as HTML.** Markdown previews are sanitized (DOMPurify);
  doc comments, hovers and diffs are escaped before they're shown. On top of that, the app window
  has a strict Content Security Policy: only PHPBlitz's own scripts run (no inline scripts or
  event handlers), the window talks only to PHPBlitz itself, and plugins, frames and forms are
  blocked. Images may load over HTTPS (badges in a README's preview).
- **Builds are public.** Releases are built by GitHub Actions from this repository's source, and
  each release lists the SHA-256 checksum of every file in `SHA256SUMS.txt`.

## Known limits

- **The installers aren't signed by a code-signing certificate yet** (Windows signing through
  SignPath is being set up). Windows SmartScreen may warn that the app is
  from an unknown publisher, and macOS asks you to allow it in System Settings ▸ Privacy &
  Security (the Mac app is signed ad hoc, not notarized). Compare the file's checksum with
  `SHA256SUMS.txt` on the release page:

  ```powershell
  Get-FileHash .\PHPBlitz_0.1.3_x64-setup.exe -Algorithm SHA256
  ```

  ```bash
  sha256sum -c SHA256SUMS.txt --ignore-missing      # Linux
  shasum -a 256 -c SHA256SUMS.txt --ignore-missing  # macOS
  ```

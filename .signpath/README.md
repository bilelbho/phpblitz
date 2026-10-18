# Windows code signing (SignPath)

The Windows build signs its files through [SignPath](https://signpath.io), which signs open source
projects for free with a certificate from the SignPath Foundation. Until it's set up, the build
skips those steps and the files stay unsigned.

## What the build does

On a version tag, `build-windows.yml`:

1. builds the NSIS installer, the MSI and the portable zip;
2. uploads them as the `phpblitz-windows-unsigned` workflow artifact and sends a signing request
   for it (project `phpblitz`, signing policy `release-signing`, artifact configuration
   `windows-release`, see `artifact-configuration.xml`);
3. waits for the signed files and puts them in place of the unsigned ones;
4. signs them for the updater (`tauri signer sign`), so the update signature covers the final
   files, and attaches everything to the release.

## Setting it up

1. Apply for the free open source plan on signpath.io. The repository must be public and have a
   release; the application asks for a link to the project's code signing policy.
2. In SignPath, create the project `phpblitz` with the GitHub connector (trusted build system), the
   artifact configuration `windows-release` (from `artifact-configuration.xml`) and the signing
   policy `release-signing`.
3. In the GitHub repository settings, add the secret `SIGNPATH_API_TOKEN` (a SignPath API token
   allowed to submit signing requests) and the variable `SIGNPATH_ORGANIZATION_ID`. The variable is
   what turns the signing steps on.

## Updater signing key

Separate from code signing: installed copies only accept updates signed with the PHPBlitz update
key. The release builds read it from two repository secrets, `TAURI_SIGNING_PRIVATE_KEY` (the key
file's content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Its public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Keep a backup of the private key and its
password: without them, no copy already installed can be updated again.

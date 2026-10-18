// Writes latest.json, the manifest installed copies read to find updates (Tauri updater, static
// format). Run by the release workflow with every release file downloaded into one folder:
//
//   node scripts/updater-manifest.mjs <assets dir> <tag> <repo> <notes file>
//
// Each platform entry points at a release file and carries the content of its .sig, made in the
// build workflows with `tauri signer sign`. Files without a .sig are left out; with none at all
// (no signing key set up), no manifest is written and installed copies keep finding nothing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag, repo, notesFile] = process.argv.slice(2);
if (!dir || !tag || !repo) {
  console.error('usage: node scripts/updater-manifest.mjs <assets dir> <tag> <owner/repo> [notes file]');
  process.exit(2);
}
const version = tag.replace(/^v/, '');

const files = {
  nsis: `PHPBlitz_${version}_x64-setup.exe`,
  msi: `PHPBlitz_${version}_x64_en-US.msi`,
  app: `PHPBlitz_${version}_universal.app.tar.gz`,
  appimage: `PHPBlitz_${version}_amd64.AppImage`,
  deb: `PHPBlitz_${version}_amd64.deb`,
  rpm: `PHPBlitz-${version}-1.x86_64.rpm`,
};

// The updater looks for "{os}-{arch}-{bundle}" first (the package this copy was installed from),
// then "{os}-{arch}".
const targets = {
  'windows-x86_64': 'nsis',
  'windows-x86_64-nsis': 'nsis',
  'windows-x86_64-msi': 'msi',
  'darwin-x86_64': 'app',
  'darwin-x86_64-app': 'app',
  'darwin-aarch64': 'app',
  'darwin-aarch64-app': 'app',
  'linux-x86_64': 'appimage',
  'linux-x86_64-appimage': 'appimage',
  'linux-x86_64-deb': 'deb',
  'linux-x86_64-rpm': 'rpm',
};

const platforms = {};
for (const [target, kind] of Object.entries(targets)) {
  const name = files[kind];
  const sig = join(dir, `${name}.sig`);
  if (!existsSync(join(dir, name)) || !existsSync(sig)) continue;
  platforms[target] = {
    url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    signature: readFileSync(sig, 'utf8').trim(),
  };
}

if (!Object.keys(platforms).length) {
  console.log('No signed update files: latest.json not written.');
  process.exit(0);
}

// The notes shown in the app: the "What's new" list, without the download instructions.
const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8').split(/\n## Download/)[0].replace(/^## What's new\s*/, '').trim() : '';

const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);

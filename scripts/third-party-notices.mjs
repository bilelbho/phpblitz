// Generates THIRD_PARTY_NOTICES.md (every open source package shipped in PHPBlitz, with its license
// text) and src/thirdParty.json (the list shown in Help ▸ Open Source Licenses).
//
//   node scripts/third-party-notices.mjs
//
// Run it after adding or updating dependencies. Works offline: it reads node_modules and
// `cargo metadata` (the crates in Cargo.lock, as downloaded by the last build).

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** License files of a package folder, as text. */
function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => (/^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i.test(f) || /^third.?party.?notices/i.test(f)) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8').trim() }));
}

// ── npm: production dependencies only (what the app bundles) ──────────────
const npmTree = JSON.parse(execSync('npm ls --omit=dev --all --json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const npm = new Map();
(function walk(deps) {
  for (const [name, d] of Object.entries(deps ?? {})) {
    const key = `${name}@${d.version}`;
    if (!npm.has(key)) {
      const dir = join(root, 'node_modules', name);
      let pkg = {};
      try {
        pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      } catch {
        // No package.json (an optional dependency that isn't installed): listed as UNKNOWN.
      }
      const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? pkg.homepage ?? '';
      npm.set(key, { ecosystem: 'npm', name, version: d.version, license, repository: cleanRepo(repo), author: personName(pkg.author), texts: licenseTexts(dir) });
    }
    walk(d.dependencies);
  }
})(npmTree.dependencies);

// ── Rust: crates linked into the app (normal dependencies, all platforms) ──
const meta = JSON.parse(execSync('cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml --offline', { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }));
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const self = meta.packages.find((p) => p.name === 'phpblitz');
const crates = new Map();
const queue = [self.id];
const visited = new Set();
while (queue.length) {
  const id = queue.shift();
  if (visited.has(id)) continue;
  visited.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) {
    // Build scripts and tests don't ship; only normal dependencies end up in the app.
    if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
    queue.push(dep.pkg);
  }
  if (id === self.id) continue;
  const p = byId.get(id);
  const dir = dirname(p.manifest_path);
  crates.set(`${p.name}@${p.version}`, {
    ecosystem: 'crate',
    name: p.name,
    version: p.version,
    license: p.license ?? (p.license_file ? `see ${p.license_file}` : 'UNKNOWN'),
    repository: cleanRepo(p.repository ?? p.homepage ?? ''),
    author: (p.authors ?? []).map(personName).filter(Boolean).join(', '),
    texts: licenseTexts(dir),
  });
}

function cleanRepo(url) {
  return String(url)
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/');
}

function personName(p) {
  if (!p) return '';
  if (typeof p === 'object') return p.name ?? '';
  return String(p).replace(/\s*<[^>]*>/, '').replace(/\s*\([^)]*\)/, '').trim();
}

const all = [...npm.values(), ...crates.values()].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));

// Licenses that would need a closer look before shipping under Apache-2.0.
const copyleft = all.filter((p) => /\b(A?GPL|LGPL|SSPL|EUPL|CC-BY-SA|CC-BY-NC)\b/i.test(p.license) && !/\bOR\b.*\b(MIT|Apache|BSD|ISC|Zlib)\b|\b(MIT|Apache|BSD|ISC|Zlib)\b.*\bOR\b/i.test(p.license));
const unknown = all.filter((p) => /UNKNOWN/.test(p.license));

// ── THIRD_PARTY_NOTICES.md ─────────────────────────────────────────────────
const summary = {};
for (const p of all) summary[p.license] = (summary[p.license] ?? 0) + 1;
let md = `# Third-party notices

PHPBlitz is built on the open source projects below. Thank you to everyone who made and maintains
them. Each is used under its own license, reproduced in full in this file.

${all.length} packages: ${npm.size} JavaScript packages (npm) and ${crates.size} Rust crates.

| License | Packages |
| --- | --- |
${Object.entries(summary)
  .sort((a, b) => b[1] - a[1])
  .map(([l, n]) => `| ${l} | ${n} |`)
  .join('\n')}

## Packages

| Package | Version | License | Source |
| --- | --- | --- | --- |
${all.map((p) => `| ${p.ecosystem === 'npm' ? 'npm' : 'crate'}: ${p.name} | ${p.version} | ${p.license} | ${p.repository} |`).join('\n')}

## License texts

Each distinct text appears once, followed by the packages it applies to.
`;
// Many crates ship the very same Apache-2.0 or MIT text: print each text once.
const texts = new Map();
for (const p of all) {
  for (const t of p.texts) {
    const key = t.text.replace(/\s+/g, ' ');
    if (!texts.has(key)) texts.set(key, { text: t.text, users: [] });
    texts.get(key).users.push(`${p.name} ${p.version} (${t.file})`);
  }
}
const withoutFile = all.filter((p) => !p.texts.length);
let n = 0;
for (const { text, users } of texts.values()) {
  md += `
### Text ${++n}

Used by: ${users.join(', ')}

\`\`\`text
${text.replace(/```/g, "'''")}
\`\`\`
`;
}
if (withoutFile.length) {
  md += `
### Packages without a license file

These packages declare their license in their manifest only; the standard text of that license applies:

${withoutFile.map((p) => `- ${p.name} ${p.version}: ${p.license}`).join('\n')}
`;
}
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), md);

// ── The in-app list ────────────────────────────────────────────────────────
writeFileSync(
  join(root, 'src', 'thirdParty.json'),
  JSON.stringify(all.map(({ ecosystem, name, version, license, repository, author }) => ({ ecosystem, name, version, license, repository, author })), null, 0),
);

console.log(`${all.length} packages (${npm.size} npm, ${crates.size} crates)`);
console.log('By license:', JSON.stringify(summary));
if (copyleft.length) console.log('CHECK copyleft:', copyleft.map((p) => `${p.name}@${p.version} (${p.license})`).join(', '));
if (unknown.length) console.log('CHECK unknown license:', unknown.map((p) => `${p.name}@${p.version}`).join(', '));

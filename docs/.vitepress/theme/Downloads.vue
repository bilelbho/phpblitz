<script setup lang="ts">
// The install page's download table: one row per system, with the latest release's files as
// buttons. The row for the visitor's system is marked.
import { computed, onMounted, ref } from 'vue';
import { data as release } from '../../guide/release.data';

const releases = 'https://github.com/bilelbho/phpblitz/releases/latest';

interface Row {
  os: 'windows' | 'mac' | 'linux';
  system: string;
  note?: string;
  files: { label: string; pattern: RegExp; fallback: string }[];
}

const rows: Row[] = [
  {
    os: 'windows',
    system: 'Windows 10/11 (64-bit)',
    files: [
      { label: 'Installer (.exe)', pattern: /_x64-setup\.exe$/, fallback: 'PHPBlitz_<version>_x64-setup.exe' },
      { label: '.msi', pattern: /_x64_en-US\.msi$/, fallback: '.msi' },
    ],
  },
  {
    os: 'windows',
    system: 'Windows, no install',
    note: 'Unzip it and run PHPBlitz.exe.',
    files: [{ label: 'Portable (.zip)', pattern: /_windows-x64-portable\.zip$/, fallback: 'PHPBlitz_<version>_windows-x64-portable.zip' }],
  },
  {
    os: 'mac',
    system: 'macOS 11+ (Apple Silicon and Intel)',
    files: [{ label: '.dmg', pattern: /_universal\.dmg$/, fallback: 'PHPBlitz_<version>_universal.dmg' }],
  },
  { os: 'linux', system: 'Ubuntu, Debian', files: [{ label: '.deb', pattern: /_amd64\.deb$/, fallback: '.deb' }] },
  { os: 'linux', system: 'Fedora, openSUSE', files: [{ label: '.rpm', pattern: /\.x86_64\.rpm$/, fallback: '.rpm' }] },
  {
    os: 'linux',
    system: 'Other Linux',
    note: 'No install: make it executable and run it.',
    files: [{ label: '.AppImage', pattern: /_amd64\.AppImage$/, fallback: '.AppImage' }],
  },
];

const sums = computed(() => release?.assets.find((a) => a.name === 'SHA256SUMS.txt'));

function asset(pattern: RegExp) {
  return release?.assets.find((a) => pattern.test(a.name));
}

function mb(bytes: number) {
  return `${Math.round(bytes / 1048576)} MB`;
}

// The visitor's system, known only in the browser.
const mine = ref<Row['os'] | null>(null);
onMounted(() => {
  const ua = navigator.userAgent;
  mine.value = /Windows/i.test(ua) ? 'windows' : /Mac OS X|Macintosh/i.test(ua) ? 'mac' : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? 'linux' : null;
});
</script>

<template>
  <div class="downloads">
    <p v-if="release" class="version">
      Version <b>{{ release.version }}</b>, released {{ release.date }}.
      <a :href="release.url">Release notes</a>
    </p>
    <table>
      <thead>
        <tr><th>System</th><th>Download</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.system" :class="{ mine: mine === r.os }">
          <td>
            {{ r.system }}
            <span v-if="mine === r.os" class="you">Your system</span>
            <div v-if="r.note" class="note">{{ r.note }}</div>
          </td>
          <td class="files">
            <template v-for="f in r.files" :key="f.label">
              <a v-if="asset(f.pattern)" class="file" :href="asset(f.pattern)!.url" :title="asset(f.pattern)!.name">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/></svg>
                {{ f.label }}<span class="size">{{ mb(asset(f.pattern)!.size) }}</span>
              </a>
              <a v-else class="file plain" :href="releases"><code>{{ f.fallback }}</code></a>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="after">
      <template v-if="sums">Checksums of every file: <a :href="sums.url">SHA256SUMS.txt</a>. </template>
      Older versions are on <a href="https://github.com/bilelbho/phpblitz/releases">Releases</a>.
    </p>
  </div>
</template>

<style scoped>
.version {
  margin: 0 0 12px;
}
.version a {
  margin-left: 6px;
}
table {
  display: table;
  width: 100%;
  margin: 0;
}
td {
  vertical-align: middle;
}
tr.mine td {
  background: var(--vp-c-brand-soft);
}
.you {
  display: inline-block;
  margin-left: 8px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--ide-blue);
  color: #fff;
  font-size: 12px;
  line-height: 20px;
  vertical-align: 1px;
}
.note {
  margin-top: 2px;
  font-size: 13px;
  color: var(--vp-c-text-3);
}
.files {
  white-space: nowrap;
}
.file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 3px 8px 3px 0;
  padding: 4px 12px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 6px;
  background: var(--ide-island);
  color: var(--vp-c-text-1);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: border-color 0.15s, background-color 0.15s;
}
.file:hover {
  border-color: var(--ide-blue);
  background: var(--ide-hover);
}
.file svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: var(--ide-blue-text);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.size {
  color: var(--vp-c-text-3);
  font-size: 12px;
  font-weight: 400;
}
.file.plain {
  padding: 0;
  border: 0;
  background: none;
}
.after {
  font-size: 14px;
  color: var(--vp-c-text-2);
}
@media (max-width: 640px) {
  .files {
    white-space: normal;
  }
}
@media (prefers-reduced-motion: reduce) {
  .file {
    transition: none;
  }
}
</style>

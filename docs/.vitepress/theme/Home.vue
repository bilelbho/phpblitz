<script setup lang="ts">
// The home page: the hero over a PHPBlitz window drawn in HTML (the docs as the Project tree, the
// features as Ide.php, a screenshot, a terminal), then features, layouts, keyboard and privacy.
import { computed, reactive, ref } from 'vue';
import { useData, withBase } from 'vitepress';

const repo = 'https://github.com/bilelbho/phpblitz';
// Every Download button goes to the install page, which lists the latest release's files.
const download = withBase('/guide/install');

// Lucide icons (ISC license), drawn with currentColor.
const icons: Record<string, string> = {
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  check: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="m8 11 2 2 4-4"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M9 12h12"/>',
  flask: '<path d="M9 3h6M10 3v7.5L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 10.5V3"/><path d="M7 15h10"/>',
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17v4M17 19h4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  fileCode: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M10 13l-2 2 2 2M14 17l2-2-2-2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  git: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
  problems: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10"/>',
};

// The Project tree: the docs sidebar, its groups as folders and its pages as Markdown files.
const { theme } = useData();
interface Folder { name: string; files: { name: string; title: string; link: string }[] }
const folders = computed<Folder[]>(() => {
  const sidebar = theme.value.sidebar as Record<string, { text: string; items: { text: string; link: string }[] }[]>;
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const groups of Object.values(sidebar)) {
    for (const g of groups) {
      if (seen.has(g.text)) continue;
      seen.add(g.text);
      out.push({
        name: g.text.toLowerCase().replace(/[^a-z]+/g, '-'),
        files: g.items.map((i) => ({ name: `${i.link.split('/').pop()}.md`, title: i.text, link: i.link })),
      });
    }
  }
  return out;
});
const open = reactive<Record<string, boolean>>({ 'getting-started': true, 'working-with-code': true });

const tabs = [
  { id: 'code', name: 'Ide.php', icon: 'fileCode' },
  { id: 'shot', name: 'editor.png', icon: 'image' },
] as const;
const tab = ref<(typeof tabs)[number]['id']>('code');

const features = [
  { icon: 'zap', method: 'openBigProjectsFast', title: 'Fast on big projects', text: 'A symbol index of your project and vendor/ in Rust, cached on disk. Thousands of files open in seconds on modest machines.', link: '/guide/first-project' },
  { icon: 'check', method: 'findErrorsAsYouType', title: 'Errors as you type', text: "Mago's linter and analyzer are built in, with rules for Laravel, Symfony, PHPUnit and Doctrine read from composer.json.", link: '/guide/analysis' },
  { icon: 'compass', method: 'navigateAndRefactor', title: 'Navigation and refactoring', text: 'Go to Definition, Find Usages, Rename, Search Everywhere and Recent Locations, with no language server to set up.', link: '/guide/navigation' },
  { icon: 'layout', method: 'arrangeYourLayout', title: 'Layouts your way', text: 'Classic tool windows, or the Focus layout: panels side by side, stacked or grouped, dragged anywhere.', link: '/guide/layouts' },
  { icon: 'flask', method: 'testDebugAndRun', title: 'Tests, debugger, terminal', text: 'PHPUnit and Pest from the gutter, Xdebug step debugging, real shells in tabs and splits.', link: '/guide/tests' },
  { icon: 'branch', method: 'commitAndQuery', title: 'Git and databases', text: 'Commit, branches, a log with graph, blame. PostgreSQL, MySQL and SQLite with query consoles.', link: '/guide/git' },
  { icon: 'sparkles', method: 'askAiWhenYouWant', title: 'AI, on your terms', text: 'Off until you choose. Your own API key, or local models through Ollama, and agents in a terminal tab.', link: '/guide/ai' },
  { icon: 'shield', method: 'keepYourCodePrivate', title: 'Private by default', text: 'No telemetry, no account. Opening a project never runs its code. Keys stay in your credential store.', link: '/reference/privacy' },
];

const layouts = [
  { id: 'classic', label: 'Classic', src: '/screenshots/editor.png', text: 'Tool window bars on the sides, tool windows in side columns and a bottom panel.', alt: 'The Classic layout: the Project and Structure tool windows beside a controller' },
  { id: 'focus', label: 'Focus', src: '/screenshots/focus.png', text: 'Editor tabs in the top bar, and every panel, the editor included, placed where you want it.', alt: 'The Focus layout: the editor tabs in the top bar, the Project sidebar, the terminal below the editor and Problems as a column' },
  { id: 'groups', label: 'Groups', src: '/screenshots/focus-groups.png', text: 'Stack panels in a column, group them behind icons, and put the icons on any side.', alt: 'Panels in groups: the sidebar icons on its left, and a column with Structure above a group of panels' },
  { id: 'drag', label: 'Drag', src: '/screenshots/focus-drag.png', text: 'Drag a panel beside a column, above or below a group, or into it. A hint shows where it lands.', alt: 'Dragging a panel: a hint shows where it will be placed' },
];
const layout = ref(layouts[1]);

const keymaps = ['PHPBlitz', 'VS Code', 'Sublime Text', 'Visual Studio', 'Zed', 'Notepad++'];
const keys = [
  { keys: ['Shift', 'Shift'], what: 'Search Everywhere', twice: true },
  { keys: ['Alt', 'Enter'], what: 'Quick fixes' },
  { keys: ['Shift', 'F6'], what: 'Rename' },
  { keys: ['Alt', 'F7'], what: 'Find Usages' },
  { keys: ['Ctrl', 'B'], what: 'Go to Declaration' },
];

const privacy = [
  { icon: 'fileCode', title: 'Safe to open any project', text: 'PHPBlitz only reads your files. Nothing runs until you start it yourself.' },
  { icon: 'eye', title: 'No telemetry, no account', text: 'The only request it makes by itself is the update check, and you can turn it off.' },
  { icon: 'key', title: 'Secrets stay secret', text: 'Database passwords and API keys go to your system credential store, not files.' },
];

// The title bar's search box opens the site search.
function openSearch() {
  document.querySelector<HTMLButtonElement>('.VPNavBarSearch .DocSearch-Button')?.click();
}
</script>

<template>
  <div class="home">
    <section class="hero">
      <div class="glow" aria-hidden="true"></div>
      <p class="eyebrow"><span class="dot" aria-hidden="true"></span>Open source · Apache 2.0 · Windows, macOS, Linux</p>
      <h1>The <span class="grad">fast</span> PHP IDE,<br>built with Rust</h1>
      <p class="lead">
        Monaco for editing, Mago for analysis, and the tool windows you already know.
        Free for everyone, commercial use included. Your code stays on your machine.
      </p>
      <div class="actions">
        <a class="btn primary" :href="download"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.download"></svg>Download</a>
        <a class="btn" :href="withBase('/guide/install')"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.book"></svg>Read the guide</a>
      </div>

      <div class="ide">
        <header class="titlebar">
          <img class="logo" :src="withBase('/logo.png')" alt="" width="20" height="20">
          <span class="widget"><b>phpblitz</b><svg viewBox="0 0 24 24" aria-hidden="true" class="caret"><path d="m6 9 6 6 6-6"/></svg></span>
          <span class="widget muted"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.branch"></svg>main</span>
          <button type="button" class="search" @click="openSearch">
            <svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.search"></svg>
            <span>Search the docs</span>
            <kbd>Ctrl K</kbd>
          </button>
          <a class="run" :href="download" title="Download PHPBlitz">
            <span class="config">PHPBlitz</span>
            <svg viewBox="0 0 24 24" aria-hidden="true" class="play" v-html="icons.play"></svg>
            <span>Download</span>
          </a>
        </header>

        <div class="body">
          <nav class="strip" aria-label="Tool windows">
            <a class="on" :href="withBase('/guide/install')" title="Guide"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.folder"></svg></a>
            <a :href="withBase('/reference/shortcuts')" title="Keyboard shortcuts"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.keyboard"></svg></a>
            <a :href="withBase('/guide/git')" title="Git"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.git"></svg></a>
            <a :href="withBase('/guide/databases')" title="Databases"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.db"></svg></a>
            <a :href="withBase('/guide/analysis')" title="Problems"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.problems"></svg></a>
            <a :href="withBase('/guide/terminal')" title="Terminal" class="end"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.terminal"></svg></a>
          </nav>

          <aside class="project" aria-label="Documentation">
            <div class="panel-title">Project</div>
            <ul class="tree">
              <li class="row root"><svg viewBox="0 0 24 24" aria-hidden="true" class="chev open" v-html="icons.chevron"></svg><svg viewBox="0 0 24 24" aria-hidden="true" class="folder" v-html="icons.folder"></svg><b>docs</b></li>
              <template v-for="f in folders" :key="f.name">
                <li>
                  <button type="button" class="row lvl1" :aria-expanded="!!open[f.name]" @click="open[f.name] = !open[f.name]">
                    <svg viewBox="0 0 24 24" aria-hidden="true" class="chev" :class="{ open: open[f.name] }" v-html="icons.chevron"></svg>
                    <svg viewBox="0 0 24 24" aria-hidden="true" class="folder" v-html="icons.folder"></svg>{{ f.name }}
                  </button>
                </li>
                <template v-if="open[f.name]">
                  <li v-for="file in f.files" :key="file.link">
                    <a class="row lvl2" :href="withBase(file.link)" :title="file.title">
                      <svg viewBox="0 0 24 24" aria-hidden="true" class="md" v-html="icons.file"></svg>{{ file.name }}
                    </a>
                  </li>
                </template>
              </template>
            </ul>
          </aside>

          <div class="editor">
            <div class="tabs" role="tablist" aria-label="Editor tabs">
              <button v-for="t in tabs" :key="t.id" type="button" role="tab" :aria-selected="tab === t.id" :class="{ on: tab === t.id }" @click="tab = t.id">
                <svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons[t.icon]"></svg>{{ t.name }}
              </button>
            </div>

            <div v-if="tab === 'code'" class="pane code" role="tabpanel">
              <ol class="lines">
                <li><span class="k">&lt;?php</span></li>
                <li></li>
                <li><span class="k">namespace</span> PHPBlitz;</li>
                <li></li>
                <li><span class="d">/** A fast, open source PHP IDE. Free for everyone, commercial use included. */</span></li>
                <li><span class="k">final class</span> Ide</li>
                <li>{</li>
                <template v-for="f in features" :key="f.method">
                  <li class="hint"><span class="ind"></span>{{ f.title.toLowerCase() }}</li>
                  <li><span class="ind"></span><span class="k">public function</span> <a class="fn" :href="withBase(f.link)" :title="f.text">{{ f.method }}</a>(): <span class="k">void</span> {}</li>
                </template>
                <li>}</li>
              </ol>
            </div>

            <div v-else class="pane shot" role="tabpanel">
              <img :src="withBase('/screenshots/editor.png')" width="2400" height="1500" alt="PHPBlitz with a Laravel project: the Project and Structure tool windows, a controller with doc comments and usage counts, and an error found as you type">
            </div>

            <div class="terminal">
              <div class="panel-title"><span>Terminal</span><span class="term-tab">Local</span></div>
              <pre><span class="p">~/code $</span> git clone {{ repo }}
<span class="p">~/code $</span> cd phpblitz &amp;&amp; npm install &amp;&amp; npm run tauri dev<span class="cursor" aria-hidden="true"></span></pre>
            </div>
          </div>
        </div>

        <footer class="statusbar">
          <span>docs</span><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.chevron"></svg><span>{{ tabs.find((t) => t.id === tab)?.name }}</span>
          <span class="spacer"></span>
          <span class="hide-sm">Apache-2.0</span><span class="hide-sm">UTF-8</span><span class="hide-sm">LF</span><span>PHP</span>
        </footer>
      </div>
    </section>

    <section class="block">
      <h2>Everything for PHP work, in one window</h2>
      <p class="sub">Each of these has a guide page: pick one to see how it works.</p>
      <div class="features">
        <a v-for="f in features" :key="f.title" class="feature" :href="withBase(f.link)">
          <span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons[f.icon]"></svg></span>
          <h3>{{ f.title }}</h3>
          <p>{{ f.text }}</p>
        </a>
      </div>
    </section>

    <section class="block split">
      <div class="copy">
        <p class="kicker">Layouts</p>
        <h2>Arrange it like you think</h2>
        <p>Two layouts, both kept for each project as you left them. Save your arrangements as presets and switch with one click.</p>
        <div class="seg" role="tablist" aria-label="Layout screenshots">
          <button v-for="l in layouts" :key="l.id" type="button" role="tab" :aria-selected="layout.id === l.id" :class="{ on: layout.id === l.id }" @click="layout = l">{{ l.label }}</button>
        </div>
        <p class="tab-text" aria-live="polite">{{ layout.text }}</p>
        <a class="more" :href="withBase('/guide/layouts')">About layouts</a>
      </div>
      <figure class="frame">
        <img :src="withBase(layout.src)" width="2400" height="1500" :alt="layout.alt" loading="lazy">
      </figure>
    </section>

    <section class="block split reverse">
      <div class="copy">
        <p class="kicker">Keyboard</p>
        <h2>The keys in your fingers</h2>
        <p>Start with the shortcuts PHP developers already use, or bring your keymap from another editor. Change any key in Settings.</p>
        <ul class="chips" aria-label="Keymaps">
          <li v-for="k in keymaps" :key="k">{{ k }}</li>
        </ul>
        <a class="more" :href="withBase('/reference/shortcuts')">All keyboard shortcuts</a>
      </div>
      <ul class="keys">
        <li v-for="k in keys" :key="k.what">
          <span class="what">{{ k.what }}</span>
          <span><template v-for="(key, i) in k.keys" :key="i"><kbd>{{ key }}</kbd><span v-if="i < k.keys.length - 1" class="plus">{{ k.twice ? ' ' : '+' }}</span></template></span>
        </li>
      </ul>
    </section>

    <section class="block">
      <div class="privacy">
        <div v-for="p in privacy" :key="p.title" class="point">
          <span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons[p.icon]"></svg></span>
          <div><h3>{{ p.title }}</h3><p>{{ p.text }}</p></div>
        </div>
      </div>
    </section>

    <section class="block final">
      <h2>Try it on your biggest project</h2>
      <p class="sub">Version 0.x: young, fast, and getting better every release. <a :href="`${repo}/issues`">Tell us what you find.</a></p>
      <div class="actions">
        <a class="btn primary" :href="download"><svg viewBox="0 0 24 24" aria-hidden="true" v-html="icons.download"></svg>Download PHPBlitz</a>
        <a class="btn" :href="repo">Star on GitHub</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px 96px;
}
svg {
  width: 16px;
  height: 16px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
a {
  color: inherit;
  text-decoration: none;
}
button {
  font: inherit;
  color: inherit;
}
a:focus-visible,
button:focus-visible {
  outline: 2px solid var(--ide-blue);
  outline-offset: 2px;
}

/* Hero */
.hero {
  position: relative;
  padding: 72px 0 0;
  text-align: center;
}
.glow {
  position: absolute;
  inset: -40px 10% auto;
  height: 420px;
  background: radial-gradient(closest-side, var(--hb-glow-1), transparent), radial-gradient(closest-side at 70% 60%, var(--hb-glow-2), transparent);
  filter: blur(40px);
  pointer-events: none;
  z-index: -1;
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 24px;
  padding: 6px 14px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 999px;
  background: var(--ide-island);
  font: 500 13px/1.4 var(--vp-font-family-mono);
  color: var(--ide-muted-2);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ide-green);
}
h1 {
  margin: 0;
  font-size: clamp(40px, 7vw, 72px);
  line-height: 1.05;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--ide-text-strong);
  text-wrap: balance;
}
.grad {
  background: linear-gradient(110deg, var(--ide-blue-text), var(--hb-purple));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lead {
  max-width: 640px;
  margin: 24px auto 0;
  font-size: clamp(17px, 2.2vw, 20px);
  line-height: 1.6;
  color: var(--ide-muted-2);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 32px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 22px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 8px;
  background: var(--ide-island);
  color: var(--ide-text);
  font-weight: 600;
  font-size: 15px;
  transition: border-color 0.2s, background-color 0.2s;
}
.btn:hover {
  background: var(--ide-hover);
}
.btn.primary {
  border-color: var(--ide-blue);
  background: var(--ide-blue);
  color: #fff;
}
.btn.primary:hover {
  background: var(--ide-blue-hover);
  border-color: var(--ide-blue-hover);
}
.btn svg {
  width: 18px;
  height: 18px;
}

/* The IDE window */
.ide {
  display: flex;
  flex-direction: column;
  height: 600px;
  margin-top: 56px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 10px;
  overflow: hidden;
  background: var(--ide-island);
  color: var(--ide-text);
  font-size: 13px;
  text-align: left;
  box-shadow: 0 30px 80px -20px var(--ide-shadow);
}
.titlebar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--ide-line);
}
.logo {
  margin-right: 6px;
}
.widget {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  white-space: nowrap;
}
.widget b {
  font-weight: 600;
}
.widget.muted {
  color: var(--ide-muted-2);
}
.widget .caret {
  width: 12px;
  height: 12px;
  color: var(--ide-muted);
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(360px, 32%);
  height: 28px;
  margin: 0 auto;
  padding: 0 8px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 6px;
  background: var(--ide-raised);
  color: var(--ide-muted);
  cursor: pointer;
  transition: border-color 0.15s;
}
.search:hover {
  border-color: var(--ide-blue);
}
.search span {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
}
.search kbd {
  font: 11px/1 var(--vp-font-family-mono);
  color: var(--ide-muted);
}
.run {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  white-space: nowrap;
  transition: background-color 0.15s;
}
.run:hover {
  background: var(--ide-hover);
}
.run .config {
  color: var(--ide-muted-2);
  padding-right: 8px;
  border-right: 1px solid var(--ide-line-strong);
}
.run .play {
  width: 14px;
  height: 14px;
  color: var(--ide-green);
  fill: var(--ide-green);
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 40px;
  padding: 6px 0;
  border-right: 1px solid var(--ide-line);
}
.strip a {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--ide-icon);
  transition: background-color 0.15s;
}
.strip a:hover {
  background: var(--ide-hover);
}
.strip a.on {
  background: var(--ide-hover-strong);
}
.strip a.end {
  margin-top: auto;
}
.strip svg {
  width: 18px;
  height: 18px;
  stroke-width: 1.75;
}
.panel-title {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 12px;
  font-weight: 600;
  white-space: nowrap;
}
.project {
  display: flex;
  flex-direction: column;
  width: 240px;
  border-right: 1px solid var(--ide-line);
  overflow: hidden;
}
.tree {
  flex: 1;
  margin: 0;
  padding: 0 0 8px;
  list-style: none;
  overflow: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border: 0;
  background: none;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.row:hover {
  background: var(--ide-hover);
}
.row.root {
  cursor: default;
}
.row.root:hover {
  background: none;
}
.row.lvl1 {
  padding-left: 24px;
}
.row.lvl2 {
  padding-left: 58px;
}
.chev {
  width: 14px;
  height: 14px;
  color: var(--ide-muted);
  transition: transform 0.15s;
}
.chev.open {
  transform: rotate(90deg);
}
.folder {
  margin-right: 2px;
  color: var(--ide-folder);
}
.md {
  margin-right: 2px;
  color: var(--ide-blue-text);
}
.editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.tabs {
  display: flex;
  height: 36px;
  border-bottom: 1px solid var(--ide-line);
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border: 0;
  background: none;
  color: var(--ide-muted-2);
  white-space: nowrap;
  cursor: pointer;
}
.tabs button:hover {
  background: var(--ide-hover);
}
.tabs button.on {
  color: var(--ide-text);
}
.tabs button.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--ide-blue);
}
.tabs svg {
  width: 14px;
  height: 14px;
  color: var(--ide-blue-text);
}
.pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.code {
  padding: 8px 0;
  font: 13px/22px var(--vp-font-family-mono);
  color: var(--syn-fg);
}
.lines {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: line;
}
.lines li {
  counter-increment: line;
  white-space: pre;
}
.lines li::before {
  content: counter(line);
  display: inline-block;
  width: 44px;
  padding-right: 20px;
  text-align: right;
  color: var(--syn-gutter);
}
.lines li.hint {
  counter-increment: none;
  font: 12px/20px var(--vp-font-family-base);
  color: var(--ide-muted);
}
.lines li.hint::before {
  content: '';
}
.ind {
  display: inline-block;
  width: 31px;
}
.k {
  color: var(--syn-keyword);
}
.d {
  color: var(--syn-doc);
}
.fn {
  color: var(--syn-func);
}
.fn:hover {
  text-decoration: underline;
}
.shot {
  padding: 12px;
}
.shot img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--ide-line);
  border-radius: 6px;
}
.terminal {
  flex: none;
  height: 112px;
  border-top: 1px solid var(--ide-line);
}
.term-tab {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--ide-hover-strong);
  font-size: 12px;
  font-weight: 400;
}
.terminal pre {
  margin: 0;
  padding: 0 12px;
  font: 12.5px/20px var(--vp-font-family-mono);
  color: var(--syn-fg);
  white-space: pre-wrap;
  word-break: break-all;
}
.terminal .p {
  color: var(--syn-string);
}
.cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 4px;
  vertical-align: -2px;
  background: var(--ide-text);
  animation: blink 1.1s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.statusbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 12px;
  border-top: 1px solid var(--ide-line);
  color: var(--ide-muted-2);
  font-size: 12px;
  white-space: nowrap;
}
.statusbar svg {
  width: 12px;
  height: 12px;
}
.statusbar .spacer {
  flex: 1;
}
.statusbar .spacer ~ span {
  padding: 0 6px;
}

/* Sections */
.block {
  margin-top: 112px;
}
.block > h2,
.copy h2,
.final h2 {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: clamp(28px, 4vw, 40px);
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ide-text-strong);
  text-wrap: balance;
}
.block > h2,
.final {
  text-align: center;
}
.sub {
  max-width: 600px;
  margin: 12px auto 0;
  font-size: 17px;
  color: var(--ide-muted-2);
  text-align: center;
}
.sub a {
  color: var(--ide-blue-text);
}
.kicker {
  margin: 0 0 8px;
  font: 600 13px/1 var(--vp-font-family-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ide-blue-text);
}

/* Features: one panel, cells divided by lines like the app's flat panels */
.features {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 48px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 10px;
  overflow: hidden;
  background: var(--ide-island);
}
.feature {
  display: block;
  padding: 24px;
  border-right: 1px solid var(--ide-line);
  border-bottom: 1px solid var(--ide-line);
  transition: background-color 0.15s;
}
.feature:nth-child(4n) {
  border-right: 0;
}
.feature:nth-last-child(-n + 4) {
  border-bottom: 0;
}
.feature:hover {
  background: var(--ide-hover-soft);
}
.icon {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border: 1px solid var(--ide-line);
  border-radius: 8px;
  background: var(--ide-raised);
  color: var(--ide-blue-text);
}
.icon svg {
  width: 18px;
  height: 18px;
}
.feature h3,
.point h3 {
  margin: 16px 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--ide-text);
}
.feature p,
.point p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ide-muted-2);
}

/* Text beside a picture */
.split {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: 56px;
  align-items: center;
}
.split.reverse {
  grid-template-columns: minmax(0, 6fr) minmax(0, 5fr);
}
.copy > p:not(.kicker):not(.tab-text) {
  margin: 16px 0 0;
  font-size: 17px;
  line-height: 1.6;
  color: var(--ide-muted-2);
}
.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  width: fit-content;
  margin-top: 28px;
  padding: 3px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 8px;
  background: var(--ide-island);
}
.seg button {
  min-height: 34px;
  padding: 0 16px;
  border: 0;
  border-radius: 5px;
  background: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--ide-muted-2);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.seg button:hover {
  color: var(--ide-text);
}
.seg button.on {
  background: var(--ide-select);
  color: var(--ide-text);
}
.tab-text {
  min-height: 3.2em;
  margin: 16px 0 0;
  line-height: 1.6;
  color: var(--ide-text);
}
.more {
  display: inline-block;
  margin-top: 16px;
  font-weight: 600;
  color: var(--ide-blue-text);
}
.more::after {
  content: ' →';
}
.more:hover {
  text-decoration: underline;
}
.frame {
  margin: 0;
  border: 1px solid var(--ide-line-strong);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 30px 80px -20px var(--ide-shadow);
}
.frame img {
  display: block;
  width: 100%;
  height: auto;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 24px 0 0;
  padding: 0;
  list-style: none;
}
.chips li {
  padding: 4px 12px;
  border: 1px solid var(--ide-line-strong);
  border-radius: 999px;
  font-size: 13px;
  color: var(--ide-muted-2);
}
.keys {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--ide-line-strong);
  border-radius: 10px;
  background: var(--ide-island);
  overflow: hidden;
}
.keys li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
}
.keys li + li {
  border-top: 1px solid var(--ide-line);
}
.keys kbd {
  display: inline-block;
  min-width: 28px;
  padding: 3px 8px;
  border: 1px solid var(--ide-line-strong);
  border-bottom-width: 2px;
  border-radius: 6px;
  background: var(--ide-raised);
  font: 500 13px/1.4 var(--vp-font-family-mono);
  text-align: center;
}
.plus {
  margin: 0 4px;
  color: var(--ide-muted);
}
.what {
  font-size: 15px;
  color: var(--ide-text);
}

/* Privacy */
.privacy {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--ide-line-strong);
  border-radius: 10px;
  overflow: hidden;
  background: var(--ide-island);
}
.point {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  padding: 32px;
}
.point + .point {
  border-left: 1px solid var(--ide-line);
}
.point h3 {
  margin-top: 6px;
}
.final .actions {
  margin-top: 28px;
}

@media (max-width: 1000px) {
  .features {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .feature:nth-child(4n) {
    border-right: 1px solid var(--ide-line);
  }
  .feature:nth-child(2n) {
    border-right: 0;
  }
  .feature:nth-last-child(-n + 4) {
    border-bottom: 1px solid var(--ide-line);
  }
  .feature:nth-last-child(-n + 2) {
    border-bottom: 0;
  }
}
@media (max-width: 860px) {
  .project {
    display: none;
  }
  .split,
  .split.reverse {
    grid-template-columns: minmax(0, 1fr);
    gap: 32px;
  }
  .privacy {
    grid-template-columns: minmax(0, 1fr);
  }
  .point + .point {
    border-left: 0;
    border-top: 1px solid var(--ide-line);
  }
  .block {
    margin-top: 80px;
  }
}
@media (max-width: 640px) {
  .home {
    padding: 0 16px 64px;
  }
  .hero {
    padding-top: 40px;
  }
  .eyebrow {
    padding: 5px 12px;
    font-size: 11px;
  }
  .ide {
    height: 520px;
    margin-top: 40px;
  }
  .strip,
  .widget.muted,
  .run,
  .search kbd,
  .hide-sm {
    display: none;
  }
  .search {
    flex: 1;
    width: auto;
    margin: 0 4px;
  }
  .code {
    font-size: 12px;
  }
  .terminal {
    height: auto;
    padding-bottom: 10px;
  }
  .features {
    grid-template-columns: minmax(0, 1fr);
  }
  .feature,
  .feature:nth-child(2n),
  .feature:nth-child(4n) {
    border-right: 0;
  }
  .feature:nth-last-child(-n + 2) {
    border-bottom: 1px solid var(--ide-line);
  }
  .feature:last-child {
    border-bottom: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cursor {
    animation: none;
  }
  .chev,
  .btn,
  .row,
  .strip a,
  .feature,
  .seg button {
    transition: none;
  }
}
</style>

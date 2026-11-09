// UI smoke tests: drives the built app through tauri-driver (WebDriver) on a copy of
// smoke/fixture, with a fresh profile in a temporary folder (your own settings aren't touched).
//
//   npm run smoke:build   # once per change: the debug app with the UI built in
//   npm run smoke         # needs tauri-driver (cargo install tauri-driver --locked), and on
//                         # Windows msedgedriver matching WebView2 (.smoke-tools/edgedriver/ or
//                         # PHPBLITZ_NATIVE_DRIVER); on Linux WebKitWebDriver (webkit2gtk-driver).
//
// Each step fails on its own check, and on any entry in the app's Error Log (uncaught errors,
// unhandled rejections, crashed panels). Screenshots of failures go to smoke/out/.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebDriver } from './webdriver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const WIN = process.platform === 'win32';
const APP = process.env.PHPBLITZ_APP ?? join(REPO, 'src-tauri', 'target', 'debug', WIN ? 'phpblitz.exe' : 'phpblitz');
const NATIVE = process.env.PHPBLITZ_NATIVE_DRIVER ?? (WIN ? join(REPO, '.smoke-tools', 'edgedriver', 'msedgedriver.exe') : null);
const PORT = Number(process.env.PHPBLITZ_DRIVER_PORT ?? 4444);
const OUT = join(HERE, 'out');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slash = (p) => p.replace(/\\/g, '/');

if (!existsSync(APP)) {
  console.error(`No app at ${APP}. Build it first: npm run smoke:build`);
  process.exit(2);
}
if (NATIVE && !existsSync(NATIVE)) {
  console.error(`No native WebDriver at ${NATIVE}. Download msedgedriver for your WebView2 version, or set PHPBLITZ_NATIVE_DRIVER.`);
  process.exit(2);
}

// ── The project and the profile, in a temporary folder ──
const tmp = mkdtempSync(join(tmpdir(), 'phpblitz-smoke-'));
const project = join(tmp, 'project');
cpSync(join(HERE, 'fixture'), project, { recursive: true });
mkdirSync(join(project, 'many'));
for (let i = 1; i <= 30; i++) {
  const n = String(i).padStart(2, '0');
  writeFileSync(join(project, 'many', `Item${n}.php`), `<?php\n\nnamespace App\\Many;\n\nfinal class Item${n}\n{\n}\n`);
}
const git = (...args) => spawnSync('git', ['-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project });
const hasGit = git('init', '-q').status === 0 && git('add', '-A').status === 0 && git('commit', '-q', '-m', 'Fixture').status === 0;
const profile = join(tmp, 'profile');
const env = {
  ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: profile,
  XDG_DATA_HOME: join(profile, 'data'),
  XDG_CONFIG_HOME: join(profile, 'config'),
  XDG_CACHE_HOME: join(profile, 'cache'),
};

// ── tauri-driver ──
const driverArgs = ['--port', String(PORT), ...(NATIVE ? ['--native-driver', NATIVE] : [])];
const driverProcess = spawn('tauri-driver', driverArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let driverLog = '';
driverProcess.stdout.on('data', (d) => (driverLog += d));
driverProcess.stderr.on('data', (d) => (driverLog += d));
driverProcess.on('error', (e) => {
  console.error(`Couldn't start tauri-driver (${e.message}). Install it: cargo install tauri-driver --locked`);
  process.exit(2);
});

const wd = new WebDriver(`http://127.0.0.1:${PORT}`);
for (let i = 0; ; i++) {
  try {
    await wd.cmd('GET', '/status');
    break;
  } catch {
    if (i > 50) throw new Error('tauri-driver did not start:\n' + driverLog);
    await sleep(200);
  }
}

// ── Helpers ──
/** Polls `body` (run in the page) until it returns something truthy. */
async function waitFor(what, body, timeout = 10000, ...args) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await wd.exec(body, ...args);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}` + (last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''));
}
const activeTab = () => wd.exec(`return document.querySelector('.tab.active')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
const waitTab = (name, timeout = 10000) => waitFor(`the tab ${name}`, `return document.querySelector('.tab.active')?.innerText.includes(arguments[0])`, timeout, name);
const noDialog = () => waitFor('no dialog', `return !document.querySelector('[role=dialog], [role=alertdialog]')`, 5000);
function check(ok, message) {
  if (!ok) throw new Error(message);
}

/** Opens a file with Go to File (Ctrl+Shift+N). */
async function gotoFile(name) {
  // From the editor: a terminal with the focus keeps shortcuts for the shell.
  await wd.exec(`document.querySelector('.editor-host .monaco-editor textarea')?.focus();`);
  await wd.press('Ctrl+Shift+N');
  await waitFor('Go to File', `return document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('[role=dialog]')`);
  await wd.type(name);
  await waitFor(`${name} in the list`, `return [...document.querySelectorAll('[role=dialog] .result')].some((o) => o.innerText.includes(arguments[0]))`, 10000, name);
  await wd.press('Enter');
  await waitTab(name);
}

/** The Error Log's entries, if the status bar shows any; then clears it, so the next step starts clean. */
async function errorLog() {
  const button = await wd.find('.status-errors');
  if (!button) return null;
  await wd.click(button);
  const log = await waitFor('the Error Log', `const d = [...document.querySelectorAll('[role=dialog]')].pop(); return d ? d.innerText.slice(0, 1500) : ''`);
  await wd.exec(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.innerText.trim() === 'Clear')?.click();`);
  await wd.press('Escape');
  return log;
}

// ── The steps ──
const steps = [];
const step = (name, run) => steps.push({ name, run });

step('app starts with the welcome screen', async () => {
  await waitFor('the first screen', `return document.readyState === 'complete' && !!document.querySelector('.welcome, .onboarding')`, 30000);
  // A first launch shows the onboarding; this run skips it and opens the project like a restart would.
  await wd.exec(`localStorage.setItem('phpblitz.onboarded', '1'); localStorage.setItem('phpblitz.openProject', arguments[0]); location.reload();`, slash(project));
});

step('an untrusted project asks first', async () => {
  await waitFor('the trust question', `const d = document.querySelector('.trust-dialog'); return !!d && d.contains(document.activeElement)`, 30000);
  await wd.press('Enter'); // the focused button: Trust
  await waitFor('the trust question to close', `return !document.querySelector('.trust-dialog')`);
});

step('the project opens and indexes', async () => {
  await waitFor('the project tree', `return [...document.querySelectorAll('.row')].some((r) => r.innerText.trim().startsWith('src'))`, 30000);
  await waitFor('indexing to finish', `const s = document.querySelector('.statusbar, .status-bar')?.innerText ?? ''; return s && !/Indexing/.test(s)`, 60000);
  check(!(await wd.find('.status-restricted')), 'still in Restricted Mode after trusting');
});

step('Go to Class opens a class', async () => {
  await wd.press('Ctrl+N');
  await waitFor('Go to Class', `return document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('[role=dialog]')`);
  await wd.type('UserRepository');
  await waitFor('UserRepository in the list', `return [...document.querySelectorAll('[role=dialog] .result')].some((o) => o.innerText.includes('UserRepository'))`);
  await wd.press('Enter');
  await waitTab('UserRepository.php');
});

step('Search Everywhere finds a method on the Symbols tab', async () => {
  await wd.doubleShift();
  await waitFor('Search Everywhere', `return !!document.querySelector('[aria-label="Search everywhere"]')`);
  await wd.type('findActive');
  await wd.exec(`[...document.querySelectorAll('[aria-label="Search everywhere"] [role=tab]')].find((t) => t.innerText.trim() === 'Symbols')?.click();`);
  await waitFor('findActiveUsers on Symbols', `return [...document.querySelectorAll('[aria-label="Search everywhere"] .result')].some((o) => o.innerText.includes('findActiveUsers'))`);
  await wd.press('Escape');
  await noDialog();
});

step('Go to Declaration (Ctrl+B) opens the parent class', async () => {
  await waitTab('UserRepository.php');
  const span = await waitFor(
    'AbstractRepository in the extends line',
    `const line = [...document.querySelectorAll('.editor-host .view-line')].find((l) => /extends\\s+AbstractRepository/.test(l.innerText));
     return line ? [...line.querySelectorAll('span span')].reverse().find((s) => s.innerText.includes('AbstractRepository')) ?? null : null`,
  );
  await wd.pointerClick(WebDriver.ref(span));
  await sleep(200);
  await wd.press('Ctrl+B');
  await waitTab('AbstractRepository.php');
});

step('edit and save a file', async () => {
  await gotoFile('notes.txt');
  await wd.exec(`document.querySelector('.editor-host .monaco-editor textarea').focus();`);
  await wd.press('Ctrl+End');
  await wd.type('Saved by the smoke test.');
  await wd.press('Ctrl+S');
  const file = join(project, 'notes.txt');
  const end = Date.now() + 5000;
  while (!readFileSync(file, 'utf8').includes('Saved by the smoke test.')) {
    if (Date.now() > end) throw new Error('notes.txt was not saved');
    await sleep(150);
  }
});

// A tree row by its name: the last line of its text (a class file's row starts with its icon's letter).
const ROW = `const row = (name) => [...document.querySelectorAll('.row')].find((r) => r.innerText.trim().split('\\n').pop() === name) ?? null;`;

step('30 tabs open quickly without breaking the tab bar', async () => {
  const folder = await waitFor('the many folder', `${ROW} return row('many')`);
  await wd.pointerClick(WebDriver.ref(folder));
  await wd.press('Right');
  await waitFor('the many folder open', `${ROW} return !!row('Item01.php')`);
  const opened = await wd.exec(`${ROW}
    for (let i = 1; i <= 30; i++) {
      const name = 'Item' + String(i).padStart(2, '0') + '.php';
      // The tree renders again as a file opens: the row may be back a moment later.
      let found = null;
      for (let t = 0; t < 40 && !found; t++) {
        found = row(name);
        if (!found) await new Promise((r) => setTimeout(r, 50));
      }
      if (!found) return name + ' not in the tree';
      const r = found;
      r.scrollIntoView({ block: 'nearest' });
      r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    return 'ok';`);
  check(opened === 'ok', String(opened));
  await waitTab('Item30.php');
  const tabs = await waitFor('30+ tabs', `const n = document.querySelectorAll('[data-tab]').length; return n >= 30 ? n : 0`);
  check(tabs >= 30, `only ${tabs} tabs`);
});

step('Settings opens and Escape closes it', async () => {
  await wd.press('Ctrl+Alt+S');
  await waitFor('Settings', `const d = document.querySelector('.settings-dialog'); return !!d && d.contains(document.activeElement)`);
  await wd.press('Escape');
  await waitFor('Settings to close', `return !document.querySelector('.settings-dialog')`);
});

step('the Push dialog takes the focus and closes on Escape', async () => {
  if (!hasGit) return 'skipped: no git';
  await wd.press('Ctrl+Shift+K');
  await waitFor('the Push dialog with the focus', `const d = [...document.querySelectorAll('[role=dialog]')].find((x) => /Push Commits/.test(x.innerText)); return !!d && d.contains(document.activeElement)`);
  await wd.press('Escape');
  await waitFor('the Push dialog to close', `return ![...document.querySelectorAll('[role=dialog]')].some((x) => /Push Commits/.test(x.innerText))`);
});

step('the terminal starts a shell', async () => {
  await wd.press('Alt+F12');
  await waitFor('terminal output', `return (document.querySelector('.xterm-rows')?.innerText ?? '').trim().length > 0`, 20000);
});

step('an .http file shows its requests', async () => {
  await gotoFile('api.http');
  await waitFor('the HTTP view switch', `return !!document.querySelector('[aria-label="HTTP view"]')`);
  await wd.exec(`document.querySelector('[aria-label="HTTP view"] [aria-label="Requests"]')?.click();`);
  await waitFor('both requests in the form', `const t = document.querySelector('.md-split')?.innerText ?? ''; return t.includes('Health check') && t.includes('Create a user')`);
});

// ── Run ──
let failed = 0;
const started = Date.now();
try {
  await wd.start({ 'tauri:options': { application: APP } });
  await wd.setWindowRect({ width: 1280, height: 860 }).catch(() => {});
  for (const { name, run } of steps) {
    const t0 = Date.now();
    let result;
    let error = null;
    try {
      result = await run();
      const log = await errorLog();
      if (log) error = new Error('the Error Log has entries:\n' + log);
    } catch (e) {
      error = e;
    }
    const ms = Date.now() - t0;
    if (error) {
      failed++;
      console.log(`✗ ${name} (${ms} ms)\n    ${String(error.message).replace(/\n/g, '\n    ')}`);
      try {
        mkdirSync(OUT, { recursive: true });
        const file = join(OUT, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png');
        writeFileSync(file, Buffer.from(await wd.screenshot(), 'base64'));
        console.log(`    screenshot: ${file}`);
        console.log(`    active tab: ${await activeTab().catch(() => '?')}`);
      } catch {
        // No screenshot: the message says enough.
      }
      // A step that failed may leave a dialog open: the next one starts clean.
      await wd.press('Escape').catch(() => {});
    } else console.log(`✓ ${name} (${ms} ms)${typeof result === 'string' ? ` ${result}` : ''}`);
  }
} catch (e) {
  failed++;
  console.log(`✗ couldn't run: ${e.message}\n${driverLog.slice(-2000)}`);
} finally {
  await wd.quit();
  driverProcess.kill();
  await sleep(500);
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.log(`(left ${tmp} behind: a process still had files open)`);
  }
}
console.log(`\n${steps.length - failed}/${steps.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);

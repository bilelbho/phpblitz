// PHP extensions the project needs (ext-* in composer.json and composer.lock) that the project's PHP
// doesn't load: Composer refuses to install without them, and the code that uses them fails. When
// the extension is there but off in php.ini (a fresh Windows PHP has most of them off), PHPBlitz can
// turn it on for its own runs of PHP and Composer with -d extension=…, leaving php.ini alone.

import { allInterpreters, newInterpreter, interpretersFor, projectPhp, runPhp, saveInterpreters, saveProjectPhp, type Interpreter } from './interpreters';

export interface ExtensionNeed {
  /** As PHP names it, lowercase: "fileinfo", "intl", "zend opcache". */
  name: string;
  /** Who asks for it: "composer.json", or package names from composer.lock. */
  by: string[];
}

/** Composer's own needs: it downloads over HTTPS. */
const COMPOSER_NEEDS = ['openssl'];

/** ext-zend-opcache → "zend opcache": the name get_loaded_extensions() uses, lowercase. */
const extName = (req: string) => req.slice(4).toLowerCase().replace(/-/g, ' ');

function addNeed(out: Map<string, Set<string>>, name: string, by: string) {
  if (!out.has(name)) out.set(name, new Set());
  out.get(name)!.add(by);
}

/** The extensions composer.json and composer.lock require, and who requires each one. */
export function requiredExtensions(composerJson: string | null, composerLock: string | null): ExtensionNeed[] {
  const out = new Map<string, Set<string>>();
  const fromRequire = (require: unknown, by: string) => {
    if (!require || typeof require !== 'object') return;
    for (const key of Object.keys(require)) if (key.toLowerCase().startsWith('ext-')) addNeed(out, extName(key), by);
  };
  try {
    if (composerJson) {
      const json = JSON.parse(composerJson);
      fromRequire(json.require, 'composer.json');
      fromRequire(json['require-dev'], 'composer.json');
    }
  } catch {
    // A broken composer.json: Composer will say so itself.
  }
  try {
    if (composerLock) {
      const lock = JSON.parse(composerLock);
      for (const p of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) fromRequire(p?.require, String(p?.name ?? '?'));
    }
  } catch {
    // Same.
  }
  if (out.size || composerJson) for (const name of COMPOSER_NEEDS) addNeed(out, name, 'Composer');
  return [...out].map(([name, by]) => ({ name, by: [...by].sort((a, b) => (a === 'composer.json' ? -1 : b === 'composer.json' ? 1 : a.localeCompare(b))) }));
}

export interface ExtensionState {
  name: string;
  loaded: boolean;
  /** The extension's file next to this PHP when it isn't loaded (it can be turned on). */
  file: string | null;
}

/** Asks PHP which of these extensions it loads, and where the files of the others are. */
const PROBE = (names: string[]) => `$names = json_decode(${JSON.stringify(JSON.stringify(names))}, true);
$loaded = array_map('strtolower', get_loaded_extensions());
$dirs = array_unique(array_filter([ini_get('extension_dir'), dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'ext', PHP_EXTENSION_DIR]));
$out = [];
foreach ($names as $n) {
  $file = null;
  $is = in_array($n, $loaded, true);
  if (!$is) {
    $base = str_replace(' ', '_', $n === 'zend opcache' ? 'opcache' : $n);
    foreach ($dirs as $d) {
      foreach (['php_' . $base . '.dll', $base . '.so'] as $f) {
        $p = rtrim($d, '/\\\\') . DIRECTORY_SEPARATOR . $f;
        if (is_file($p)) { $file = str_replace('\\\\', '/', realpath($p)); break 2; }
      }
    }
  }
  $out[] = ['name' => $n, 'loaded' => $is, 'file' => $file];
}
echo json_encode($out);`;

export async function probeExtensions(i: Interpreter, root: string, names: string[]): Promise<ExtensionState[]> {
  if (!names.length) return [];
  // One line: it goes through the command line.
  const r = await runPhp(i, root, ['-r', PROBE(names).replace(/\n\s*/g, ' ')]);
  const json = r.stdout.slice(r.stdout.indexOf('['), r.stdout.lastIndexOf(']') + 1);
  if (r.code !== 0 || !json) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || `exit code ${r.code}`);
  return JSON.parse(json) as ExtensionState[];
}

/** The PHP the project runs: its local interpreter, or php from the PATH as a stand-in. */
export function projectInterpreter(root: string): { interpreter: Interpreter; saved: boolean } {
  const id = projectPhp(root).interpreterId;
  const saved = interpretersFor(root).find((x) => x.id === id);
  if (saved) return { interpreter: saved, saved: true };
  return { interpreter: newInterpreter('local', { name: 'PHP', phpPath: 'php' }), saved: false };
}

/** `extension=…` options that load these files. */
const optionsFor = (files: string[]) => files.map((f) => `extension=${f}`);

/**
 * Turns extensions on for PHPBlitz: checks that PHP loads them with -d extension=…, then adds
 * the options to the project's interpreter (one is made for php from the PATH when the project has
 * none). Returns the names that load; throws when none does.
 */
export async function enableExtensions(root: string, states: ExtensionState[]): Promise<string[]> {
  const { interpreter, saved } = projectInterpreter(root);
  const files = states.filter((s) => s.file).map((s) => s.file!);
  if (!files.length) throw new Error('These extensions are not installed with this PHP.');
  const trial: Interpreter = { ...interpreter, options: [...interpreter.options, ...optionsFor(files)] };
  const names = states.filter((s) => s.file).map((s) => s.name);
  const check = await probeExtensions(trial, root, names);
  const working = check.filter((s) => s.loaded).map((s) => s.name);
  if (!working.length) throw new Error(`PHP did not load ${names.join(', ')}.`);
  const keep = states.filter((s) => s.file && working.includes(s.name)).map((s) => s.file!);
  const next: Interpreter = { ...interpreter, options: [...interpreter.options, ...optionsFor(keep)] };
  if (saved) {
    saveInterpreters(allInterpreters().map((x) => (x.id === next.id ? next : x)));
  } else {
    // php from the PATH: a PHPBlitz interpreter for it, so the options have a home.
    const info = await runPhp(interpreter, root, ['-r', 'echo PHP_BINARY, "|", PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;']);
    const [binary, version] = info.stdout.trim().split('|');
    const made: Interpreter = { ...next, name: `PHP ${version ?? ''}`.trim(), phpPath: (binary || 'php').replace(/\\/g, '/') };
    saveInterpreters([...allInterpreters(), made]);
    saveProjectPhp(root, { ...projectPhp(root), interpreterId: made.id });
  }
  return working;
}

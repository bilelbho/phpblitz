// How PHPBlitz runs Composer (install, update, outdated, require…). Plain `composer` only works when
// it is on the PATH and so is PHP (composer.bat calls `php`). So, in order:
//   1. Settings ▸ PHP ▸ Composer path, if set (composer.phar, or a composer executable);
//   2. Composer found on the PATH or in a usual folder; a composer.bat / composer.cmd wrapper with a
//      composer.phar next to it (Composer's Windows setup, or a manual one) runs the .phar directly;
//   3. plain `composer`.
// A .phar runs with the project's PHP interpreter when one is set (a local one), else with `php`,
// and with the interpreter's -d options (extensions turned on for PHPBlitz: phpExtensions.ts).

import { invoke } from '@tauri-apps/api/core';
import type { ShellSpec } from './terminal/manager';
import { getSettings } from './settings';
import { phpOptions, projectLocalInterpreter, projectLocalPhp } from './interpreters';
import { commandLine } from './agents';
import { isTauri } from './platform';

export interface ComposerRunner {
  /** The program to start: PHP (for a .phar), a composer executable, or `composer`. */
  program: string;
  /** Arguments before Composer's own: PHP's -d options and the .phar's path. */
  prefix: string[];
  /** Where it was found, for Settings ("C:/composer/composer.phar with PHP 8.4"). */
  description: string;
}

const COMMON_PHARS = ['C:/composer/composer.phar', 'C:/ProgramData/ComposerSetup/bin/composer.phar'];

async function exists(path: string): Promise<boolean> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const entries = await invoke<{ name: string }[]>('list_dir', { path: dir }).catch(() => []);
  return entries.some((e) => e.name.toLowerCase() === name);
}


/** `php`: the PHP to run a .phar with, when not the project's saved interpreter (Settings shows its draft). */
export async function composerRunner(root: string, php: string | null = projectLocalPhp(root)): Promise<ComposerRunner> {
  // The saved interpreter's options go with its php (not with another one Settings is trying out).
  const saved = projectLocalInterpreter(root);
  // xdebug.mode=off: with Xdebug loaded, Composer restarts PHP without it and the -d options are
  // lost on the way (extensions turned on for PHPBlitz with them). Composer has no use for Xdebug.
  const options = [...(saved && saved.phpPath === php ? phpOptions(saved) : []), '-dxdebug.mode=off'];
  const withPhp = (phar: string, from: string): ComposerRunner => ({ program: php ?? 'php', prefix: [...options, phar], description: `${phar} (${from}), run with ${php ?? 'php from PATH'}` });
  const configured = getSettings().composer.path.trim().replace(/\\/g, '/');
  if (configured) return /\.phar$/i.test(configured) ? withPhp(configured, 'Settings') : { program: configured, prefix: [], description: `${configured} (Settings)` };
  if (!isTauri) return { program: 'composer', prefix: [], description: 'composer' };
  const found = await invoke<string | null>('find_executable', { names: ['composer'] }).catch(() => null);
  if (found) {
    // composer.bat calls `php` from the PATH: its composer.phar runs with the project's PHP instead.
    const phar = found.replace(/\.(bat|cmd)$/i, '.phar');
    if (phar !== found && (await exists(phar))) return withPhp(phar, 'found next to composer.bat');
    return { program: found, prefix: [], description: `${found} (on the PATH)` };
  }
  for (const phar of COMMON_PHARS) if (await exists(phar)) return withPhp(phar, 'found');
  return { program: 'composer', prefix: [], description: 'composer (not found: set its path in Settings ▸ PHP)' };
}

/** A Composer command for the terminal: quoted for its shell. */
export async function composerTerminalLine(root: string, args: string[]): Promise<(shell: ShellSpec) => string> {
  const r = await composerRunner(root);
  return (shell) => commandLine(shell, r.program, [...r.prefix, ...args]);
}

/** A Composer command for `run_shell` (cmd /C on Windows, sh -c elsewhere). */
export async function composerShellLine(root: string, args: string[]): Promise<string> {
  const r = await composerRunner(root);
  const quote = (s: string) => (/[\s"'&()]/.test(s) ? `"${s}"` : s);
  const line = [r.program, ...r.prefix, ...args].map(quote).join(' ');
  // cmd /C drops the first and last quote of a line that starts with one: wrap it once more.
  return navigator.userAgent.includes('Windows') && line.startsWith('"') ? `"${line}"` : line;
}

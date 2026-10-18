import { describe, expect, it } from 'vitest';
import { commandLine, shortPath } from './agents';

const shell = (path: string) => ({ name: '', path, args: [] });
const claude = 'C:/Users/Dev User/.local/bin/claude.exe';
const config = ['--mcp-config', 'C:/Users/Dev User/AppData/Roaming/phpblitz/mcp-agents.json'];

describe('shortPath', () => {
  it('writes the home folder as ~', () => {
    expect(shortPath('C:/Users/Dev User/.local/bin/claude.exe')).toBe('~/.local/bin/claude.exe');
    expect(shortPath('/home/dev/.local/bin/claude')).toBe('~/.local/bin/claude');
    expect(shortPath('/Users/dev/bin/codex')).toBe('~/bin/codex');
    expect(shortPath('C:/Program Files/nodejs/gemini.cmd')).toBe('C:/Program Files/nodejs/gemini.cmd');
  });
});

describe('commandLine', () => {
  it('uses the call operator for quoted paths in PowerShell', () => {
    expect(commandLine(shell('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'), claude, config)).toBe(
      '& "C:/Users/Dev User/.local/bin/claude.exe" --mcp-config "C:/Users/Dev User/AppData/Roaming/phpblitz/mcp-agents.json"',
    );
    expect(commandLine(shell('C:/Program Files/PowerShell/7/pwsh.exe'), 'C:/bin/claude.exe', [])).toBe('C:/bin/claude.exe');
  });

  it('quotes paths for cmd and bash', () => {
    expect(commandLine(shell('C:/Windows/System32/cmd.exe'), claude, [])).toBe('"C:/Users/Dev User/.local/bin/claude.exe"');
    expect(commandLine(shell('/bin/zsh'), '/opt/homebrew/bin/claude', config.slice(0, 1))).toBe('/opt/homebrew/bin/claude --mcp-config');
  });

  it("runs npm's shim by name in bash and the bare name in WSL", () => {
    expect(commandLine(shell('C:/Program Files/Git/bin/bash.exe'), 'C:/Users/dev/AppData/Roaming/npm/codex.cmd', [])).toBe('codex');
    expect(commandLine(shell('C:/Windows/System32/wsl.exe'), claude, config)).toBe('claude');
  });
});

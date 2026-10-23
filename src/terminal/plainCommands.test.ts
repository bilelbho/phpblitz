import { describe, expect, it } from 'vitest';
import { plainCommands } from './plainCommands';

describe('plainCommands', () => {
  it('keeps the lines and drops control characters', () => {
    expect(plainCommands('composer install\r\nphp artisan migrate\n')).toBe('composer install\nphp artisan migrate');
    expect(plainCommands('echo hi\x03\x1b[2Jrm -rf /tmp/x')).toBe('echo hi[2Jrm -rf /tmp/x');
    expect(plainCommands('ls\rwhoami')).toBe('ls\nwhoami');
    expect(plainCommands('printf "a\tb"')).toBe('printf "a\tb"');
  });
});

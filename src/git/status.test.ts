import { describe, expect, it } from 'vitest';
import { parseStatusV2, toChanges } from './status';

describe('parseStatusV2', () => {
  const out = [
    '# branch.oid 0123456789abcdef',
    '# branch.head main',
    '1 .M N... 100644 100644 100644 aaaa bbbb src/my file.php',
    '1 A. N... 000000 100644 100644 0000 cccc Prüfung.php',
    '1 D. N... 100644 000000 000000 dddd 0000 old.php',
    '2 R. N... 100644 100644 100644 eeee ffff R100 new name.php',
    'before.php',
    'u UU N... 100644 100644 100644 100644 1111 2222 3333 conflict.php',
    '? untracked.txt',
    '! ignored.log',
    '',
  ].join('\0');

  it('reads the branch and every kind of change', () => {
    expect(parseStatusV2(out)).toEqual({
      branch: 'main',
      changes: [
        { path: 'src/my file.php', status: 'M' },
        { path: 'Prüfung.php', status: 'A' },
        { path: 'old.php', status: 'D' },
        { path: 'new name.php', status: 'R', from: 'before.php' },
        { path: 'conflict.php', status: 'M' },
        { path: 'untracked.txt', status: 'U' },
      ],
    });
  });

  it('treats a detached head as HEAD and makes paths absolute', () => {
    const parsed = parseStatusV2('# branch.head (detached)\0? a.php\0');
    expect(parsed.branch).toBe('HEAD');
    expect(toChanges('C:/work/app', parsed)).toEqual([{ path: 'C:/work/app/a.php', status: 'U' }]);
  });
});

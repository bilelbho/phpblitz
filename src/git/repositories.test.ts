import { describe, expect, it } from 'vitest';
import { combinedChanges, findRepositories } from './repositories';
import type { Backend, Entry } from '../backend/types';

describe('combinedChanges', () => {
  it("joins the repositories' changes without the nested ones' folders", () => {
    const changes = combinedChanges([
      {
        root: 'C:/shop',
        info: {
          branch: 'main',
          changes: [
            { path: 'C:/shop/src/App.php', status: 'M' },
            { path: 'C:/shop/packages/api/', status: 'U' },
            { path: 'C:/shop/lib', status: 'M' },
          ],
        },
      },
      { root: 'C:/shop/packages/api', info: { branch: 'dev', changes: [{ path: 'C:/shop/packages/api/Api.php', status: 'A' }] } },
      { root: 'C:/shop/lib', info: null },
    ]);
    expect(changes.map((c) => c.path)).toEqual(['C:/shop/src/App.php', 'C:/shop/packages/api/Api.php']);
  });
});

describe('findRepositories', () => {
  const tree: Record<string, string[]> = {
    'C:/p': ['src/', 'packages/', 'vendor/', '.git/', 'README.md'],
    'C:/p/src': ['App.php'],
    'C:/p/packages': ['api/', 'web/'],
    'C:/p/packages/api': ['Api.php'],
    'C:/p/packages/web': ['index.php'],
    'C:/p/vendor': ['lib/'],
  };
  const backend = {
    root: 'C:/p',
    listDir: async (dir: string): Promise<Entry[]> => (tree[dir] ?? []).map((n) => ({ name: n.replace(/\/$/, ''), path: `${dir}/${n.replace(/\/$/, '')}`, isDir: n.endsWith('/') })),
    git: async () => ({ code: 0, stdout: 'submodule.theme.path themes/base\n', stderr: '' }),
    // Listings leave .git out: it's found by reading .git/HEAD.
    readFile: async (path: string) => (path === 'C:/p/packages/api/.git/HEAD' ? 'ref: refs/heads/main' : Promise.reject(new Error('missing'))),
  } as unknown as Backend;

  it('finds nested repositories and submodules, not in vendor', async () => {
    expect(await findRepositories(backend)).toEqual(['C:/p/packages/api', 'C:/p/themes/base']);
  });
});

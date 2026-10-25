import { beforeEach, describe, expect, it, vi } from 'vitest';

// A Node test: a small localStorage for the modules that keep their state there.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('trusted projects', () => {
  it('trusts the projects opened before trust existed, once', async () => {
    localStorage.setItem('phpblitz.recentProjects', JSON.stringify(['C:/work/shop', 'D:/old/blog']));
    const trust = await import('./trust');
    expect(trust.isTrusted('C:/work/shop')).toBe(true);
    expect(trust.isTrusted('C:/work/other')).toBe(false);
    trust.untrustFolder('C:/work/shop');
    expect(trust.isTrusted('C:/work/shop')).toBe(false);
  });

  it('trusts a folder with every project inside it, and nothing beside it', async () => {
    localStorage.setItem('phpblitz.trustedFolders', '[]');
    const trust = await import('./trust');
    trust.trustFolder('C:\\Users\\me\\workspace\\');
    expect(trust.isTrusted('C:/Users/me/workspace/shop')).toBe(true);
    expect(trust.isTrusted('c:/users/ME/Workspace/shop/api')).toBe(true);
    expect(trust.isTrusted('C:/Users/me/workspace-old/shop')).toBe(false);
    expect(trust.isTrusted('/home/me/workspace/shop')).toBe(false);
  });

  it('keeps one entry when a folder covers projects trusted before', async () => {
    localStorage.setItem('phpblitz.trustedFolders', JSON.stringify(['/home/me/code/a', '/home/me/code/b', '/srv/x']));
    const trust = await import('./trust');
    trust.trustFolder('/home/me/code');
    expect(trust.trustedFolders()).toEqual(['/srv/x', '/home/me/code']);
    // On Linux and macOS paths keep their case.
    expect(trust.isTrusted('/home/me/Code/a')).toBe(false);
  });

  it('trusts every project when Restricted Mode is off', async () => {
    localStorage.setItem('phpblitz.trustedFolders', '[]');
    localStorage.setItem('phpblitz.settings', JSON.stringify({ security: { restrictedMode: false } }));
    const trust = await import('./trust');
    expect(trust.isTrusted('/anything')).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('onboarding', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('shows on the first launch only', async () => {
    const o = await import('./onboarding');
    expect(o.needsOnboarding()).toBe(true);
    o.finishOnboarding();
    expect(o.needsOnboarding()).toBe(false);
  });

  it('is skipped for people who used PHPBlitz before it existed', async () => {
    localStorage.setItem('phpblitz.recentProjects', JSON.stringify(['C:/work/shop']));
    const o = await import('./onboarding');
    expect(o.needsOnboarding()).toBe(false);
  });
});

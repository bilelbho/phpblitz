import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type TabSettings } from './settings';
import { insertTab, nextActive, overLimit } from './tabPolicy';

const tab = (name: string) => ({ id: name, kind: 'file', path: `/app/${name}` });
const tabs = ['a.php', 'b.php', 'c.php', 'd.php'].map(tab);
const settings = (s: Partial<TabSettings>): TabSettings => ({ ...DEFAULT_SETTINGS.tabs, ...s });

describe('insertTab', () => {
  it('opens after the current tab, at the end, or sorted', () => {
    const ids = (s: Partial<TabSettings>) => insertTab(tabs, tab('bb.php'), 'a.php', settings({ sortAlphabetically: false, openAtEnd: false, ...s })).map((t) => t.id);
    expect(ids({})).toEqual(['a.php', 'bb.php', 'b.php', 'c.php', 'd.php']);
    expect(ids({ openAtEnd: true })).toEqual(['a.php', 'b.php', 'c.php', 'd.php', 'bb.php']);
    expect(ids({ sortAlphabetically: true })).toEqual(['a.php', 'b.php', 'bb.php', 'c.php', 'd.php']);
  });
});

describe('overLimit', () => {
  it('never closes the active tab or unsaved files', () => {
    const s = settings({ limit: 2, overLimit: 'unchanged' });
    expect(overLimit(tabs, s, 'a.php', (t) => t.id === 'b.php', [])).toEqual(['c.php', 'd.php']);
  });

  it('closes the least recently used tabs', () => {
    const s = settings({ limit: 3, overLimit: 'unused' });
    expect(overLimit(tabs, s, 'a.php', () => false, ['/app/a.php', '/app/b.php', '/app/d.php', '/app/c.php'])).toEqual(['c.php']);
  });
});

describe('nextActive', () => {
  it('activates the left, right or most recent tab', () => {
    const next = (activateOnClose: TabSettings['activateOnClose']) => nextActive(tabs, ['b.php'], 'b.php', settings({ activateOnClose }), ['/app/b.php', '/app/d.php']);
    expect(next('left')).toBe('a.php');
    expect(next('right')).toBe('c.php');
    expect(next('recent')).toBe('d.php');
  });

  it('keeps the active tab when another one closes, and gives null when none is left', () => {
    expect(nextActive(tabs, ['c.php'], 'a.php', settings({}), [])).toBe('a.php');
    expect(nextActive(tabs, tabs.map((t) => t.id), 'a.php', settings({}), [])).toBeNull();
  });
});

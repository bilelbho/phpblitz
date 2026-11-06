import { beforeEach, describe, expect, it } from 'vitest';
import { addList, changelistsOf, deleteList, DEFAULT_LIST, forgetFiles, listOf, moveToList, setActiveList } from './changelists';

let root = '';
beforeEach(() => {
  root = `C:/repo-${Math.random()}`;
});

describe('changelists', () => {
  it('puts files in a new list; the rest stays in Changes', () => {
    const id = addList(root, 'Feature', ['a.php']);
    expect(listOf(changelistsOf(root), 'a.php')).toBe(id);
    expect(listOf(changelistsOf(root), 'b.php')).toBe(DEFAULT_LIST.id);
  });

  it('lands new changes in the active list, and keeps the old ones where they were', () => {
    const id = addList(root, 'Feature');
    setActiveList(root, id, ['old.php']);
    expect(listOf(changelistsOf(root), 'old.php')).toBe(DEFAULT_LIST.id);
    expect(listOf(changelistsOf(root), 'new.php')).toBe(id);
  });

  it('sends a deleted list’s files back to Changes, and forgets committed files', () => {
    const id = addList(root, 'Debug', ['x.php', 'y.php']);
    moveToList(root, ['z.php'], id);
    forgetFiles(root, new Set(['x.php', 'z.php']));
    expect(Object.keys(changelistsOf(root).files).sort()).toEqual(['x.php', 'z.php']);
    deleteList(root, id);
    expect(changelistsOf(root).files).toEqual({});
    expect(changelistsOf(root).lists).toEqual([DEFAULT_LIST]);
    expect(listOf(changelistsOf(root), 'x.php')).toBe(DEFAULT_LIST.id);
  });
});

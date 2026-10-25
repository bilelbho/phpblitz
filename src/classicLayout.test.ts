import { describe, expect, it } from 'vitest';
import { CLASSIC_START, classicStateFrom } from './classicLayout';
import { DEFAULT_LAYOUT, moveTool } from './toolLayout';

describe('saved Classic layouts', () => {
  it('reads back what was saved', () => {
    const s = { ...CLASSIC_START, open: { ...CLASSIC_START.open, leftBottom: 'structure' as const, rightTop: 'ai' as const }, bottomOpen: false, bottomTab: 'terminal' as const, sizes: { ...CLASSIC_START.sizes, leftWidth: 400 } };
    expect(classicStateFrom(JSON.parse(JSON.stringify(s)), DEFAULT_LAYOUT)).toEqual(s);
  });

  it('opens a tool window only where it still lives', () => {
    // AI dragged to the left since: not open on the right any more.
    const layout = moveTool(DEFAULT_LAYOUT, 'ai', 'leftBottom', 0);
    expect(classicStateFrom({ open: { leftTop: 'project', rightTop: 'ai' } }, layout).open).toEqual({ leftTop: 'project', leftBottom: null, rightTop: null, rightBottom: null });
    // Project dragged away: the start doesn't open it on the left either.
    expect(classicStateFrom(null, moveTool(DEFAULT_LAYOUT, 'project', 'rightTop', 0)).open.leftTop).toBeNull();
  });

  it('keeps what still makes sense of an old or broken state', () => {
    const s = classicStateFrom({ bottomTab: 'usages', bottomSideTool: 'terminal', sizes: { leftWidth: 'wide', bottomHeight: 99999 } }, DEFAULT_LAYOUT);
    expect(s).toEqual({ ...CLASSIC_START, sizes: { ...CLASSIC_START.sizes, bottomHeight: 3000 } });
  });
});

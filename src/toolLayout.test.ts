import { describe, expect, it } from 'vitest';
import { FOCUS_START, focusStateFrom, hidePanel, movePanel, panelShown, resizeColumn, resizeGroups, setIconsSide, showPanel, toggleFirstColumn, type FocusPanel, type FocusState } from './toolLayout';

/** The layout as lists: columns of groups of panels, the shown one marked *, hidden groups in (). */
const shape = (s: FocusState) => s.columns.map((c) => c.groups.map((g) => (g.hidden ? '(' : '') + g.panels.map((p) => (p === g.active && g.panels.length > 1 ? `${p}*` : p)).join(' ') + (g.hidden ? ')' : '')));
const open = (...panels: FocusPanel[]) => panels.reduce((s, p) => showPanel(s, p), FOCUS_START);

describe('Focus layout: showing and closing', () => {
  it('starts with the Project group, then the editor', () => {
    expect(shape(FOCUS_START)).toEqual([['project* structure commit'], ['editor']]);
  });

  it('opens a panel not placed yet as a column at the right end, once', () => {
    expect(shape(showPanel(open('terminal', 'ai'), 'terminal'))).toEqual([['project* structure commit'], ['editor'], ['terminal'], ['ai']]);
  });

  it('closing hides the group in its place; opening shows it there again', () => {
    const closed = hidePanel(open('terminal'), 'terminal');
    expect(shape(closed)).toEqual([['project* structure commit'], ['editor'], ['(terminal)']]);
    expect(panelShown(closed, 'terminal')).toBe(false);
    expect(shape(showPanel(closed, 'terminal'))).toEqual(shape(open('terminal')));
  });

  it('opening a panel of a group shows it in the group', () => {
    const s = showPanel(FOCUS_START, 'commit');
    expect(shape(s)[0]).toEqual(['project structure commit*']);
    expect([panelShown(s, 'commit'), panelShown(s, 'project')]).toEqual([true, false]);
  });

  it('the editor is never closed', () => {
    expect(hidePanel(FOCUS_START, 'editor')).toBe(FOCUS_START);
  });

  it('the sidebar button closes and opens the column left of the editor', () => {
    const s = toggleFirstColumn(FOCUS_START);
    expect(shape(s)[0]).toEqual(['(project* structure commit)']);
    expect(toggleFirstColumn(s)).toEqual(FOCUS_START);
  });
});

describe('Focus layout: dragging panels', () => {
  it('beside a column: a column of its own, before or after', () => {
    const s = open('terminal');
    expect(shape(movePanel(s, 'ai', { kind: 'column', ref: 'editor', after: false }))).toEqual([['project* structure commit'], ['ai'], ['editor'], ['terminal']]);
    expect(shape(movePanel(s, 'ai', { kind: 'column', ref: 'project', after: false }))[0]).toEqual(['ai']);
  });

  it('above or below a group: stacked, sharing its height', () => {
    const s = movePanel(open('terminal'), 'problems', { kind: 'stack', ref: 'editor', below: true });
    expect(shape(s)[1]).toEqual(['editor', 'problems']);
    expect(s.columns[1].groups.map((g) => g.weight)).toEqual([0.5, 0.5]);
    expect(shape(movePanel(s, 'terminal', { kind: 'stack', ref: 'project', below: false }))[0]).toEqual(['terminal', 'project* structure commit']);
  });

  it('into a group: a tab of it, shown; never into the editor', () => {
    const s = movePanel(open('terminal'), 'terminal', { kind: 'tab', ref: 'structure' });
    expect(shape(s)).toEqual([['project structure commit terminal*'], ['editor']]);
    expect(movePanel(open('terminal'), 'terminal', { kind: 'tab', ref: 'editor' })).toEqual(open('terminal'));
  });

  it('into a group at a chosen place among its icons, or along its own row', () => {
    const s = movePanel(open('terminal'), 'terminal', { kind: 'tab', ref: 'project', index: 1 });
    expect(shape(s)[0]).toEqual(['project terminal* structure commit']);
    // Commit to the front of its own group (counted without itself).
    expect(shape(movePanel(FOCUS_START, 'commit', { kind: 'tab', ref: 'project', index: 0 }))[0]).toEqual(['commit* project structure']);
    // Past the end: the end.
    expect(shape(movePanel(FOCUS_START, 'project', { kind: 'tab', ref: 'structure', index: 9 }))[0]).toEqual(['structure commit project*']);
  });

  it('the editor moves like any panel', () => {
    expect(shape(movePanel(open('terminal'), 'editor', { kind: 'column', ref: 'terminal', after: true }))).toEqual([['project* structure commit'], ['terminal'], ['editor']]);
  });

  it('a tab dragged out of its group leaves the others, the next one shown', () => {
    const s = movePanel(FOCUS_START, 'project', { kind: 'column', ref: 'editor', after: true });
    expect(shape(s)).toEqual([['structure* commit'], ['editor'], ['project']]);
  });

  it('a group or column left empty goes', () => {
    const s = movePanel(open('terminal'), 'terminal', { kind: 'stack', ref: 'editor', below: true });
    expect(shape(s)).toEqual([['project* structure commit'], ['editor', 'terminal']]);
  });
});

describe('Focus layout: sizes', () => {
  it('a column within bounds', () => {
    expect(resizeColumn(FOCUS_START, 0, 100, 1000).columns[0].width).toBe(380);
    expect(resizeColumn(FOCUS_START, 0, -500, 1000).columns[0].width).toBe(200);
  });

  it('stacked groups trade their share of the height, each keeping 80 px', () => {
    const s = movePanel(open('terminal'), 'problems', { kind: 'stack', ref: 'terminal', below: true });
    const c = s.columns.findIndex((col) => col.groups.length === 2 && col.groups[0].panels[0] === 'terminal');
    const t = resizeGroups(s, c, 0, 100, 1000);
    expect(t.columns[c].groups.map((g) => g.weight)).toEqual([0.6, 0.4]);
    expect(resizeGroups(s, c, 0, 5000, 1000).columns[c].groups[1].weight).toBeCloseTo(0.08);
  });
});

describe('Focus layout: saved layouts', () => {
  it('reads back what was saved', () => {
    const s = setIconsSide(hidePanel(movePanel(open('terminal', 'database'), 'ai', { kind: 'tab', ref: 'terminal' }), 'database'), 'project', 'left');
    expect(focusStateFrom(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('reads layouts saved before groups: the sidebar, the editor, columns of panels', () => {
    const old = { sidebarOpen: false, sidebarTools: ['project', 'terminal'], sidebar: 'terminal', sidebarWidth: 320, columns: [['ai', 'problems'], 'database', 'find'], widths: { ai: 500 } };
    const s = focusStateFrom(old);
    expect(shape(s)).toEqual([['(project terminal*)'], ['editor'], ['ai', 'problems'], ['database']]);
    expect(s.columns.map((c) => c.width)).toEqual([320, 0, 500, 380]);
  });

  it('a group keeps its icons on the side chosen; top is the default, not saved', () => {
    expect(setIconsSide(FOCUS_START, 'structure', 'right').columns[0].groups[0].icons).toBe('right');
    expect(setIconsSide(setIconsSide(FOCUS_START, 'commit', 'bottom'), 'commit', 'top')).toEqual(FOCUS_START);
    expect(focusStateFrom({ columns: [{ groups: [{ panels: ['project', 'commit'], icons: 'diagonal' }] }] }).columns[0].groups[0].icons).toBeUndefined();
  });

  it('keeps what still makes sense of a broken layout; the editor is always there, alone in its group', () => {
    expect(shape(focusStateFrom({ columns: [{ groups: [{ panels: ['terminal', 'gone', 'terminal'] }] }] }))).toEqual([['terminal'], ['editor']]);
    expect(shape(focusStateFrom({ columns: [{ groups: [{ panels: ['editor', 'ai'] }] }] }))).toEqual([['ai'], ['editor']]);
    expect(focusStateFrom(null)).toEqual(FOCUS_START);
    // A group's share edited out of sight: kept at a tenth of the others' at least.
    const tiny = focusStateFrom({ columns: [{ groups: [{ panels: ['editor'] }] }, { width: 400, groups: [{ panels: ['terminal'], weight: 0.00001 }, { panels: ['ai'], weight: 1 }] }] });
    const [small, big] = tiny.columns[1].groups.map((g) => g.weight);
    expect(small).toBe(0.1);
    expect(big).toBeCloseTo(2);
  });
});

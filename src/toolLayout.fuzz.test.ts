// Random sequences of what a user does to the Focus layout (open, close, drag anywhere, resize,
// the sidebar button, a reload), checking after each step what must always hold.

import { describe, expect, it } from 'vitest';
import {
  FOCUS_START,
  FOCUS_TOOLS,
  focusStateFrom,
  hidePanel,
  movePanel,
  panelShown,
  resizeColumn,
  resizeGroups,
  showPanel,
  toggleFirstColumn,
  type FocusDrop,
  type FocusPanel,
  type FocusState,
} from './toolLayout';

/** A small seeded random generator (the same run every time). */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PANELS: FocusPanel[] = [...FOCUS_TOOLS, 'editor', 'find', 'usages'];

function check(s: FocusState, step: string) {
  const all = s.columns.flatMap((c) => c.groups.flatMap((g) => g.panels));
  expect(new Set(all).size, `${step}: a panel twice`).toBe(all.length);
  expect(all.filter((p) => p === 'editor'), `${step}: the editor once`).toHaveLength(1);
  for (const col of s.columns) {
    expect(col.groups.length, `${step}: an empty column`).toBeGreaterThan(0);
    for (const g of col.groups) {
      expect(g.panels.length, `${step}: an empty group`).toBeGreaterThan(0);
      expect(g.panels, `${step}: the active panel not in its group`).toContain(g.active);
      expect(g.weight > 0 && Number.isFinite(g.weight), `${step}: a weight ${g.weight}`).toBe(true);
      if (g.panels.includes('editor')) {
        expect(g.panels, `${step}: the editor shares its group`).toEqual(['editor']);
        expect(g.hidden, `${step}: the editor hidden`).toBe(false);
      }
    }
    expect(Number.isFinite(col.width) && col.width >= 0, `${step}: a width ${col.width}`).toBe(true);
  }
  if (s.maximized) expect(all, `${step}: maximized but not placed`).toContain(s.maximized);
}

describe('Focus layout under random use', () => {
  it('keeps every rule through 300 sequences of 60 steps', () => {
    for (let run = 0; run < 300; run++) {
      const rnd = random(run + 1);
      const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
      let s: FocusState = FOCUS_START;
      for (let step = 0; step < 60; step++) {
        const placed = s.columns.flatMap((c) => c.groups.flatMap((g) => g.panels));
        const kind = Math.floor(rnd() * 8);
        let what = '';
        if (kind === 0) {
          const p = pick(PANELS);
          what = `show ${p}`;
          s = showPanel(s, p);
          expect(panelShown(s, p), `run ${run} step ${step}: ${what} not shown`).toBe(true);
        } else if (kind === 1) {
          const p = pick(placed);
          what = `hide ${p}`;
          s = hidePanel(s, p);
          if (p !== 'editor') expect(panelShown(s, p), `run ${run} step ${step}: ${what} still shown`).toBe(false);
        } else if (kind === 2 || kind === 3) {
          const p = pick(placed);
          const ref = pick(placed);
          const drop: FocusDrop = pick([
            { kind: 'column', ref, after: rnd() < 0.5 },
            { kind: 'stack', ref, below: rnd() < 0.5 },
            { kind: 'tab', ref },
            { kind: 'tab', ref, index: Math.floor(rnd() * 5) },
          ]);
          what = `move ${p} ${JSON.stringify(drop)}`;
          s = movePanel(s, p, drop);
        } else if (kind === 4) {
          const c = Math.floor(rnd() * s.columns.length);
          what = `resize column ${c}`;
          s = resizeColumn(s, c, (rnd() - 0.5) * 800, 1600);
        } else if (kind === 5) {
          const c = Math.floor(rnd() * s.columns.length);
          const g = Math.floor(rnd() * s.columns[c].groups.length);
          what = `resize group ${c}/${g}`;
          s = resizeGroups(s, c, g, (rnd() - 0.5) * 900, 1000);
        } else if (kind === 6) {
          what = 'sidebar button';
          s = toggleFirstColumn(s);
        } else {
          what = 'reload';
          // Results aren't kept across a reload.
          s = focusStateFrom(JSON.parse(JSON.stringify(s)));
        }
        check(s, `run ${run} step ${step}: ${what}`);
      }
    }
  }, 120_000);
});

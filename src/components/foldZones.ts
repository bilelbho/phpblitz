// Collapsed unchanged code in the diff and merge viewers: the lines are hidden, and in their place
// a wavy strip says how many, and where (namespace > class); a click shows them.

import * as monaco from 'monaco-editor';
import { structureOf } from '../php';

/** Lines [from, to] (1-based, inclusive) folded away; `key` names the stretch across panes and redraws. */
export interface Fold {
  key: string;
  from: number;
  to: number;
}

function setHiddenAreas(ed: monaco.editor.ICodeEditor, ranges: monaco.IRange[]) {
  // Monaco has it (its diff editor folds this way); its typings don't.
  (ed as unknown as { setHiddenAreas(r: monaco.IRange[]): void }).setHiddenAreas(ranges);
}

/** "\App\Models > User": where a line is, in a PHP file; '' elsewhere. */
export function contextOf(lines: string[], line: number, path: string): string {
  if (!/\.php$/i.test(path)) return '';
  const text = lines.join('\n');
  const ns = text.match(/^\s*namespace\s+([^;{\s]+)/m)?.[1];
  const cls = structureOf(text)
    .filter((s) => s.depth === 0 && s.kind !== 'function' && s.line <= line)
    .pop()?.name;
  return [ns && `\\${ns}`, cls].filter(Boolean).join(' > ');
}

/** The folds of one editor: hidden lines and the strips standing in for them. */
export class FoldZones {
  private zones: { id: string; fold: Fold; node: HTMLElement }[] = [];
  private subs: monaco.IDisposable[];
  private hovered: HTMLElement | null = null;

  constructor(
    private ed: monaco.editor.ICodeEditor,
    private path: string,
    private onExpand: (key: string) => void,
  ) {
    // The editor takes the mouse before a zone's own node sees it (and sets the cursor itself): a
    // click or hover on a strip comes as one on its view zone.
    const zoneAt = (e: monaco.editor.IEditorMouseEvent) => {
      const t = e.target;
      if (t.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE && t.type !== monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE) return null;
      return this.zones.find((z) => z.id === t.detail.viewZoneId) ?? null;
    };
    this.subs = [
      ed.onMouseDown((e) => {
        const zone = zoneAt(e);
        if (zone) onExpand(zone.fold.key);
      }),
      ed.onMouseMove((e) => this.hover(zoneAt(e)?.node ?? null)),
      ed.onMouseLeave(() => this.hover(null)),
    ];
  }

  /** The strip under the mouse: highlighted, and a pointer over the whole editor while there. */
  private hover(node: HTMLElement | null) {
    if (node === this.hovered) return;
    this.hovered?.classList.remove('hover');
    node?.classList.add('hover');
    this.hovered = node;
    this.ed.getDomNode()?.classList.toggle('fold-pointer', !!node);
  }

  private shown = '';

  /** Shows these folds (and only these); the same folds again change nothing (it's called on every edit). */
  set(folds: Fold[]) {
    const signature = JSON.stringify(folds);
    if (signature === this.shown) return;
    this.shown = signature;
    const lines = this.ed.getModel()?.getLinesContent() ?? [];
    setHiddenAreas(
      this.ed,
      folds.map((f) => new monaco.Range(f.from, 1, f.to, 1)),
    );
    const height = this.ed.getOption(monaco.editor.EditorOption.lineHeight);
    this.ed.changeViewZones((acc) => {
      for (const z of this.zones) acc.removeZone(z.id);
      this.zones = folds.map((fold) => {
        const node = document.createElement('div');
        node.className = 'fold-zone';
        node.title = 'Click to show the hidden lines';
        const where = contextOf(lines, fold.to + 1 <= lines.length ? fold.to + 1 : fold.from, this.path);
        if (where) {
          const crumbs = document.createElement('span');
          crumbs.className = 'fold-crumbs';
          crumbs.textContent = where;
          node.appendChild(crumbs);
        }
        const count = document.createElement('span');
        count.className = 'fold-count';
        const n = fold.to - fold.from + 1;
        count.textContent = `${n} hidden ${n === 1 ? 'line' : 'lines'}`;
        node.appendChild(count);
        // After the last hidden line: shown in the hidden area's place (a zone after the line before
        // it would be hidden with the lines that follow).
        const id = acc.addZone({ afterLineNumber: fold.to, heightInPx: height, domNode: node, showInHiddenAreas: true });
        return { id, fold, node };
      });
    });
  }

  /** Each fold's strip: its top, relative to the editor's visible area (for the gutter between panes). */
  places(): { key: string; top: number; height: number }[] {
    const lh = this.ed.getOption(monaco.editor.EditorOption.lineHeight);
    return this.zones.map(({ fold }) => ({
      key: fold.key,
      // Where the hidden lines were: right below the last line before them.
      top: (fold.from > 1 ? this.ed.getTopForLineNumber(fold.from - 1) + lh : 0) - this.ed.getScrollTop(),
      height: lh,
    }));
  }

  dispose() {
    this.subs.forEach((s) => s.dispose());
    this.hover(null);
    this.ed.changeViewZones((acc) => this.zones.forEach((z) => acc.removeZone(z.id)));
    this.zones = [];
    this.shown = '';
  }
}

/** A wavy line from (x0, y0) to (x1, y1), following the same S-curve as the bands. */
export function wavyPath(x0: number, y0: number, x1: number, y1: number): string {
  const steps = Math.max(8, Math.round(Math.abs(x1 - x0) / 3));
  const pts: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    // The cubic S-curve's y at t (control points at mid-width, same y as the ends).
    const y = y0 + (y1 - y0) * (3 * t * t - 2 * t * t * t);
    const x = x0 + (x1 - x0) * t;
    pts.push(`${x.toFixed(1)},${(y + 2 * Math.sin(k * Math.PI * 0.9)).toFixed(1)}`);
  }
  return `M${pts.join(' L')}`;
}

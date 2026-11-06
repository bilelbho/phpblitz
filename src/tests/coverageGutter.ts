// The editor's coverage marks: a green bar beside each line the last coverage run executed, a red
// one beside each it never reached. They follow the Coverage tool window's "show in editor".

import * as monaco from 'monaco-editor';
import { coverage } from './coverage';

export function setupCoverageGutter(editor: monaco.editor.IStandaloneCodeEditor, pathOf: () => string) {
  const deco = editor.createDecorationsCollection();
  let shownFor: unknown = null;
  const paint = () => {
    const file = coverage.of(pathOf());
    // Lines move with edits (decorations stick to them): repaint only for a new report.
    if (file === shownFor) return;
    shownFor = file;
    if (!file) return deco.clear();
    const max = editor.getModel()?.getLineCount() ?? 0;
    deco.set(
      [...file.lines]
        .filter(([line]) => line <= max)
        .map(([line, hits]) => ({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            linesDecorationsClassName: `cov-mark ${hits ? 'cov-hit' : 'cov-miss'}`,
            linesDecorationsTooltip: hits ? `Covered: run ${hits} time${hits === 1 ? '' : 's'}` : 'Not covered by the tests',
            overviewRuler: hits ? undefined : { color: 'rgba(219, 92, 92, 0.6)', position: monaco.editor.OverviewRulerLane.Left },
          },
        })),
    );
  };
  paint();
  const unsubscribe = coverage.subscribe(paint);
  const sub = editor.onDidChangeModel(() => {
    shownFor = null;
    paint();
  });
  editor.onDidDispose(() => {
    unsubscribe();
    sub.dispose();
  });
}

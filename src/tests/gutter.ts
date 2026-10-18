// The editor's test icons: ▶ in the gutter beside each test class, test method
// and Pest test, turning green or red with its last result. Clicking one offers Run / Debug.

import * as monaco from 'monaco-editor';
import type { ContextItem } from '../components/ContextMenu';
import { findTests, testAt, type FoundTest } from './discover';
import { resultKey, testRunner, type Scope } from './runner';
import type { TestStatus } from './teamcity';

/** Files that hold tests: under a tests/ folder, or named *Test.php. */
export const isTestFile = (path: string) => /\.php$/i.test(path) && (/\/tests?\//i.test(path) || /Test\.php$/.test(path));

export function testsOf(path: string, text: string): FoundTest[] {
  return isTestFile(path) ? findTests(text) : [];
}

export function statusOf(path: string, t: FoundTest): TestStatus | undefined {
  return testRunner.results.get(t.kind === 'class' ? resultKey(path, t.className) : t.kind === 'method' ? resultKey(path, t.className, t.testName) : resultKey(path, undefined, t.testName));
}

export const scopeOf = (path: string, t: FoundTest): Scope => ({ kind: 'test', path, test: t });

/** The gutter icon's menu (and the editor's Run / Debug items for the test at the caret). */
export function testMenuItems(run: (scope: Scope, opts?: { debug?: boolean }) => void, path: string, t: FoundTest): ContextItem[] {
  const name = testRunner.label(scopeOf(path, t), 'phpunit');
  return [
    { label: `Run '${name}'`, icon: 'run', shortcut: 'Ctrl+Shift+F10', run: () => run(scopeOf(path, t)) },
    { label: `Debug '${name}'`, icon: 'bug', run: () => run(scopeOf(path, t), { debug: true }) },
  ];
}

export function setupTestGutter(editor: monaco.editor.IStandaloneCodeEditor, pathOf: () => string) {
  const deco = editor.createDecorationsCollection();
  let found: FoundTest[] = [];
  let shown = '';

  const paint = () => {
    const path = pathOf();
    const decorations = found.map((t): monaco.editor.IModelDeltaDecoration => {
      const status = statusOf(path, t);
      const state = status === 'failed' || status === 'error' ? ' test-failed' : status === 'passed' ? ' test-passed' : status === 'ignored' ? ' test-ignored' : '';
      return {
        range: new monaco.Range(t.line, 1, t.line, 1),
        options: {
          glyphMarginClassName: `test-glyph${t.kind === 'class' ? ' test-class' : ''}${state}`,
          glyphMarginHoverMessage: { value: `Run '${testRunner.label(scopeOf(path, t), 'phpunit')}'${status ? ` (last run: ${status})` : ''}` },
        },
      };
    });
    // The runner reports often while it runs: repaint only when something shown changed.
    const key = JSON.stringify(decorations.map((d) => [d.range.startLineNumber, d.options.glyphMarginClassName]));
    if (key === shown) return;
    shown = key;
    deco.set(decorations);
  };
  const scan = () => {
    const model = editor.getModel();
    found = model ? testsOf(pathOf(), model.getValue()) : [];
    paint();
  };

  scan();
  let timer = 0;
  const content = editor.onDidChangeModelContent(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(scan, 300);
  });
  const model = editor.onDidChangeModel(scan);
  const unsubscribe = testRunner.subscribe(paint);

  return {
    /** The test whose icon is on this line. */
    iconAt: (line: number) => found.find((t) => t.line === line) ?? null,
    /** The innermost test around a line (Ctrl+Shift+F10 at the caret). */
    around: (line: number) => testAt(found, line),
    hasTests: () => found.length > 0,
    dispose() {
      window.clearTimeout(timer);
      content.dispose();
      model.dispose();
      unsubscribe();
      deco.clear();
    },
  };
}

export type TestGutter = ReturnType<typeof setupTestGutter>;

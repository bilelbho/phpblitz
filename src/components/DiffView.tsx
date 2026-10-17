// Side-by-side diff in an editor tab: HEAD vs your version (editable, same document as the
// editor), or a commit vs its parent. F7 / Shift+F7 jump between changes.

import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { languageOf } from '../php';
import { baseName, relativePath } from '../backend/types';
import { useSettings } from '../settings';
import { themeId } from '../editor/themes';
import { Icon } from './Icon';

export function DiffView({ ws, path, commit }: { ws: Workspace; path: string; commit?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  const [counts, setCounts] = useState<{ changes: number } | null>(null);
  const settings = useSettings().editor;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const owned: monaco.IDisposable[] = [];
    const diff = monaco.editor.createDiffEditor(el, {
      automaticLayout: true,
      renderSideBySide: !inline,
      originalEditable: false,
      readOnly: !!commit,
      fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
      fontSize: settings.fontSize,
      lineHeight: Math.round(settings.fontSize * settings.lineHeight),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: false },
      contextmenu: false,
    });
    editorRef.current = diff;
    const language = languageOf(path);

    (async () => {
      try {
        let left: string | null;
        let right: monaco.editor.ITextModel;
        if (commit) {
          left = await ws.gitRepo.show(`${commit}^`, path);
          const after = await ws.gitRepo.show(commit, path);
          right = monaco.editor.createModel(after ?? '', language, monaco.Uri.parse(`inmemory://diff/${commit}/${encodeURIComponent(path)}`));
          owned.push(right);
        } else {
          left = await ws.gitRepo.head(path);
          // Your version: the editor's own document when the file is open, so edits here are real edits.
          const existing = monaco.editor.getModel(monaco.Uri.file(path));
          if (existing) right = existing;
          else {
            const text = ws.liveTextOf(path) ?? (await ws.backend.readFile(path).catch(() => ''));
            right = monaco.editor.createModel(text, language, monaco.Uri.parse(`inmemory://diff/working/${encodeURIComponent(path)}`));
            owned.push(right);
            diff.updateOptions({ readOnly: true });
          }
          owned.push(right.onDidChangeContent(() => ws.onEdit(path, right.getValue())));
        }
        const original = monaco.editor.createModel(left ?? '', language, monaco.Uri.parse(`inmemory://diff/base/${commit ?? 'HEAD'}/${encodeURIComponent(path)}`));
        owned.push(original);
        if (disposed) return;
        diff.setModel({ original, modified: right });
        const update = () => setCounts({ changes: diff.getLineChanges()?.length ?? 0 });
        owned.push(diff.onDidUpdateDiff(update));
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();

    return () => {
      disposed = true;
      diff.setModel(null);
      diff.dispose();
      owned.forEach((d) => d.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, commit]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: !inline });
  }, [inline]);

  const go = (dir: 1 | -1) => {
    const diff = editorRef.current;
    if (!diff) return;
    const changes = diff.getLineChanges() ?? [];
    const ed = diff.getModifiedEditor();
    const line = ed.getPosition()?.lineNumber ?? 1;
    const starts = changes.map((c) => Math.max(1, c.modifiedStartLineNumber));
    const target = dir === 1 ? starts.find((s) => s > line) ?? starts[0] : [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1];
    if (target === undefined) return;
    ed.setPosition({ lineNumber: target, column: 1 });
    ed.revealLineInCenter(target);
    ed.focus();
  };

  return (
    <div
      className="diff-view"
      onKeyDown={(e) => {
        if (e.key === 'F7') {
          e.preventDefault();
          go(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="tw-toolbar diff-toolbar">
        <button type="button" className="icon-btn small" title="Previous Difference (Shift+F7)" aria-label="Previous difference" onClick={() => go(-1)}>
          <Icon name="chevronUp" size={13} />
        </button>
        <button type="button" className="icon-btn small" title="Next Difference (F7)" aria-label="Next difference" onClick={() => go(1)}>
          <Icon name="chevronDown" size={13} />
        </button>
        <span className="te-sep" />
        <button type="button" className={'btn small ghost' + (inline ? '' : ' on')} onClick={() => setInline((v) => !v)} title="Side-by-side or unified">
          <Icon name="columns" size={13} />
          {inline ? 'Unified' : 'Side-by-side'}
        </button>
        {!commit && (
          <button type="button" className="btn small ghost" onClick={() => ws.openFile(path)}>
            <Icon name="goTo" size={13} />
            Jump to Source
          </button>
        )}
        <span className="grow" />
        <span className="muted diff-title">
          {counts ? `${counts.changes} ${counts.changes === 1 ? 'difference' : 'differences'} · ` : ''}
          {commit ? `${commit.slice(0, 8)}^ vs ${commit.slice(0, 8)}` : 'HEAD vs Your version'} · {relativePath(ws.backend, path)}
        </span>
      </div>
      <div className="diff-heads">
        <span>{commit ? `${baseName(path)} (${commit.slice(0, 8)}^)` : `${baseName(path)} (HEAD)`}</span>
        {!inline && <span>{commit ? `${baseName(path)} (${commit.slice(0, 8)})` : 'Your version'}</span>}
      </div>
      {error && <div className="te-error"><pre>{error}</pre></div>}
      <div ref={host} className="diff-host" data-theme={themeId(settings.scheme)} />
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { FileStructurePopup, FindBar, GotoLineDialog, type FindRequest } from './EditorPopups';
import { setEditorCommands } from '../editorCommands';
import { buildEditorMenu, codeActionsForSelection, contextActionsMenu, copyText, generateMenu, hasMagoActionsAtCaret, markersAt, quickFixesFor, referenceAt } from '../editorMenu';
import { EditorHover, type HoverRequest } from './EditorHover';
import { MarkdownView, runCodeBlock, shellBlocks } from './MarkdownView';
import { IntentionPopup } from './IntentionPopup';
import { useSettings, getSettings } from '../settings';
import { themeId } from '../editor/themes';
import { setUsagesHandler } from '../monaco';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { languageOf } from '../php';
import { SAMPLE_DB } from '../mock';
import { Badge, Icon, fileBadge } from './Icon';

export function EditorArea({ ws }: { ws: Workspace }) {
  const tab = ws.activeTab;
  return (
    <section className="island" style={{ flex: '1 1 auto' }} aria-label="Editor">
      {ws.tabs.length > 0 && <div className="tabs" role="tablist" aria-label="Open files">
        {ws.tabs.map((t) => {
          const isFile = t.kind === 'file';
          const name = isFile ? baseName(t.path) : t.table;
          const badge = isFile ? fileBadge(t.path) : { text: 'T', color: '#5fc9be' };
          const active = t.id === ws.activeId;
          const dirty = isFile && ws.dirty.has(t.path);
          const preview = isFile && !!t.preview;
          return (
            <div key={t.id} className={'tab' + (active ? ' active' : '') + (dirty ? ' dirty' : '') + (preview ? ' preview' : '')}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="tab-main"
                onClick={() => ws.setActiveId(t.id)}
                onDoubleClick={() => ws.pinTab(t.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    ws.closeTab(t.id);
                  }
                }}
                title={
                  (isFile ? relativePath(ws.backend, t.path) : `${SAMPLE_DB.schema}.${t.table}`) + (preview ? '\nPreview tab: double-click to keep it open' : '')
                }
              >
                <Badge text={badge.text} color={badge.color} />
                {name}
                {dirty && <span className="dirty-mark" aria-label="unsaved changes">*</span>}
              </button>
              <button type="button" className="icon-btn small tab-close" aria-label={`Close ${name}`} title={dirty ? 'Unsaved changes. Close' : 'Close'} onClick={() => ws.closeTab(t.id)}>
                <Icon name="close" size={10} strokeWidth={2.5} />
              </button>
            </div>
          );
        })}
      </div>}

      {tab?.kind === 'file' && ws.loaded[tab.path] !== undefined && (
        <div className="editor-host">
          {/\.(md|markdown)$/i.test(tab.path) ? (
            <MarkdownView key={tab.path} ws={ws} path={tab.path}>
              {(onEditor) => <CodeEditor ws={ws} path={tab.path} onEditor={onEditor} />}
            </MarkdownView>
          ) : (
            <CodeEditor ws={ws} path={tab.path} />
          )}
        </div>
      )}
      {tab?.kind === 'file' && ws.loaded[tab.path] === undefined && <div className="editor-empty">Loading…</div>}
      {tab?.kind === 'table' && <TableView table={tab.table} />}
      {!tab && (
        <div className="editor-empty">
          <div className="shortcut-row">
            <span>Search Everywhere</span>
            <span>Double Shift</span>
            <span>Go to File</span>
            <span>Ctrl+Shift+N</span>
            <span>Go to Class</span>
            <span>Ctrl+N</span>
            <span>Commit</span>
            <span>Ctrl+K</span>
          </div>
        </div>
      )}
    </section>
  );
}

/** JetBrains' top-right editor widget: problem counts with previous/next arrows. */
function Inspections({ ws, path, editor }: { ws: Workspace; path: string; editor: monaco.editor.IStandaloneCodeEditor | null }) {
  const list = ws.problems[path] ?? [];
  const errors = list.filter((p) => p.severity === 'error').length;
  const warnings = list.filter((p) => p.severity === 'warning').length;
  const weak = list.length - errors - warnings;
  const jump = (dir: 'next' | 'prev') => {
    editor?.focus();
    editor?.trigger('phpblitz', dir === 'next' ? 'editor.action.marker.next' : 'editor.action.marker.prev', {});
  };
  return (
    <div className="inspections" aria-label={`${errors} errors, ${warnings} warnings`}>
      {errors > 0 && (
        <span className="count" style={{ color: '#f75464' }}>
          <Icon name="error" size={13} /> {errors}
        </span>
      )}
      {warnings > 0 && (
        <span className="count" style={{ color: '#e5a33d' }}>
          <Icon name="warning" size={13} /> {warnings}
        </span>
      )}
      {weak > 0 && (
        <span className="count" style={{ color: '#a8adbd' }} title="Weak warnings">
          <Icon name="warning" size={13} /> {weak}
        </span>
      )}
      {list.length === 0 && (
        <span className="count" style={{ color: '#5fb865' }} title="No problems found">
          <Icon name="check" size={14} strokeWidth={2.5} />
        </span>
      )}
      <button type="button" className="icon-btn small" aria-label="Previous problem" title="Previous Highlighted Error" onClick={() => jump('prev')} disabled={!list.length}>
        <Icon name="chevronUp" size={12} strokeWidth={2.2} />
      </button>
      <button type="button" className="icon-btn small" aria-label="Next problem" title="Next Highlighted Error (F2)" onClick={() => jump('next')} disabled={!list.length}>
        <Icon name="chevronDown" size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}

/** Screen position just below the caret, for popups opened from the keyboard. */
function caretPoint(editor: monaco.editor.IStandaloneCodeEditor) {
  const rect = editor.getDomNode()!.getBoundingClientRect();
  const pos = editor.getPosition();
  const c = pos && editor.getScrolledVisiblePosition(pos);
  return c ? { x: rect.left + c.left, y: rect.top + c.top + c.height } : { x: rect.left + 60, y: rect.top + 40 };
}

function CodeEditor({ ws, path, onEditor }: { ws: Workspace; path: string; onEditor?: (editor: monaco.editor.IStandaloneCodeEditor) => void }) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const [ready, setReady] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  /** Alt+Enter / Alt+Insert / lightbulb popup. */
  const [intentions, setIntentions] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const closeIntentions = useCallback(() => {
    setIntentions(null);
    editorRef.current?.focus();
  }, []);
  const settings = useSettings().editor;
  /** PhpStorm-style hover / F2 / Ctrl+Q popup. */
  const [hover, setHover] = useState<HoverRequest | null>(null);
  const hoverTimer = useRef(0);
  /**
   * Whether the pointer is over the popup. React's mouseenter on the popup runs before the editor's
   * mouseleave, which schedules a close, so closing checks this instead of relying on the timer being cleared.
   */
  const pointerInHover = useRef(false);
  const closeHover = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    pointerInHover.current = false;
    setHover(null);
  }, []);
  const moreActions = useRef<(line: number, column: number) => void>(() => {});
  const [find, setFind] = useState<FindRequest | null>(null);
  const [findStep, setFindStep] = useState<{ dir: 1 | -1; nonce: number } | null>(null);
  const [popup, setPopup] = useState<'goto' | 'structure' | null>(null);
  const closePopup = useCallback(() => setPopup(null), []);
  // Monaco callbacks are registered once; read the latest props through a ref.
  const latest = useRef({ ws, path });
  latest.current = { ws, path };

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    onEditor?.(editor);
    setupMarkdown(editor);
    decorations.current = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.ws.save(latest.current.path));

    // JetBrains keymap for the language-server features.
    const { KeyMod, KeyCode } = monaco;
    const run = (id: string) => () => editor.trigger('phpblitz', id, {});
    editor.addAction({
      id: 'phpblitz.findUsages',
      label: 'Find Usages',
      keybindings: [KeyMod.Alt | KeyCode.F7, KeyMod.Shift | KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: (ed) => {
        const model = ed.getModel();
        const pos = ed.getPosition();
        if (model && pos) latest.current.ws.findUsagesAt(model, pos);
      },
    });
    editor.addAction({ id: 'phpblitz.gotoDeclaration', label: 'Go to Declaration', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyB], run: run('editor.action.revealDefinition') });
    editor.addAction({ id: 'phpblitz.gotoImplementation', label: 'Go to Implementation', keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyB], run: run('editor.action.goToImplementation') });
    editor.addAction({ id: 'phpblitz.rename', label: 'Rename…', keybindings: [KeyMod.Shift | KeyCode.F6], run: run('editor.action.rename') });
    editor.addAction({ id: 'phpblitz.reformat', label: 'Reformat Code', keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyL], run: run('editor.action.formatDocument') });
    // ── Hover popup: problems with their quick fix, and documentation ──
    /** Screen box of the word at `pos`, for placing the popup under it. */
    const wordBox = (pos: monaco.IPosition) => {
      const rect = editor.getDomNode()!.getBoundingClientRect();
      const word = editor.getModel()?.getWordAtPosition(pos);
      const c = editor.getScrolledVisiblePosition(word ? { lineNumber: pos.lineNumber, column: word.startColumn } : pos);
      return c ? { x: rect.left + c.left, top: rect.top + c.top, bottom: rect.top + c.top + c.height } : null;
    };
    const showHoverAt = (pos: monaco.IPosition, source: HoverRequest['source'], docOnly = false) => {
      const box = wordBox(pos);
      if (box) setHover({ line: pos.lineNumber, column: pos.column, ...box, source, docOnly });
    };
    let hoverKey = '';
    const closeMouseHover = () => {
      if (!pointerInHover.current) setHover((h) => (h?.source === 'mouse' ? null : h));
    };
    editor.onMouseMove((e) => {
      const pos = e.target.position;
      const onText = e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && pos ? pos : null;
      const word = onText && editor.getModel()?.getWordAtPosition(onText);
      const key = onText ? `${onText.lineNumber}:${word ? word.startColumn : onText.column}` : '';
      if (key === hoverKey) return;
      hoverKey = key;
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(() => {
        if (pointerInHover.current) return; // moving through text on the way into the popup
        if (onText) showHoverAt(onText, 'mouse');
        else closeMouseHover();
      }, onText ? 550 : 300);
    });
    editor.onMouseLeave(() => {
      hoverKey = '';
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(closeMouseHover, 300);
    });
    editor.addAction({
      id: 'phpblitz.quickDoc',
      label: 'Quick Documentation',
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyQ],
      run: () => {
        const pos = editor.getPosition();
        if (pos) showHoverAt(pos, 'keyboard', true);
      },
    });
    // F2 / Shift+F2: next / previous problem, with its popup (PhpStorm's Next Highlighted Error).
    const jumpToProblem = (dir: 1 | -1) => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos) return;
      const markers = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
      if (!markers.length) return;
      const after = (m: monaco.editor.IMarker) => m.startLineNumber > pos.lineNumber || (m.startLineNumber === pos.lineNumber && m.startColumn > pos.column);
      const before = (m: monaco.editor.IMarker) => m.startLineNumber < pos.lineNumber || (m.startLineNumber === pos.lineNumber && m.startColumn < pos.column);
      const next = dir === 1 ? markers.find(after) ?? markers[0] : [...markers].reverse().find(before) ?? markers[markers.length - 1];
      const at = { lineNumber: next.startLineNumber, column: next.startColumn };
      editor.setPosition(at);
      editor.revealPositionInCenterIfOutsideViewport(at);
      // After the caret move, so the popup doesn't close right away.
      setTimeout(() => showHoverAt(at, 'keyboard'), 0);
    };
    editor.addAction({ id: 'phpblitz.nextProblem', label: 'Next Highlighted Error', keybindings: [KeyCode.F2], run: () => jumpToProblem(1) });
    editor.addAction({ id: 'phpblitz.prevProblem', label: 'Previous Highlighted Error', keybindings: [KeyMod.Shift | KeyCode.F2], run: () => jumpToProblem(-1) });
    // Alt+Shift+Enter: apply the first quick fix of the problem at the caret.
    editor.addAction({
      id: 'phpblitz.applyFirstFix',
      label: 'Apply First Quick Fix',
      keybindings: [KeyMod.Alt | KeyMod.Shift | KeyCode.Enter],
      run: async () => {
        const model = editor.getModel();
        const pos = editor.getPosition();
        const marker = model && pos ? markersAt(model, pos)[0] : undefined;
        const { ws, path } = latest.current;
        const fix = marker && (await quickFixesFor(editor, ws, path, marker))[0];
        if (fix) fix.run();
        else popupActions('context');
      },
    });
    editor.addAction({ id: 'phpblitz.paramInfo', label: 'Parameter Info', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyP], run: run('editor.action.triggerParameterHints') });
    editor.addAction({ id: 'phpblitz.typeDeclaration', label: 'Go to Type Declaration', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyB], run: run('editor.action.goToTypeDefinition') });
    editor.addAction({ id: 'phpblitz.columnSelection', label: 'Column Selection Mode', keybindings: [KeyMod.Alt | KeyMod.Shift | KeyCode.Insert], run: run('editor.action.toggleColumnSelection') });
    editor.addAction({ id: 'phpblitz.expand', label: 'Expand', keybindings: [KeyMod.CtrlCmd | KeyCode.NumpadAdd], run: run('editor.unfold') });
    editor.addAction({ id: 'phpblitz.collapse', label: 'Collapse', keybindings: [KeyMod.CtrlCmd | KeyCode.NumpadSubtract], run: run('editor.fold') });
    editor.addAction({ id: 'phpblitz.expandAll', label: 'Expand All', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.NumpadAdd], run: run('editor.unfoldAll') });
    editor.addAction({ id: 'phpblitz.collapseAll', label: 'Collapse All', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.NumpadSubtract], run: run('editor.foldAll') });
    editor.addAction({ id: 'phpblitz.runTests', label: 'Run Tests', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F10], run: () => latest.current.ws.runTests() });
    editor.addAction({ id: 'phpblitz.copyPath', label: 'Copy Absolute Path', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyC], run: () => copyText(latest.current.ws, latest.current.path, 'path') });
    editor.addAction({
      id: 'phpblitz.copyReference',
      label: 'Copy Reference',
      keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyC],
      run: (ed) => {
        const ref = referenceAt(ed as monaco.editor.IStandaloneCodeEditor);
        if (ref) copyText(latest.current.ws, ref, 'reference');
      },
    });
    // Ctrl+K is a chord prefix in Monaco; take it back for Commit like PhpStorm.
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyK, () => latest.current.ws.showLeft('commit'));

    // ── Lightbulb: shown on the caret line when Alt+Enter has something to offer ──
    const bulb = document.createElement('div');
    bulb.className = 'pb-bulb';
    bulb.title = 'Show Context Actions (Alt+Enter)';
    bulb.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 0-2.7 8.1c.4.3.7.8.7 1.3V12h4v-1.1c0-.5.3-1 .7-1.3A4.5 4.5 0 0 0 8 1.5Z" fill="#F2C55C"/><path d="M6 13.2h4M6.6 14.6h2.8" stroke="#CED0D6" stroke-width="1.2" stroke-linecap="round"/></svg>' +
      '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3 4 5.5 6.5 3" stroke="#A8ADBD" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>';
    let bulbLine = 0;
    const bulbWidget: monaco.editor.IContentWidget = {
      getId: () => 'phpblitz.lightbulb',
      getDomNode: () => bulb,
      getPosition: () => (bulbLine ? { position: { lineNumber: bulbLine, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] } : null),
    };
    editor.addContentWidget(bulbWidget);
    const showBulb = (line: number) => {
      bulbLine = line;
      // Inside the indentation when there is room, else just left of the text.
      const indent = line ? editor.getModel()!.getLineFirstNonWhitespaceColumn(line) - 1 : 0;
      bulb.classList.toggle('in-gutter', indent < 3);
      editor.layoutContentWidget(bulbWidget);
    };
    let bulbTimer = 0;
    let bulbRequest = 0;
    const updateBulb = () => {
      window.clearTimeout(bulbTimer);
      showBulb(0);
      if (!getSettings().editor.lightbulb) return;
      bulbTimer = window.setTimeout(async () => {
        const pos = editor.getPosition();
        if (!pos) return;
        const request = ++bulbRequest;
        const { ws, path } = latest.current;
        const has = hasMagoActionsAtCaret(editor, ws, path) || (await codeActionsForSelection(editor)).length > 0;
        if (request === bulbRequest && has && editor.getPosition()?.lineNumber === pos.lineNumber) showBulb(pos.lineNumber);
      }, 450);
    };
    editor.onDidChangeCursorPosition(updateBulb);
    editor.onDidChangeModelContent(() => showBulb(0));
    editor.onDidBlurEditorText(() => window.clearTimeout(bulbTimer));

    // Alt+Enter and Alt+Insert: the actions in PhpStorm's intention popup, below the bulb when it shows.
    const popupPoint = () => {
      if (bulbLine && bulbLine === editor.getPosition()?.lineNumber) {
        const r = bulb.getBoundingClientRect();
        if (r.width) return { x: r.left, y: r.bottom + 2 };
      }
      return caretPoint(editor);
    };
    const popupActions = async (kind: 'context' | 'generate') => {
      const actions = await codeActionsForSelection(editor);
      const { ws, path } = latest.current;
      const uri = editor.getModel()?.uri.toString();
      setIntentions({ ...popupPoint(), items: kind === 'context' ? contextActionsMenu(actions, ws, { editor, path }) : generateMenu(actions, ws, uri) });
    };
    bulb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      popupActions('context');
    });
    moreActions.current = (line, column) => {
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
      popupActions('context');
    };
    // "N usages" above declarations runs Find Usages.
    setUsagesHandler((model, position) => latest.current.ws.findUsagesAt(model, position));
    editor.addAction({ id: 'phpblitz.contextActions', label: 'Show Context Actions', keybindings: [KeyMod.Alt | KeyCode.Enter], run: () => popupActions('context') });
    editor.addAction({ id: 'phpblitz.generate', label: 'Generate…', keybindings: [KeyMod.Alt | KeyCode.Insert], run: () => popupActions('generate') });

    // Our PhpStorm-style right-click menu instead of Monaco's.
    editor.onContextMenu(async (e) => {
      e.event.preventDefault();
      const pos = e.target.position;
      const sel = editor.getSelection();
      if (pos && sel && !sel.containsPosition(pos)) editor.setPosition(pos);
      const point = { x: e.event.posx, y: e.event.posy };
      const actions = await codeActionsForSelection(editor);
      const { ws, path } = latest.current;
      setMenu({
        ...point,
        items: buildEditorMenu(editor, ws, path, actions, {
          contextActions: () => setIntentions({ ...popupPoint(), items: contextActionsMenu(actions, ws, { editor, path: latest.current.path }) }),
          generate: () => setIntentions({ ...popupPoint(), items: generateMenu(actions, ws, editor.getModel()?.uri.toString()) }),
          gotoLine: () => setPopup('goto'),
        }),
      });
    });

    // PhpStorm popups instead of Monaco's VS Code quick input and find widget.
    const openFind = (replace: boolean) => {
      const sel = editor.getSelection();
      const text = sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber ? editor.getModel()!.getValueInRange(sel) : '';
      setFind({ replace, seed: text, nonce: Date.now() });
    };
    editor.addAction({ id: 'phpblitz.find', label: 'Find…', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyF], run: () => openFind(false) });
    editor.addAction({ id: 'phpblitz.replace', label: 'Replace…', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyR], run: () => openFind(true) });
    const selectionText = () => {
      const sel = editor.getSelection();
      return sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber ? editor.getModel()!.getValueInRange(sel) : '';
    };
    editor.addAction({ id: 'phpblitz.findInFiles', label: 'Find in Files…', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF], run: () => latest.current.ws.openFindInFiles('find', selectionText()) });
    editor.addAction({ id: 'phpblitz.replaceInFiles', label: 'Replace in Files…', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR], run: () => latest.current.ws.openFindInFiles('replace', selectionText()) });
    editor.addAction({ id: 'phpblitz.findNext', label: 'Find Next', keybindings: [KeyCode.F3], run: () => setFindStep({ dir: 1, nonce: Date.now() }) });
    editor.addAction({ id: 'phpblitz.findPrev', label: 'Find Previous', keybindings: [KeyMod.Shift | KeyCode.F3], run: () => setFindStep({ dir: -1, nonce: Date.now() }) });
    editor.addAction({ id: 'phpblitz.gotoLine', label: 'Go to Line:Column…', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyG], run: () => setPopup('goto') });
    editor.addAction({ id: 'phpblitz.fileStructure', label: 'File Structure', keybindings: [KeyMod.CtrlCmd | KeyCode.F12], run: () => setPopup('structure') });
    editor.addAction({ id: 'phpblitz.findAction', label: 'Find Action…', keybindings: [KeyCode.F1, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA], run: () => latest.current.ws.openSearch('actions') });

    // What Find Action (Ctrl+Shift+A) can run in this editor.
    const trigger = (id: string) => () => {
      editor.focus();
      editor.trigger('phpblitz', id, {});
    };
    setEditorCommands(() => [
      { label: 'Find…', shortcut: 'Ctrl+F', run: () => openFind(false) },
      { label: 'Replace…', shortcut: 'Ctrl+R', run: () => openFind(true) },
      { label: 'Find in Files…', shortcut: 'Ctrl+Shift+F', run: () => latest.current.ws.openFindInFiles('find', selectionText()) },
      { label: 'Replace in Files…', shortcut: 'Ctrl+Shift+R', run: () => latest.current.ws.openFindInFiles('replace', selectionText()) },
      { label: 'Go to Line:Column…', shortcut: 'Ctrl+G', run: () => setPopup('goto') },
      { label: 'File Structure', shortcut: 'Ctrl+F12', run: () => setPopup('structure') },
      { label: 'Find Usages', shortcut: 'Alt+F7', run: trigger('phpblitz.findUsages') },
      { label: 'Rename…', shortcut: 'Shift+F6', run: trigger('editor.action.rename') },
      { label: 'Show Context Actions', shortcut: 'Alt+Enter', run: () => popupActions('context') },
      { label: 'Generate…', shortcut: 'Alt+Insert', run: () => popupActions('generate') },
      { label: 'Reformat Code', shortcut: 'Ctrl+Alt+L', run: trigger('editor.action.formatDocument') },
      { label: 'Go to Declaration', shortcut: 'Ctrl+B', run: trigger('editor.action.revealDefinition') },
      { label: 'Copy Reference', shortcut: 'Ctrl+Alt+Shift+C', run: trigger('phpblitz.copyReference') },
      { label: 'Collapse All', shortcut: 'Ctrl+Shift+NumPad -', run: trigger('editor.foldAll') },
      { label: 'Expand All', shortcut: 'Ctrl+Shift+NumPad +', run: trigger('editor.unfoldAll') },
      { label: 'Comment with Line Comment', shortcut: 'Ctrl+/', run: trigger('editor.action.commentLine') },
      { label: 'Duplicate Line or Selection', shortcut: 'Ctrl+D', run: trigger('editor.action.copyLinesDownAction') },
    ]);
    editor.onDidDispose(() => setEditorCommands(null));
    editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position && /\.(md|markdown)$/i.test(latest.current.path)) {
        // Markdown: ▷ beside a shell code block runs it.
        const block = shellBlocks(editor.getModel()?.getValue() ?? '').find((b) => b.line === e.target.position!.lineNumber);
        if (block) runCodeBlock(latest.current.ws, block.code);
      } else if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        latest.current.ws.toggleBreakpoint(latest.current.path, e.target.position.lineNumber);
      }
    });
    editor.onDidChangeCursorPosition((e) => latest.current.ws.setCursor({ line: e.position.lineNumber, col: e.position.column }));
    setReady(true);
  };

  // Breakpoints
  useEffect(() => {
    if (!ready) return;
    const lines = ws.breakpoints[path] ?? [];
    decorations.current?.set(
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, glyphMarginClassName: 'bp-glyph', className: 'bp-line', glyphMarginHoverMessage: { value: 'Breakpoint' } },
      })),
    );
  }, [ready, path, ws.breakpoints]);

  // Problems → squiggles
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!ready || !model) return;
    const count = model.getLineCount();
    monaco.editor.setModelMarkers(
      model,
      'phpblitz',
      (ws.problems[path] ?? []).map((p) => {
        const line = Math.min(Math.max(p.line, 1), count);
        const endLine = Math.min(Math.max(p.endLine ?? line, line), count);
        // Exact range when the checker gives one; otherwise underline the line's code.
        const precise = p.column !== undefined && p.endColumn !== undefined && !(endLine === line && p.endColumn <= p.column);
        return {
          startLineNumber: line,
          endLineNumber: precise ? endLine : line,
          startColumn: precise ? p.column! : model.getLineFirstNonWhitespaceColumn(line) || 1,
          endColumn: precise ? p.endColumn! : model.getLineMaxColumn(line),
          message: p.help ? `${p.message}\n\n${p.help}` : p.message,
          code: p.code,
          source: p.source,
          severity: p.severity === 'error' ? monaco.MarkerSeverity.Error : p.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        };
      }),
    );
  }, [ready, path, ws.problems]);

  // Jump to a line (from Structure, Problems, Endpoints, Search…)
  useEffect(() => {
    const g = ws.goto;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!ready || !g || g.path !== path || !editor || !model) return;
    let line = g.line ?? 1;
    if (g.find) {
      const re = new RegExp(g.find);
      const i = model.getLinesContent().findIndex((l) => re.test(l));
      if (i >= 0) line = i + 1;
    }
    line = Math.min(Math.max(line, 1), model.getLineCount());
    const text = model.getLineContent(line);
    // A dangling `->` means "finish this expression": put the caret there and offer completion.
    const dangling = !g.column && /->\s*$/.test(text);
    const column = g.column ?? (dangling ? model.getLineMaxColumn(line) : model.getLineFirstNonWhitespaceColumn(line) || 1);
    editor.setPosition({ lineNumber: line, column });
    editor.revealLineInCenter(line);
    editor.focus();
    if (dangling) editor.trigger('phpblitz', 'editor.action.triggerSuggest', {});
    ws.setGoto(null);
  }, [ready, path, ws.goto, ws]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    {ready && find && editorRef.current && <FindBar editor={editorRef.current} request={find} step={findStep} onClose={() => setFind(null)} />}
    <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
    {ready && path.endsWith('.php') && <Inspections ws={ws} path={path} editor={editorRef.current} />}
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    {hover && editorRef.current && (
      <div
        onMouseEnter={() => {
          pointerInHover.current = true;
          window.clearTimeout(hoverTimer.current);
        }}
        onMouseLeave={() => {
          pointerInHover.current = false;
          if (hover.source === 'mouse') hoverTimer.current = window.setTimeout(closeHover, 300);
        }}
      >
        <EditorHover
          editor={editorRef.current}
          ws={ws}
          path={path}
          request={hover}
          onClose={closeHover}
          onEmpty={closeHover}
          onMoreActions={() => moreActions.current(hover.line, hover.column)}
        />
      </div>
    )}
    {intentions && <IntentionPopup x={intentions.x} y={intentions.y} items={intentions.items} model={editorRef.current?.getModel() ?? null} onClose={closeIntentions} />}
    {popup === 'goto' && editorRef.current && <GotoLineDialog editor={editorRef.current} onClose={closePopup} />}
    {popup === 'structure' && editorRef.current && (
      <FileStructurePopup editor={editorRef.current} fileName={path.split('/').pop() ?? path} symbols={ws.structure} onClose={closePopup} />
    )}
    <Editor
      path={monaco.Uri.file(path).toString()}
      defaultValue={ws.loaded[path]}
      defaultLanguage={languageOf(path)}
      theme={themeId(settings.scheme)}
      keepCurrentModel
      onMount={onMount}
      onChange={(value) => ws.onEdit(path, value ?? '')}
      loading={<div className="empty">Loading editor…</div>}
      options={{
        fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
        fontSize: settings.fontSize,
        lineHeight: Math.round(settings.fontSize * settings.lineHeight),
        fontLigatures: settings.ligatures,
        codeLens: settings.codeVision,
        codeLensFontFamily: 'Inter, sans-serif',
        codeLensFontSize: 12,
        glyphMargin: true,
        lineNumbersMinChars: 4,
        lineDecorationsWidth: 14,
        folding: true,
        showFoldingControls: 'mouseover',
        minimap: { enabled: false },
        scrollBeyondLastLine: true,
        automaticLayout: true,
        renderLineHighlight: 'line',
        smoothScrolling: true,
        cursorBlinking: 'blink',
        padding: { top: 6 },
        tabSize: 4,
        bracketPairColorization: { enabled: false },
        guides: { indentation: true, highlightActiveIndentation: false },
        stickyScroll: { enabled: true, maxLineCount: 3 },
        inlayHints: { enabled: settings.inlayHints ? 'on' : 'off', fontSize: 12, fontFamily: 'Inter, sans-serif', padding: true },
        contextmenu: false,
        // PHPBlitz shows its own PhpStorm-style popup (EditorHover).
        hover: { enabled: false },
        lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
        overviewRulerLanes: 2,
        hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        suggest: { showWords: true },
      }}
    />
    </div>
    </div>
  );
}

function TableView({ table }: { table: string }) {
  const data = SAMPLE_DB.tables[table];
  if (!data) return <div className="editor-empty">Table not found.</div>;
  return (
    <>
      <div className="tw-toolbar" style={{ height: 38, gap: 14, padding: '0 12px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ fontWeight: 600 }}>
          {SAMPLE_DB.schema}.{table}
        </span>
        <code className="mono" style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: 'var(--raised)', color: '#c2c8d2' }}>
          SELECT * FROM {table} LIMIT 500
        </code>
        <span className="grow" />
        <span className="muted">{data.rows.length} rows · sample data</span>
      </div>
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="num" />
              {data.columns.map((c) => (
                <th key={c.name}>
                  {c.key && (
                    <span className="mono" style={{ fontSize: 10, marginRight: 6, color: c.key === 'pk' ? 'var(--yellow)' : c.key === 'fk' ? 'var(--blue)' : 'var(--purple)' }}>
                      {c.key.toUpperCase()}
                    </span>
                  )}
                  {c.name} <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i}>
                <td className="num">{i + 1}</td>
                {row.map((v, j) => (
                  <td key={j} className={v === null ? 'null' : /^[\d.]+$/.test(v) ? 'number' : undefined}>
                    {v ?? '<null>'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Markdown files: ▷ beside shell code blocks, and a tinted background on code block lines. */
function setupMarkdown(editor: monaco.editor.IStandaloneCodeEditor) {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== 'markdown') return;
  const decorations = editor.createDecorationsCollection();
  const update = () => {
    const lines = model.getLinesContent();
    const result: monaco.editor.IModelDeltaDecoration[] = shellBlocks(model.getValue()).map((b) => ({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: { glyphMarginClassName: 'md-run-glyph', glyphMarginHoverMessage: { value: 'Run in terminal' } },
    }));
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^\s*(```|~~~)/);
      if (!open) continue;
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(open[1])) j++;
      if (j > i + 1) result.push({ range: new monaco.Range(i + 2, 1, j, 1), options: { isWholeLine: true, className: 'md-code-line' } });
      i = j;
    }
    decorations.set(result);
  };
  update();
  let timer = 0;
  model.onDidChangeContent(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 200);
  });
}

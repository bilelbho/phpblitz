// Query console for a data source: SQL editor on top (Ctrl+Enter runs the statement at the caret,
// or the selection), results grid and output log below. The text is kept per data source.

import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { db, useDb } from '../db/store';
import type { QueryResult } from '../db/types';
import { useSettings } from '../settings';
import { themeId } from '../editor/themes';
import { DataGrid } from './DataGrid';
import { Icon } from './Icon';

const textKey = (source: string) => `phpblitz.console:${source}`;

/** The statement around `offset`: text between semicolons outside quotes and comments. */
export function statementAt(text: string, offset: number): { start: number; end: number; sql: string } | null {
  const bounds: number[] = [0];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '-' && text[i + 1] === '-') i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
    else if (ch === '/' && text[i + 1] === '*') i = text.indexOf('*/', i) === -1 ? text.length : text.indexOf('*/', i) + 1;
    else if (ch === ';') bounds.push(i + 1);
  }
  bounds.push(text.length + 1);
  const pieces = [];
  for (let i = 0; i < bounds.length - 1; i++) pieces.push({ start: bounds[i], end: Math.min(bounds[i + 1], text.length) });
  const has = (p: { start: number; end: number }) => text.slice(p.start, p.end).replace(/;$/, '').trim().length > 0;
  // The piece containing the caret; after a final `;`, the statement before it.
  let i = pieces.findIndex((p) => offset >= p.start && offset < p.end);
  if (i === -1) i = pieces.length - 1;
  while (i > 0 && !has(pieces[i])) i--;
  const p = pieces[i];
  if (!p || !has(p)) return null;
  const raw = text.slice(p.start, p.end);
  const lead = raw.length - raw.trimStart().length;
  const sql = raw.trim().replace(/;$/, '').trim();
  return { start: p.start + lead, end: p.start + lead + sql.length, sql };
}

/** Consoles' models → their data source, for SQL completion. */
const consoleSources = new Map<string, string>();
let completionRegistered = false;

function registerCompletion() {
  if (completionRegistered) return;
  completionRegistered = true;
  const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'DISTINCT', 'COUNT', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'RETURNING', 'ASC', 'DESC'];
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const source = consoleSources.get(model.uri.toString());
      if (!source) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const st = db.state[source];
      const { CompletionItemKind } = monaco.languages;
      const tables = Object.entries(st?.tables ?? {}).flatMap(([schema, list]) => (list ?? []).map((t) => ({ schema, ...t })));
      const text = model.getValue();
      // Columns of the tables named in the console, loaded on demand.
      const used = tables.filter((t) => new RegExp(`\\b${t.name}\\b`, 'i').test(text));
      used.forEach((t) => {
        if (!db.cachedColumns(source, t.schema, t.name)) db.columns(source, t.schema, t.name).catch(() => {});
      });
      return {
        suggestions: [
          ...tables.map((t) => ({ label: t.name, kind: CompletionItemKind.Struct, detail: `${t.kind} · ${t.schema}`, insertText: t.name, range, sortText: '1' + t.name })),
          ...used.flatMap((t) =>
            (db.cachedColumns(source, t.schema, t.name) ?? []).map((c) => ({ label: c.name, kind: CompletionItemKind.Field, detail: `${t.name}.${c.name}: ${c.type}`, insertText: c.name, range, sortText: '0' + c.name })),
          ),
          ...keywords.map((k) => ({ label: k, kind: CompletionItemKind.Keyword, insertText: k, range, sortText: '2' + k })),
        ],
      };
    },
  });
}

interface LogLine {
  time: string;
  text: string;
  tone?: 'error' | 'ok';
}

export function QueryConsole({ ws, source }: { ws: Workspace; source: string }) {
  useDb();
  const ds = db.get(source);
  const settings = useSettings().editor;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<'result' | 'output'>('output');
  const [running, setRunning] = useState(false);
  const [split, setSplit] = useState(0.5);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  const add = (text: string, tone?: LogLine['tone']) => setLog((l) => [...l.slice(-300), { time: new Date().toLocaleTimeString(), text, tone }]);

  const execute = async () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || running) return;
    const sel = editor.getSelection();
    let sql: string;
    if (sel && !sel.isEmpty()) sql = model.getValueInRange(sel);
    else {
      const st = statementAt(model.getValue(), model.getOffsetAt(editor.getPosition()!));
      if (!st) return;
      sql = st.sql;
      // Show what runs, like PhpStorm's statement highlight.
      const range = monaco.Range.fromPositions(model.getPositionAt(st.start), model.getPositionAt(st.end));
      const flash = editor.createDecorationsCollection([{ range, options: { className: 'sql-running' } }]);
      setTimeout(() => flash.clear(), 600);
    }
    if (!sql.trim()) return;
    setRunning(true);
    add(sql.trim().split('\n').map((l) => `> ${l}`).join('\n'));
    try {
      const r = await db.query(source, sql, 500);
      if (r.columns.length) {
        setResult(r);
        setTab('result');
        add(`${r.rows.length}${r.truncated ? '+' : ''} row${r.rows.length === 1 ? '' : 's'} retrieved in ${r.ms} ms${r.truncated ? ' (first 500 shown)' : ''}`, 'ok');
      } else {
        add(`${r.affected ?? 0} row${r.affected === 1 ? '' : 's'} affected in ${r.ms} ms`, 'ok');
        setTab('output');
        // Schema changes: refresh the tree.
        if (/^\s*(create|alter|drop|rename)\b/i.test(sql)) db.schemas(source, true).catch(() => {});
      }
    } catch (e) {
      add(String(e instanceof Error ? e.message : e), 'error');
      setTab('output');
    } finally {
      setRunning(false);
    }
  };
  const executeRef = useRef(execute);
  executeRef.current = execute;

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    registerCompletion();
    const model = editor.getModel();
    if (model) consoleSources.set(model.uri.toString(), source);
    editor.addAction({ id: 'phpblitz.sql.execute', label: 'Execute', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => executeRef.current() });
    editor.onDidChangeModelContent(() => {
      try {
        localStorage.setItem(textKey(source), editor.getValue());
      } catch {
        // Only a convenience.
      }
    });
    // Tables for completion.
    db.schemas(source)
      .then((schemas) => Promise.all(schemas.slice(0, 5).map((s) => db.tables(source, s))))
      .catch(() => {});
    editor.focus();
  };

  const initial = (() => {
    try {
      return localStorage.getItem(textKey(source)) ?? '';
    } catch {
      return '';
    }
  })();

  return (
    <div className="query-console">
      <div className="tw-toolbar qc-toolbar">
        <button type="button" className="icon-btn small qc-run" title="Execute (Ctrl+Enter)" aria-label="Execute" disabled={running} onClick={execute}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
          </svg>
        </button>
        <span className="muted">{running ? 'Running…' : 'Ctrl+Enter runs the statement at the caret'}</span>
        <span className="grow" />
        <span className="chip">{ds?.name ?? 'unknown data source'}</span>
      </div>
      <div className="qc-editor" style={{ flexBasis: `${split * 100}%` }}>
        <Editor
          path={`inmemory://console/${source}.sql`}
          defaultLanguage="sql"
          defaultValue={initial || (ds?.driver === 'sample' ? 'SELECT * FROM users;\n' : '')}
          theme={themeId(settings.scheme)}
          onMount={onMount}
          options={{
            fontFamily: `'${settings.fontFamily}', 'JetBrains Mono', Consolas, monospace`,
            fontSize: settings.fontSize,
            lineHeight: Math.round(settings.fontSize * settings.lineHeight),
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            padding: { top: 6 },
            renderLineHighlight: 'line',
            fontLigatures: settings.ligatures,
          }}
        />
      </div>
      <div
        className="qc-splitter"
        onMouseDown={(e) => {
          const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
          const move = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height)));
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
      />
      <div className="qc-results">
        <div className="tw-head qc-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'output'} className={'tw-tab' + (tab === 'output' ? ' active' : '')} onClick={() => setTab('output')}>
            Output
          </button>
          <button type="button" role="tab" aria-selected={tab === 'result'} className={'tw-tab' + (tab === 'result' ? ' active' : '')} onClick={() => setTab('result')} disabled={!result}>
            Result {result && <span className="count">{result.rows.length}{result.truncated ? '+' : ''}</span>}
          </button>
          <span className="grow" />
          {tab === 'output' && log.length > 0 && (
            <button type="button" className="icon-btn small" aria-label="Clear output" title="Clear" onClick={() => setLog([])}>
              <Icon name="close" size={10} strokeWidth={2.5} />
            </button>
          )}
        </div>
        {tab === 'result' && result ? (
          <DataGrid columns={result.columns} rows={result.rows} />
        ) : (
          <div className="qc-log mono">
            {!log.length && <div className="muted">Write SQL above and press Ctrl+Enter.</div>}
            {log.map((l, i) => (
              <div key={i} className={'qc-line' + (l.tone ? ` ${l.tone}` : '')}>
                <span className="qc-time">[{l.time}]</span> <span>{l.text}</span>
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        )}
      </div>
    </div>
  );
}

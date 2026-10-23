// Query console for a data source: SQL editor on top (Ctrl+Enter runs the statement at the caret,
// or the selection), results grid and output log below. The text is kept per data source.

import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { isRelation } from '../db/types';
import { resolveQualifier, sqlContext, tableRefs, type TableRef } from '../db/completion';
import { db, useDb } from '../db/store';
import type { QueryResult } from '../db/types';
import { useSettings } from '../settings';
import { themeId } from '../editor/themes';
import { DataGrid } from './DataGrid';
import { ExportDialog } from './ExportDialog';
import { Icon } from './Icon';
import { reserveKeys } from '../keymap/commands';

const textKey = (source: string, name: string) => (name === 'console' ? `phpblitz.console:${source}` : `phpblitz.console:${source}:${name}`);

/** Saved console texts (also used to open a console with SQL in it, e.g. a table's DDL). */
export const consoleText = {
  get: (source: string, name: string) => {
    try {
      return localStorage.getItem(textKey(source, name)) ?? '';
    } catch {
      return '';
    }
  },
  set: (source: string, name: string, text: string) => {
    try {
      localStorage.setItem(textKey(source, name), text);
    } catch {
      // This session only.
    }
    monaco.editor.getModel(monaco.Uri.parse(consoleUri(source, name)))?.setValue(text);
  },
};

const consoleUri = (source: string, name: string) => (name === 'console' ? `inmemory://console/${source}.sql` : `inmemory://console/${source}/${name}.sql`);

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

const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'USING', 'AS', 'DISTINCT', 'UNION', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'RETURNING', 'ASC', 'DESC', 'WITH'];
const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'LOWER', 'UPPER', 'LENGTH', 'TRIM', 'SUBSTRING', 'REPLACE', 'CONCAT', 'ROUND', 'ABS', 'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CAST', 'EXTRACT'];

function registerCompletion() {
  if (completionRegistered) return;
  completionRegistered = true;
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    async provideCompletionItems(model, position) {
      const source = consoleSources.get(model.uri.toString());
      if (!source) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const { CompletionItemKind } = monaco.languages;
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      // Only the statement around the cursor counts (a console holds many): from the `;` before it
      // to the next one.
      const start = text.lastIndexOf(';', offset - 1) + 1;
      const next = text.indexOf(';', offset);
      const statement = text.slice(start, next < 0 ? text.length : next);
      const before = text.slice(start, offset);
      const refs = tableRefs(statement);
      const context = sqlContext(before);

      const st = db.state[source];
      const tables = Object.entries(st?.tables ?? {}).flatMap(([schema, list]) => (list ?? []).filter((t) => isRelation(t.kind)).map((t) => ({ schema, ...t })));
      const schemas = Object.keys(st?.tables ?? {});
      /** The catalog table a reference names (its schema, or the first schema that has it). */
      const tableOf = (r: TableRef) => tables.find((t) => t.name.toLowerCase() === r.table.toLowerCase() && (!r.schema || t.schema.toLowerCase() === r.schema.toLowerCase()));
      const columnsOf = async (r: TableRef) => {
        const t = tableOf(r);
        return t ? db.columns(source, t.schema, t.name).catch(() => []) : [];
      };
      const tableItems = (list: typeof tables, sort = '1') =>
        list.map((t) => ({ label: t.name, kind: CompletionItemKind.Struct, detail: `${t.kind} · ${t.schema}`, insertText: t.name, range, sortText: sort + t.name }));
      const columnItems = async (r: TableRef, sort = '0') =>
        (await columnsOf(r)).map((c) => ({
          label: c.name,
          kind: CompletionItemKind.Field,
          detail: `${r.alias ?? r.table}.${c.name}: ${c.type}${c.key === 'pk' ? ' · primary key' : ''}`,
          insertText: c.name,
          range,
          sortText: sort + c.name,
        }));

      if (context.kind === 'member') {
        // "u." / "users.": that table's columns; "public.": that schema's tables.
        // A table or alias of the statement that exists, else a table by that name, else a schema.
        const named = resolveQualifier(refs, context.qualifier);
        const ref = named && tableOf(named) ? named : tableOf({ table: context.qualifier }) ? { table: context.qualifier } : undefined;
        if (ref) return { suggestions: await columnItems(ref) };
        const schema = schemas.find((x) => x.toLowerCase() === context.qualifier.toLowerCase());
        if (schema) return { suggestions: tableItems(tables.filter((t) => t.schema === schema), '0') };
        return { suggestions: [] };
      }
      if (context.kind === 'tables') {
        return {
          suggestions: [
            ...tableItems(tables, '0'),
            ...schemas.map((x) => ({ label: x, kind: CompletionItemKind.Module, detail: 'schema', insertText: x, range, sortText: '1' + x })),
          ],
        };
      }
      // Columns of the statement's tables first, then tables, functions and keywords.
      const columns = (await Promise.all(refs.map((r) => columnItems(r)))).flat();
      const seen = new Set<string>();
      return {
        suggestions: [
          ...columns.filter((c) => !seen.has(c.label) && seen.add(c.label)),
          ...refs.filter((r) => r.alias).map((r) => ({ label: r.alias!, kind: CompletionItemKind.Variable, detail: `alias of ${r.table}`, insertText: r.alias!, range, sortText: '1' + r.alias })),
          ...tableItems(tables, '2'),
          ...FUNCTIONS.map((f) => ({ label: f, kind: CompletionItemKind.Function, insertText: f + '($0)', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: '3' + f })),
          ...KEYWORDS.map((k) => ({ label: k, kind: CompletionItemKind.Keyword, insertText: k, range, sortText: '4' + k })),
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

export function QueryConsole({ ws, source, name }: { ws: Workspace; source: string; name: string }) {
  useDb();
  const ds = db.get(source);
  const settings = useSettings().editor;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [exporting, setExporting] = useState(false);
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
      // Show what runs: the statement is highlighted.
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
    reserveKeys(editor, ['Ctrl+Enter']);
    editor.onDidChangeModelContent(() => {
      try {
        localStorage.setItem(textKey(source, name), editor.getValue());
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
      return localStorage.getItem(textKey(source, name)) ?? '';
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
        {running && (
          <button type="button" className="icon-btn small qc-cancel" title="Cancel the running query" aria-label="Cancel query" onClick={() => void db.cancel(source).catch((e) => add(`Could not cancel: ${e}`, 'error'))}>
            <Icon name="stopSquare" size={13} />
          </button>
        )}
        <span className="muted">{running ? 'Running…' : 'Ctrl+Enter runs the statement at the caret'}</span>
        <span className="grow" />
        <span className="chip">{ds?.name ?? 'unknown data source'}</span>
      </div>
      <div className="qc-editor" style={{ flexBasis: `${split * 100}%` }}>
        <Editor
          path={consoleUri(source, name)}
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
          {tab === 'result' && result && (
            <button type="button" className="btn small ghost" onClick={() => setExporting(true)} title="Export Data…">
              Export…
            </button>
          )}
          {tab === 'output' && log.length > 0 && (
            <button type="button" className="icon-btn small" aria-label="Clear output" title="Clear" onClick={() => setLog([])}>
              <Icon name="close" size={10} />
            </button>
          )}
        </div>
        {exporting && result && ds && (
          <ExportDialog
            ws={ws}
            fileName="result"
            options={{ table: { driver: ds.driver, schema: '', name: 'result' } }}
            scopes={[{ id: 'result', label: 'Result', load: async () => ({ columns: result.columns, rows: result.rows }) }]}
            onClose={() => setExporting(false)}
          />
        )}
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

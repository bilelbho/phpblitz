// Files shown, not only edited: images (zoom, size, dimensions), SVG beside its code, and CSV
// as a table. CSV and SVG keep the text editor a click away, like Markdown's preview.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { csvDelimiter, imageType, parseCsv } from '../fileKinds';
import { DataGrid } from './DataGrid';

type OnEditor = (e: monaco.editor.IStandaloneCodeEditor) => void;

function savedMode<T extends string>(key: string, modes: readonly T[], fallback: T): T {
  try {
    const m = localStorage.getItem(key) as T | null;
    return m && modes.includes(m) ? m : fallback;
  } catch {
    return fallback;
  }
}

function saveMode(key: string, mode: string) {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Only a preference.
  }
}

/** The editor's text as it changes (the model of the editor beside the view). */
function useLiveText(ws: Workspace, path: string, editor: monaco.editor.IStandaloneCodeEditor | null): string {
  const [text, setText] = useState(() => ws.liveTextOf(path) ?? ws.loaded[path] ?? '');
  useEffect(() => {
    const model = editor?.getModel();
    if (!model) return;
    let timer = 0;
    setText(model.getValue());
    const sub = model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setText(model.getValue()), 200);
    });
    return () => {
      window.clearTimeout(timer);
      sub.dispose();
    };
  }, [editor]);
  return text;
}

interface Mode<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
}

function ModeBar<T extends string>({ label, modes, mode, onPick }: { label: string; modes: Mode<T>[]; mode: T; onPick: (m: T) => void }) {
  return (
    <div className="md-toolbar" role="radiogroup" aria-label={label}>
      {modes.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={'md-tool' + (mode === m.id ? ' on' : '')} title={m.label} aria-label={m.label} onClick={() => onPick(m.id)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {m.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

const ICON_TEXT = <path d="M3 4h10M3 7h10M3 10h10M3 13h6" />;
const ICON_SPLIT = <path d="M2.5 3.5h11v9h-11zM8 3.5v9M4 6h2.5M4 8.5h2.5" />;
const ICON_IMAGE = <path d="M2.5 3.5h11v9h-11zM4.5 10.5l2.5-3 2 2 1.5-1.5 1.5 2.5M10.5 6.2h.01" />;
const ICON_TABLE = <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9M10 3.5v9" />;

// ── Images ──────────────────────────────────────────────────────

const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** An image file, or (with `source`) an SVG's text as the editor has it. */
export function ImageView({ ws, path, source }: { ws: Workspace; path: string; source?: string }) {
  const [file, setFile] = useState<{ url: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [fitScale, setFitScale] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const svg = source !== undefined;

  useEffect(() => {
    let url = '';
    let live = true;
    const show = (blob: Blob) => {
      url = URL.createObjectURL(blob);
      setFile({ url, bytes: blob.size });
      setError(null);
    };
    if (svg) show(new Blob([source], { type: 'image/svg+xml' }));
    else
      ws.backend.readBinary(path).then(
        (bytes) => live && show(new Blob([bytes], { type: imageType(path) })),
        (e) => live && setError(String(e)),
      );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ws.backend, path, svg, source]);

  // The scale at which "fit" shows the image (never above 100%).
  useEffect(() => {
    const el = stage.current;
    if (!el || !natural) return;
    const measure = () => setFitScale(Math.min(1, (el.clientWidth - 32) / natural.w, (el.clientHeight - 32) / natural.h));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural]);

  const scale = zoom === 'fit' ? fitScale : zoom;
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > scale + 1e-6) : [...ZOOMS].reverse().find((z) => z < scale - 1e-6);
    if (next) setZoom(next);
  };

  return (
    <div className="image-view">
      <div className="image-bar">
        <button type="button" className="image-btn" title="Zoom Out" aria-label="Zoom out" onClick={() => step(-1)}>−</button>
        <span className="image-zoom">{Math.round(scale * 100)}%</span>
        <button type="button" className="image-btn" title="Zoom In" aria-label="Zoom in" onClick={() => step(1)}>+</button>
        <button type="button" className={'image-btn text' + (zoom === 1 ? ' on' : '')} onClick={() => setZoom(1)}>1:1</button>
        <button type="button" className={'image-btn text' + (zoom === 'fit' ? ' on' : '')} onClick={() => setZoom('fit')}>Fit</button>
        <span className="image-info">
          {natural && `${natural.w} × ${natural.h}`}
          {file && ` · ${formatSize(file.bytes)}`}
          {` · ${svg ? 'SVG' : imageType(path).slice(6).toUpperCase()}`}
        </span>
      </div>
      <div
        ref={stage}
        className="image-stage"
        onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          step(e.deltaY < 0 ? 1 : -1);
        }}
      >
        {error && <div className="editor-empty">{error}</div>}
        {file && !error && (
          <img
            src={file.url}
            alt={path.split('/').pop()}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })}
            onError={() => setError(svg ? 'The SVG has an error and can’t be shown.' : 'This image can’t be shown.')}
            style={natural ? { width: natural.w * scale, height: natural.h * scale } : { visibility: 'hidden' }}
          />
        )}
      </div>
    </div>
  );
}

// ── SVG: code and picture ───────────────────────────────────────

type SvgMode = 'editor' | 'split' | 'preview';
const SVG_KEY = 'phpblitz.svgMode';

export function SvgView({ ws, path, children }: { ws: Workspace; path: string; children: (onEditor: OnEditor) => ReactNode }) {
  const [mode, setMode] = useState<SvgMode>(() => savedMode(SVG_KEY, ['editor', 'split', 'preview'] as const, 'split'));
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const text = useLiveText(ws, path, editor);
  return (
    <div className={'md-split mode-' + mode}>
      <ModeBar
        label="SVG view"
        mode={mode}
        onPick={(m) => {
          setMode(m);
          saveMode(SVG_KEY, m);
        }}
        modes={[
          { id: 'editor', label: 'Editor Only', icon: ICON_TEXT },
          { id: 'split', label: 'Editor and Preview', icon: ICON_SPLIT },
          { id: 'preview', label: 'Preview Only', icon: ICON_IMAGE },
        ]}
      />
      <div className="md-editor-pane">{children(setEditor)}</div>
      {mode !== 'editor' && (
        <div className="file-view-pane">
          <ImageView ws={ws} path={path} source={text} />
        </div>
      )}
    </div>
  );
}

// ── CSV: table and text ─────────────────────────────────────────

type CsvMode = 'table' | 'editor';
const CSV_KEY = 'phpblitz.csvMode';
/** Rows the table shows; the text editor has them all. */
const TABLE_ROWS = 10_000;

export function CsvView({ ws, path, children }: { ws: Workspace; path: string; children: (onEditor: OnEditor) => ReactNode }) {
  const [mode, setMode] = useState<CsvMode>(() => savedMode(CSV_KEY, ['table', 'editor'] as const, 'table'));
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const text = useLiveText(ws, path, editor);
  const table = useMemo(() => {
    if (mode !== 'table') return null;
    const delimiter = csvDelimiter(path, text);
    const rows = parseCsv(text, delimiter);
    const header = rows[0] ?? [];
    const width = Math.max(header.length, ...rows.slice(1, TABLE_ROWS + 1).map((r) => r.length));
    // Unique, non-empty names: the grid keys its columns by name.
    const seen = new Set<string>();
    const columns = Array.from({ length: width }, (_, i) => {
      let name = header[i]?.trim() || `Column ${i + 1}`;
      while (seen.has(name)) name += ` (${i + 1})`;
      seen.add(name);
      return name;
    });
    const body = rows.slice(1, TABLE_ROWS + 1).map((r) => columns.map((_, i) => r[i] ?? ''));
    return { columns, rows: body, total: Math.max(0, rows.length - 1), delimiter };
  }, [mode, path, text]);

  return (
    <div className={'md-split mode-' + (mode === 'table' ? 'preview' : 'editor')}>
      <ModeBar
        label="CSV view"
        mode={mode}
        onPick={(m) => {
          setMode(m);
          saveMode(CSV_KEY, m);
        }}
        modes={[
          { id: 'table', label: 'Table', icon: ICON_TABLE },
          { id: 'editor', label: 'Text', icon: ICON_TEXT },
        ]}
      />
      <div className="md-editor-pane">{children(setEditor)}</div>
      {table && (
        <div className="file-view-pane csv-view">
          <div className="csv-info">
            {table.total.toLocaleString()} {table.total === 1 ? 'row' : 'rows'} · {table.columns.length} columns · separated by{' '}
            {table.delimiter === '\t' ? 'tabs' : `“${table.delimiter}”`}
            {table.total > TABLE_ROWS && ` · the first ${TABLE_ROWS.toLocaleString()} rows are shown, Text has them all`}
          </div>
          <div className="csv-grid">
            <DataGrid columns={table.columns} rows={table.rows} />
          </div>
        </div>
      )}
    </div>
  );
}

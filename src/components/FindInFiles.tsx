// Find in Files (Ctrl+Shift+F) and Replace in Files (Ctrl+Shift+R).

import { FileIcon } from './FileIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { confirmDialog, isTauri } from '../platform';
import { replaceInFiles, replaceInText, searchInFiles, type SearchMatch, type SearchOptions, type SearchResult } from '../search';
import { Icon } from './Icon';

/** Options survive closing the popup. */
let remembered: Omit<SearchOptions, 'query'> = { regex: false, matchCase: false, wholeWord: false, fileMask: '' };
let rememberedQuery = '';

type Hit = { path: string; match: SearchMatch };

export function FindInFiles({ ws }: { ws: Workspace }) {
  const request = ws.findInFiles!;
  const [query, setQuery] = useState(request.seed || rememberedQuery);
  const [opts, setOpts] = useState(remembered);
  const [maskOn, setMaskOn] = useState(!!remembered.fileMask);
  const [replaceMode, setReplaceMode] = useState(request.mode === 'replace');
  const [replacement, setReplacement] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const [rerun, setRerun] = useState(0);
  /** Folder the search is limited to (Project tree ▸ Find in Files…); undefined = whole project. */
  const [scopeDir, setScopeDir] = useState<string | undefined>(request.dir);

  const options: SearchOptions = useMemo(() => ({ ...opts, fileMask: maskOn ? opts.fileMask : '', query }), [opts, maskOn, query]);

  useEffect(() => {
    if (request.seed) setQuery(request.seed);
    setReplaceMode(request.mode === 'replace');
    setScopeDir(request.dir);
    window.setTimeout(() => input.current?.select(), 0);
  }, [request]);

  useEffect(() => {
    remembered = opts;
    rememberedQuery = query;
  }, [opts, query]);

  // Search as you type.
  useEffect(() => {
    if (!query) {
      setResult(null);
      setError('');
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const unsaved = new Map([...ws.dirty].map((p) => [p, ws.liveTextOf(p) ?? ''] as const));
        const r = await searchInFiles(ws.backend, ws.files, options, unsaved, scopeDir);
        if (id !== seq.current) return;
        setResult(r);
        setError('');
        setSelected((s) => Math.min(s, Math.max(0, r.total - 1)));
      } catch (e) {
        const message = String(e instanceof Error ? e.message : e);
        if (id !== seq.current || message === 'cancelled') return;
        setResult(null);
        setError(message);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
    // ws.files changes as the project is indexed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, rerun, scopeDir]);

  const hits: Hit[] = useMemo(() => (result ? result.files.flatMap((f) => f.matches.map((match) => ({ path: f.path, match }))) : []), [result]);
  const current = hits[selected];

  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = () => ws.closeFindInFiles();
  const open = (hit: Hit | undefined) => {
    if (!hit) return;
    close();
    ws.openFile(hit.path, { line: hit.match.line, column: hit.match.column });
  };

  const openInFindWindow = () => {
    if (!result) return;
    ws.setFindResults({ options, result });
    ws.showBottom('find');
    close();
  };

  // ── Replace ──
  const replaceOne = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const { path, match } = current;
      const source = ws.liveTextOf(path) ?? (await ws.backend.readFile(path));
      const lines = source.split('\n');
      const lineText = lines[match.line - 1] ?? '';
      const found = lineText.slice(match.column - 1, match.endColumn - 1);
      const { text: replaced } = await replaceInText(options, replacement, found);
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      if (model) {
        model.pushEditOperations([], [{ range: new monaco.Range(match.line, match.column, match.line, match.endColumn), text: replaced }], () => null);
      } else {
        lines[match.line - 1] = lineText.slice(0, match.column - 1) + replaced + lineText.slice(match.endColumn - 1);
        await ws.backend.writeFile(path, lines.join('\n'));
      }
      setRerun((n) => n + 1);
    } catch (e) {
      ws.notify({ title: 'Replace failed', body: String(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const replaceAll = async () => {
    if (!result?.total) return;
    const ok = await confirmDialog(`Replace ${result.total} occurrence${result.total === 1 ? '' : 's'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}?`);
    if (!ok) return;
    setBusy(true);
    try {
      let count = 0;
      let openCount = 0;
      const closed: string[] = [];
      let skipped: { path: string; reason: string }[] = [];
      for (const { path } of result.files) {
        const model = monaco.editor.getModel(monaco.Uri.file(path));
        if (model) {
          const r = await replaceInText(options, replacement, model.getValue());
          if (r.count) {
            model.pushStackElement();
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text: r.text }], () => null);
            model.pushStackElement();
            count += r.count;
            openCount++;
          }
        } else {
          closed.push(path);
        }
      }
      if (closed.length && isTauri && ws.backend.kind === 'disk') {
        const r = await replaceInFiles(options, replacement, closed, ws.backend.root);
        count += r.count;
        skipped = r.skipped;
      } else {
        for (const path of closed) {
          const r = await replaceInText(options, replacement, await ws.backend.readFile(path));
          if (r.count) {
            await ws.backend.writeFile(path, r.text);
            count += r.count;
          }
        }
      }
      ws.notify({
        title: `Replaced ${count} occurrence${count === 1 ? '' : 's'}`,
        body: openCount ? `${openCount} open file${openCount === 1 ? ' has' : 's have'} unsaved changes; Ctrl+Z undoes them.` : `In ${result.files.length} file${result.files.length === 1 ? '' : 's'}. Local History keeps each file as it was.`,
        tone: 'success',
      });
      if (skipped.length) {
        const name = (p: string) => p.split('/').pop();
        ws.notify({
          title: `${skipped.length} file${skipped.length === 1 ? ' was' : 's were'} not changed`,
          body: skipped
            .slice(0, 5)
            .map((s) => `${name(s.path)}: ${s.reason}`)
            .join('\n') + (skipped.length > 5 ? `\nand ${skipped.length - 5} more` : ''),
          tone: 'warning',
        });
      }
      setRerun((n) => n + 1);
    } catch (e) {
      ws.notify({ title: 'Replace failed', body: String(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && (e.target as HTMLElement).id !== 'fif-replace') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) openInFindWindow();
      else open(current);
    }
  };

  const toggle = (key: 'matchCase' | 'wholeWord' | 'regex', text: string, title: string) => (
    <button type="button" className={'find-toggle' + (opts[key] ? ' on' : '')} aria-pressed={opts[key]} title={title} onClick={() => setOpts((o) => ({ ...o, [key]: !o[key] }))}>
      {text}
    </button>
  );

  const count = !query ? '' : error ? error : loading && !result ? 'Searching…' : result ? `${result.total}${result.truncated ? '+' : ''} match${result.total === 1 ? '' : 'es'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}` : '';

  return (
    <div className="modal-backdrop clear" style={{ paddingTop: '8vh' }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pb-popup fif" role="dialog" aria-label={replaceMode ? 'Replace in files' : 'Find in files'} onKeyDown={onKeyDown}>
        <div className="fif-head">
          <span className="pb-popup-title" style={{ padding: 0 }}>
            {replaceMode ? 'Replace in Files' : 'Find in Files'}
          </span>
          {scopeDir && (
            <span className="chip scope-chip" title={scopeDir}>
              In {relativePath(ws.backend, scopeDir) || ws.backend.name}
              <button type="button" aria-label="Search the whole project" title="Search the whole project" onClick={() => setScopeDir(undefined)}>
                <Icon name="close" size={9} />
              </button>
            </span>
          )}
          <span className="muted" style={{ fontSize: 12, color: error ? '#f0787f' : undefined }}>
            {count}
          </span>
          <span className="grow" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <input type="checkbox" className="checkbox" checked={maskOn} onChange={(e) => setMaskOn(e.target.checked)} />
            File mask:
          </label>
          <div className="field" style={{ width: 150, height: 26 }}>
            <label htmlFor="fif-mask" className="sr-only">
              File mask
            </label>
            <input
              id="fif-mask"
              value={opts.fileMask}
              placeholder="*.php"
              spellCheck={false}
              disabled={!maskOn}
              onChange={(e) => setOpts((o) => ({ ...o, fileMask: e.target.value }))}
            />
          </div>
        </div>

        <div className="find-row" style={{ padding: '0 10px' }}>
          <button type="button" className="icon-btn small" aria-label={replaceMode ? 'Hide replace' : 'Show replace'} title="Replace (Ctrl+Shift+R)" onClick={() => setReplaceMode((r) => !r)}>
            <span className={'chev' + (replaceMode ? ' open' : '')}>
              <Icon name="chevronRight" size={12} />
            </span>
          </button>
          <div className={'field find-field' + (query && result && !result.total ? ' invalid' : '')} style={{ flex: '1 1 auto', maxWidth: 'none' }}>
            <Icon name="search" size={13} />
            <label htmlFor="fif-query" className="sr-only">
              Text to find
            </label>
            <input id="fif-query" ref={input} value={query} spellCheck={false} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
            {toggle('matchCase', 'Cc', 'Match Case')}
            {toggle('wholeWord', 'W', 'Words')}
            {toggle('regex', '.*', 'Regex')}
          </div>
        </div>
        {replaceMode && (
          <div className="find-row" style={{ padding: '4px 10px 0' }}>
            <span style={{ width: 22, flex: 'none' }} />
            <div className="field find-field" style={{ flex: '1 1 auto', maxWidth: 'none' }}>
              <Icon name="refresh" size={13} />
              <label htmlFor="fif-replace" className="sr-only">
                Replace with
              </label>
              <input
                id="fif-replace"
                value={replacement}
                spellCheck={false}
                placeholder={opts.regex ? 'Replacement ($1 for groups)' : 'Replacement'}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && replaceOne()}
              />
            </div>
          </div>
        )}

        <div className="fif-results" ref={list} role="listbox" aria-label="Matches">
          {hits.map((hit, i) => {
            const m = hit.match;
            return (
              <button
                key={`${hit.path}:${m.line}:${m.column}`}
                type="button"
                role="option"
                aria-selected={i === selected}
                className={'result fif-row' + (i === selected ? ' selected' : '')}
                data-selected={i === selected}
                onMouseDown={() => setSelected(i)}
                onDoubleClick={() => open(hit)}
              >
                <span className="mono fif-preview">
                  {m.preview.slice(0, m.previewColumn)}
                  <mark>{m.preview.slice(m.previewColumn, m.previewColumn + m.previewLength)}</mark>
                  {m.preview.slice(m.previewColumn + m.previewLength)}
                </span>
                <span className="kind">
                  {baseName(hit.path)} {m.line}
                </span>
              </button>
            );
          })}
          {query && result && !result.total && <div className="empty">No matches.</div>}
          {!query && <div className="empty">Type to search the project. Folders in .gitignore, vendor and node_modules are skipped.</div>}
        </div>

        {current && <Preview ws={ws} hit={current} />}

        <div className="fif-foot">
          {current && (
            <span className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {relativePath(ws.backend, current.path)}
            </span>
          )}
          <span className="grow" />
          {replaceMode && (
            <>
              <button type="button" className="btn" onClick={replaceOne} disabled={!current || busy}>
                Replace
              </button>
              <button type="button" className="btn" onClick={replaceAll} disabled={!result?.total || busy}>
                Replace All
              </button>
            </>
          )}
          <button type="button" className="btn" onClick={openInFindWindow} disabled={!result?.total} title="Ctrl+Enter">
            Open in Find Window
          </button>
        </div>
      </div>
    </div>
  );
}

/** A few lines of code around the selected match (the preview pane). */
function Preview({ ws, hit }: { ws: Workspace; hit: Hit }) {
  const [text, setText] = useState<string | null>(ws.liveTextOf(hit.path) ?? null);
  useEffect(() => {
    const live = ws.liveTextOf(hit.path);
    if (live !== undefined) return setText(live);
    let alive = true;
    ws.backend.readFile(hit.path).then((t) => alive && setText(t)).catch(() => alive && setText(''));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit.path]);
  if (text === null) return <div className="fif-code" />;
  const lines = text.split('\n');
  const from = Math.max(1, hit.match.line - 4);
  const to = Math.min(lines.length, hit.match.line + 4);
  return (
    <div className="fif-code" aria-label="Preview">
      <div className="fif-code-title">
        <FileIcon path={hit.path} />
        {baseName(hit.path)}
      </div>
      {lines.slice(from - 1, to).map((raw, i) => {
        const n = from + i;
        const line = raw.replace(/\r$/, '');
        const isHit = n === hit.match.line;
        return (
          <div key={n} className={'fif-code-line' + (isHit ? ' hit' : '')}>
            <span className="fif-num">{n}</span>
            <span>
              {isHit ? (
                <>
                  {line.slice(0, hit.match.column - 1)}
                  <mark>{line.slice(hit.match.column - 1, hit.match.endColumn - 1)}</mark>
                  {line.slice(hit.match.endColumn - 1)}
                </>
              ) : (
                line || ' '
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Bottom "Find" tool window: pinned results grouped by file. */
export function FindResults({ ws }: { ws: Workspace }) {
  const pinned = ws.findResults;
  if (!pinned) return <div className="empty">No search results. Use Find in Files (Ctrl+Shift+F).</div>;
  const { result, options } = pinned;
  return (
    <div className="tree">
      <div className="row" style={{ paddingLeft: 6, color: 'var(--muted)' }}>
        {result.total}
        {result.truncated ? '+' : ''} matches of “{options.query}” in {result.files.length} files
        <span className="grow" />
        <button type="button" className="btn small ghost" onClick={() => ws.openFindInFiles('find', options.query)}>
          <Icon name="search" size={13} /> Search Again
        </button>
      </div>
      {result.files.map((f) => {
        return (
          <div key={f.path}>
            <div className="row" style={{ paddingLeft: 6 }} title={relativePath(ws.backend, f.path)}>
              <FileIcon path={f.path} />
              <span className="name">{baseName(f.path)}</span>
              <span className="detail">{relativePath(ws.backend, f.path).split('/').slice(0, -1).join('/')}</span>
              <span className="detail">{f.matches.length}</span>
            </div>
            {f.matches.map((m) => (
              <button key={`${m.line}:${m.column}`} type="button" className="row" style={{ paddingLeft: 30, gap: 10 }} onClick={() => ws.openFile(f.path, { line: m.line, column: m.column })}>
                <span className="mono" style={{ color: 'var(--faint)', minWidth: 34, textAlign: 'right' }}>
                  {m.line}
                </span>
                <span className="mono name fif-preview">
                  {m.preview.slice(0, m.previewColumn)}
                  <mark>{m.preview.slice(m.previewColumn, m.previewColumn + m.previewLength)}</mark>
                  {m.preview.slice(m.previewColumn + m.previewLength)}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

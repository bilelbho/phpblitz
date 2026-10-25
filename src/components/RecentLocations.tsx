// Recent Locations (Ctrl+Shift+E): the places the caret jumped to and the places edited, newest
// first, each with a few lines of its code. Typing filters (file name or code), Ctrl+Shift+E again
// shows changed places only, Enter goes there.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import type { Workspace } from '../useWorkspace';
import { baseName, relativePath } from '../backend/types';
import { languageOf } from '../php';
import { colorizeCode } from '../editor/markdown';
import { forgetPlace, recentPlaces, type RecentPlace } from '../navHistory';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

/** Lines shown around each place. */
const AROUND = 1;

export function RecentLocations({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [places, setPlaces] = useState<RecentPlace[]>(() => recentPlaces());
  const [changedOnly, setChangedOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  /** Each file's text (open files: as edited; others: read once). */
  const [texts, setTexts] = useState<Record<string, string>>({});
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.focus();
    let live = true;
    for (const path of new Set(places.map((p) => p.path))) {
      const open = ws.liveTextOf(path);
      if (open !== undefined) setTexts((t) => ({ ...t, [path]: open }));
      else
        void ws.backend.readFile(path).then(
          (text) => live && setTexts((t) => ({ ...t, [path]: text })),
          () => {},
        );
    }
    return () => {
      live = false;
    };
    // The files of the places shown when the popup opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snippet = (p: RecentPlace) => {
    const text = texts[p.path];
    if (text === undefined) return null;
    const lines = text.split('\n');
    const from = Math.max(1, p.line - AROUND);
    return { from, code: lines.slice(from - 1, p.line + AROUND).join('\n') };
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return places.filter((p) => (!changedOnly || p.edited) && (!q || baseName(p.path).toLowerCase().includes(q) || (snippet(p)?.code.toLowerCase().includes(q) ?? false)));
    // snippet() reads texts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, changedOnly, query, texts]);

  useEffect(() => setIndex(0), [changedOnly, query]);
  useEffect(() => {
    box.current?.querySelector('.rl-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const go = (p: RecentPlace) => {
    onClose();
    ws.goToPlace(p);
  };
  const forget = (p: RecentPlace) => {
    forgetPlace(p);
    setPlaces(recentPlaces());
  };

  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const selected = shown[Math.min(index, shown.length - 1)];
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else onClose();
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setChangedOnly((v) => !v);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selected) go(selected);
    } else if (e.key === 'Delete' && selected) {
      e.preventDefault();
      forget(selected);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      setQuery((q) => q.slice(0, -1));
    } else if (e.key.length === 1 && !ctrl && !e.altKey) {
      // Speed search: just type.
      e.preventDefault();
      setQuery((q) => q + e.key);
    }
  };

  return (
    <div className="modal-backdrop clear" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="recent-files recent-locations" role="dialog" aria-label="Recent Locations" tabIndex={-1} onKeyDown={onKey}>
        <div className="rf-head">
          <span className="rf-title">{changedOnly ? 'Recently Changed Locations' : 'Recent Locations'}</span>
          {query && (
            <span className="rf-query">
              <Icon name="search" size={12} /> {query}
            </span>
          )}
          <span className="grow" />
          <label className="settings-check rf-edited">
            <input type="checkbox" className="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
            Show changed only <span className="muted">Ctrl+Shift+E</span>
          </label>
        </div>
        <div className="rl-list" role="listbox" aria-label="Recent locations">
          {shown.map((p, i) => (
            <Location
              key={`${p.path}:${p.line}`}
              place={p}
              rel={relativePath(ws.backend, p.path)}
              snippet={snippet(p)}
              selected={i === index}
              onHover={() => setIndex(i)}
              onGo={() => go(p)}
              onForget={() => forget(p)}
            />
          ))}
          {!shown.length && <div className="muted rf-empty">{changedOnly ? 'No changes in this session yet.' : query ? 'Nothing matches.' : 'Jump around or edit code, and the places show up here.'}</div>}
        </div>
      </div>
    </div>
  );
}

function Location({
  place,
  rel,
  snippet,
  selected,
  onHover,
  onGo,
  onForget,
}: {
  place: RecentPlace;
  rel: string;
  snippet: { from: number; code: string } | null;
  selected: boolean;
  onHover: () => void;
  onGo: () => void;
  onForget: () => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const code = snippet?.code;
  useEffect(() => {
    if (code === undefined) return;
    let live = true;
    void colorizeCode(code, monaco.editor.getModel(monaco.Uri.file(place.path))?.getLanguageId() ?? languageOf(place.path, code)).then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [code, place.path]);
  const dir = rel.split('/').slice(0, -1).join('/');
  return (
    <div role="option" aria-selected={selected} className={'rl-item' + (selected ? ' selected' : '')} onMouseEnter={onHover} onClick={onGo}>
      <div className="rl-title">
        <FileIcon path={place.path} />
        <span className="rl-name">{baseName(place.path)}</span>
        <span className="muted">:{place.line}</span>
        {place.edited && <span className="chip warn rl-chip">changed</span>}
        <span className="muted rl-dir">{dir}</span>
        <span className="grow" />
        <button
          type="button"
          className="icon-btn small rf-remove"
          title="Remove from Recent Locations (Delete)"
          aria-label={`Remove ${baseName(place.path)}:${place.line} from recent locations`}
          onClick={(e) => {
            e.stopPropagation();
            onForget();
          }}
        >
          <Icon name="close" size={9} />
        </button>
      </div>
      {snippet && (
        <div className="rl-code">
          <div className="rl-gutter">
            {snippet.code.split('\n').map((_, n) => (
              <span key={n} className={snippet.from + n === place.line ? 'here' : undefined}>
                {snippet.from + n}
              </span>
            ))}
          </div>
          {html !== null ? <pre className="md-code" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="md-code">{snippet.code}</pre>}
        </div>
      )}
    </div>
  );
}

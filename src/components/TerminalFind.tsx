// Find in the terminal (Ctrl+F): searches the output and scrollback of one session, highlighting
// every match. Enter / Shift+Enter go to the next / previous one (upwards first: the newest output
// is at the bottom); Escape closes the bar and gives the terminal the focus back.

import { useEffect, useRef, useState } from 'react';
import type { ISearchOptions } from '@xterm/addon-search';
import { terminals, type Session } from '../terminal/manager';
import { Icon } from './Icon';

const DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#32593d',
  matchBorder: '#32593d',
  matchOverviewRuler: '#5c962c',
  activeMatchBackground: '#c5a14a',
  activeMatchBorder: '#e5bf00',
  activeMatchColorOverviewRuler: '#e5bf00',
};

export function TerminalFind({ session, requests }: { session: Session; requests: number }) {
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastOptions = useRef('');
  const { search } = session;

  // Every Ctrl+F: focus the field with its text selected (also with the bar already open).
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [requests]);

  useEffect(() => {
    const sub = search.onDidChangeResults((r) => setResults({ index: r.resultIndex, count: r.resultCount }));
    return () => sub.dispose();
  }, [search]);

  const error = regex && query ? regexError(query) : null;
  const options = (incremental: boolean): ISearchOptions => ({ caseSensitive: matchCase, wholeWord, regex, incremental, decorations: DECORATIONS });

  // Typing searches from the newest output upwards, keeping the current match while it still fits.
  useEffect(() => {
    if (!query || error) {
      search.clearDecorations();
      session.term.clearSelection();
      setResults(null);
      return;
    }
    // The add-on keeps its highlights while the text is the same: a changed option starts over.
    const key = `${matchCase}${wholeWord}${regex}`;
    if (key !== lastOptions.current) search.clearDecorations();
    lastOptions.current = key;
    search.findPrevious(query, options(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase, wholeWord, regex, search]);

  const step = (dir: 1 | -1) => {
    if (!query || error) return;
    // Up the screen is back in time: "next" goes to older output, like reading the log backwards.
    if (dir === 1) search.findPrevious(query, options(false));
    else search.findNext(query, options(false));
  };

  const count = !query ? '' : error ? 'Bad regex' : !results || results.count === 0 ? '0 results' : results.index < 0 ? `${results.count} results` : `${results.index + 1}/${results.count}`;
  const none = !!query && (!!error || results?.count === 0);
  const toggle = (on: boolean, set: (v: boolean) => void, label: string, text: string) => (
    <button type="button" className={'find-toggle' + (on ? ' on' : '')} aria-pressed={on} aria-label={label} title={label} onClick={() => (set(!on), input.current?.focus())}>
      {text}
    </button>
  );

  return (
    <div
      className="find-bar term-find"
      role="search"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          terminals.closeFind();
        } else if (e.key === 'Enter' || e.key === 'F3') {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="find-row">
        <div className={'field find-field' + (none ? ' invalid' : '')}>
          <Icon name="search" size={13} />
          <input ref={input} value={query} spellCheck={false} placeholder={`Find in ${session.name}`} aria-label="Find in terminal" onChange={(e) => setQuery(e.target.value)} />
          {toggle(matchCase, setMatchCase, 'Match Case', 'Cc')}
          {toggle(wholeWord, setWholeWord, 'Words', 'W')}
          {toggle(regex, setRegex, 'Regex', '.*')}
        </div>
        <span className="find-count" style={{ color: none ? '#f0787f' : undefined }}>
          {count}
        </span>
        <button type="button" className="icon-btn small" aria-label="Previous occurrence" title="Previous Occurrence (Shift+Enter): newer output" onClick={() => step(-1)} disabled={!results?.count}>
          <Icon name="chevronDown" size={13} />
        </button>
        <button type="button" className="icon-btn small" aria-label="Next occurrence" title="Next Occurrence (Enter): older output" onClick={() => step(1)} disabled={!results?.count}>
          <Icon name="chevronUp" size={13} />
        </button>
        <span className="grow" />
        <button type="button" className="icon-btn small" aria-label="Close search" title="Close (Escape)" onClick={() => terminals.closeFind()}>
          <Icon name="close" size={11} />
        </button>
      </div>
    </div>
  );
}

function regexError(source: string): string | null {
  try {
    new RegExp(source);
    return null;
  } catch (e) {
    return String(e);
  }
}

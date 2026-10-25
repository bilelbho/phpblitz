// CSV and TSV files: each column in its own color, so a row is easy to follow across the line.
// A quoted field may run over several lines; the column count carries over with it.

import * as monaco from 'monaco-editor';

const COLORS = 6;

class CsvState implements monaco.languages.IState {
  constructor(
    readonly column: number,
    readonly quoted: boolean,
  ) {}
  clone() {
    return new CsvState(this.column, this.quoted);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof CsvState && other.column === this.column && other.quoted === this.quoted;
  }
}

monaco.languages.register({ id: 'csv', aliases: ['CSV', 'TSV'], extensions: ['.csv', '.tsv'] });

monaco.languages.setTokensProvider('csv', {
  getInitialState: () => new CsvState(0, false),
  tokenize(line, state) {
    let { column, quoted } = state as CsvState;
    // A row that isn't inside a quoted field starts at the first column.
    if (!quoted) column = 0;
    const tokens: monaco.languages.IToken[] = [];
    let i = 0;
    let start = 0;
    const cell = () => `csv.c${column % COLORS}`;
    while (i < line.length) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') i += 2;
        else {
          if (ch === '"') quoted = false;
          i++;
        }
        continue;
      }
      if (ch === '"' && i === start) {
        quoted = true;
        i++;
      } else if (ch === ',' || ch === ';' || ch === '\t') {
        if (i > start) tokens.push({ startIndex: start, scopes: cell() });
        tokens.push({ startIndex: i, scopes: 'delimiter' });
        column++;
        start = ++i;
      } else i++;
    }
    if (i > start || tokens.length === 0) tokens.push({ startIndex: start, scopes: cell() });
    return { tokens, endState: new CsvState(column, quoted) };
  },
});

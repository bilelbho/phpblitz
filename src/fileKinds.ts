// Files that open in a viewer instead of (or beside) the text editor: images and CSV tables.

const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

const extOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

/** Images shown from their bytes: they are never opened as text. */
export function isRasterImage(path: string): boolean {
  return RASTER.has(extOf(path));
}

export function isSvg(path: string): boolean {
  return extOf(path) === 'svg';
}

export function isCsv(path: string): boolean {
  const ext = extOf(path);
  return ext === 'csv' || ext === 'tsv';
}

/** The media type of a raster image, for a Blob. */
export function imageType(path: string): string {
  const ext = extOf(path);
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'ico') return 'image/x-icon';
  return `image/${ext}`;
}

/** .tsv is tab-separated; a .csv uses whichever of , ; tab appears most in its first line. */
export function csvDelimiter(path: string, text: string): string {
  if (extOf(path) === 'tsv') return '\t';
  const first = text.slice(0, text.search(/\r?\n|$/));
  let best = ',';
  let most = 0;
  for (const d of [',', ';', '\t']) {
    const n = first.split(d).length - 1;
    if (n > most) {
      best = d;
      most = n;
    }
  }
  return best;
}

/** RFC 4180: quoted fields may hold the delimiter, line breaks and "" for a quote. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

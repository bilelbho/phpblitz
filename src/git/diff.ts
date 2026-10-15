// Line diff (Myers' algorithm) for the editor's change markers: which lines were added,
// modified or deleted compared with the HEAD version of the file.

export interface Hunk {
  /** 1-based first line in the new text (for deletions: the line after the gap). */
  start: number;
  /** Lines in the new text (0 for a pure deletion). */
  count: number;
  /** The replaced lines from the old text. */
  oldLines: string[];
  /** 1-based first line in the old text. */
  oldStart: number;
  kind: 'added' | 'modified' | 'deleted';
}

/** Shortest edit script between two line arrays, as hunks of the new text. */
export function diffLines(a: string[], b: string[]): Hunk[] {
  // Skip the common head and tail: most edits touch a small part of a file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;
  if (!n && !m) return [];

  // Myers: furthest-reaching paths per diagonal, keeping each step's state to backtrack.
  const max = n + m;
  const offset = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
    // Very different files: report the whole middle as one change instead of spending more time.
    if (d > 4000) return [{ start: head + 1, count: m, oldLines: A, oldStart: head + 1, kind: n === 0 ? 'added' : m === 0 ? 'deleted' : 'modified' }];
  }

  // Backtrack into a list of edits.
  type Op = { t: 'eq' | 'del' | 'ins'; ai: number; bi: number };
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: 'eq', ai: --x, bi: --y });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: 'ins', ai: x, bi: --y });
      else ops.push({ t: 'del', ai: --x, bi: y });
    }
  }
  ops.reverse();

  // Group consecutive edits into hunks.
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === 'eq') {
      i++;
      continue;
    }
    const startB = ops[i].bi;
    const startA = ops[i].ai;
    const oldLines: string[] = [];
    let count = 0;
    while (i < ops.length && ops[i].t !== 'eq') {
      if (ops[i].t === 'del') oldLines.push(A[ops[i].ai]);
      else count++;
      i++;
    }
    hunks.push({
      start: head + startB + 1,
      count,
      oldLines,
      oldStart: head + startA + 1,
      kind: !oldLines.length ? 'added' : !count ? 'deleted' : 'modified',
    });
  }
  return hunks;
}

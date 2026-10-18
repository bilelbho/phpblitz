// A model answer split into text and fenced code blocks (the last one may still be streaming).

export type Segment = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string; closed: boolean };

export function splitAnswer(answer: string): Segment[] {
  const out: Segment[] = [];
  const fence = /^```([\w+-]*)[^\n]*\n/gm;
  let at = 0;
  for (let m = fence.exec(answer); m; m = fence.exec(answer)) {
    if (m.index < at) continue;
    if (m.index > at) out.push({ kind: 'text', text: answer.slice(at, m.index) });
    const body = m.index + m[0].length;
    const close = /^```[ \t]*$/m;
    close.lastIndex = 0;
    const rest = answer.slice(body);
    const end = close.exec(rest);
    if (!end) {
      out.push({ kind: 'code', lang: m[1], code: rest, closed: false });
      return out.filter((s) => s.kind === 'code' || s.text.trim());
    }
    out.push({ kind: 'code', lang: m[1], code: rest.slice(0, end.index).replace(/\n$/, ''), closed: true });
    at = body + end.index + end[0].length;
    fence.lastIndex = at;
  }
  if (at < answer.length) out.push({ kind: 'text', text: answer.slice(at) });
  return out.filter((s) => s.kind === 'code' || s.text.trim());
}

/** "1.2k" for token counts. */
export const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

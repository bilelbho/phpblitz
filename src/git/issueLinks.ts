// Issue links in commit messages: "#123" or "PROJ-45" as links to the issue. The patterns come from
// Settings ▸ Version Control ▸ Issue Navigation, plus #N for a GitHub, GitLab or Bitbucket origin.

/** A regular expression and the link it makes: $0 is the whole match, $1… its groups. */
export interface IssueLink {
  pattern: string;
  url: string;
}

export type MessagePart = string | { text: string; url: string };

/** #N → the origin's issues, when the origin is on a host whose issue URLs are known. */
export function remoteIssueLink(remoteUrl: string): IssueLink | null {
  // https://github.com/owner/repo(.git), git@github.com:owner/repo.git, ssh://git@host/owner/repo
  const m = remoteUrl.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const path = m[2];
  if (host === 'github.com') return { pattern: '#(\\d+)', url: `https://github.com/${path}/issues/$1` };
  if (host === 'gitlab.com') return { pattern: '#(\\d+)', url: `https://gitlab.com/${path}/-/issues/$1` };
  if (host === 'bitbucket.org') return { pattern: '#(\\d+)', url: `https://bitbucket.org/${path}/issues/$1` };
  return null;
}

const WEB_URL = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

/** The message cut into plain text and links (web addresses, and matches of the patterns). */
export function linkify(text: string, links: IssueLink[]): MessagePart[] {
  const found: { start: number; end: number; url: string }[] = [];
  const add = (start: number, end: number, url: string) => {
    if (start < end && !found.some((f) => start < f.end && f.start < end)) found.push({ start, end, url });
  };
  for (const m of text.matchAll(WEB_URL)) add(m.index, m.index + m[0].length, m[0]);
  for (const link of links) {
    let re: RegExp;
    try {
      re = new RegExp(link.pattern, 'g');
    } catch {
      continue; // A pattern still being typed.
    }
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      // Not inside a word: "abc#12" or "XPROJ-4" stay text.
      if (m.index > 0 && /\w/.test(text[m.index - 1]) && /^\w/.test(m[0])) continue;
      const url = link.url.replace(/\$(\d)/g, (_, i: string) => encodeURIComponent(m[Number(i)] ?? ''));
      if (/^https?:\/\//i.test(url)) add(m.index, m.index + m[0].length, url);
    }
  }
  found.sort((a, b) => a.start - b.start);
  const parts: MessagePart[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) parts.push(text.slice(at, f.start));
    parts.push({ text: text.slice(f.start, f.end), url: f.url });
    at = f.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

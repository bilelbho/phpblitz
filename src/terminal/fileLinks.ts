// File paths in terminal output as links: `app/Models/User.php:42`, PHP's "in /var/www/app/User.php
// on line 42", stack traces' `/app/src/Foo.php(17)`. Only paths that are files of the project become
// links, so ordinary text isn't underlined; paths from a container (Docker, Sail) are matched to the
// project file they end with.

export interface FileRef {
  /** Character range in the line. */
  start: number;
  end: number;
  path: string;
  line?: number;
  column?: number;
}

const EXTENSIONS = 'php|phtml|inc|blade\\.php|twig|js|mjs|cjs|jsx|ts|mts|tsx|vue|svelte|json|ya?ml|xml|neon|env|ini|md|css|scss|less|html?|sql|sh|lock';

// A path (drive letter, slashes, dots…) ending in a known extension, then where in it: `:12`, `:12:5`,
// `(12)`, ` on line 12`, `", line 12`, ` line 12`.
const REF = new RegExp(
  String.raw`(?<![\w/\\.:-])((?:[A-Za-z]:)?[\w~@.\/\\-]*?[\w-]+\.(?:${EXTENSIONS}))(?![\w-])(?::(\d+)(?::(\d+))?|\((\d+)\)|,? on line (\d+)|",? line (\d+)| line (\d+))?`,
  'g',
);

/** The file references in a line of output. */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  for (const m of text.matchAll(REF)) {
    const start = m.index ?? 0;
    // URLs are the web links' business.
    if (/[a-z]+:\/\/\S*$/i.test(text.slice(0, start))) continue;
    const line = Number(m[2] ?? m[4] ?? m[5] ?? m[6] ?? m[7]) || undefined;
    out.push({ start, end: start + m[0].length, path: m[1], line, column: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

/** Finds the project file a reference means. */
export class FileResolver {
  private files = new Set<string>();
  private lower = new Map<string, string>();
  private byName = new Map<string, string[]>();

  constructor(
    private root: string,
    files: string[],
  ) {
    for (const f of files) {
      this.files.add(f);
      this.lower.set(f.toLowerCase(), f);
      const name = f.slice(f.lastIndexOf('/') + 1).toLowerCase();
      this.byName.set(name, [...(this.byName.get(name) ?? []), f]);
    }
  }

  private known(path: string): string | null {
    return this.files.has(path) ? path : (this.lower.get(path.toLowerCase()) ?? null);
  }

  resolve(ref: string, cwd: string): string | null {
    const path = ref.replace(/\\/g, '/');
    const absolute = /^([A-Za-z]:)?\//.test(path);
    const candidates = absolute ? [path] : [join(cwd, path), join(this.root, path)];
    for (const c of candidates) {
      const hit = this.known(c);
      if (hit) return hit;
    }
    // A path from elsewhere (a container, another checkout): the project file it ends with, using
    // as much of its end as matches. A bare file name only when it's unique.
    const parts = path.split('/').filter(Boolean);
    const same = this.byName.get(parts[parts.length - 1]?.toLowerCase() ?? '') ?? [];
    for (let take = parts.length; take >= 1; take--) {
      const tail = '/' + parts.slice(parts.length - take).join('/').toLowerCase();
      const found = same.filter((f) => f.toLowerCase().endsWith(tail));
      if (found.length === 1 && (take > 1 || same.length === 1)) return found[0];
      if (found.length > 1) return null;
    }
    return null;
  }
}

/** `base` + a relative path, with `.` and `..` resolved. */
function join(base: string, rel: string): string {
  const parts = base.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}

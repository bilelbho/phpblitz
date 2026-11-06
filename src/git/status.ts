// `git status --porcelain=v2 --branch -z -uall`: the branch and the changed files in one call.
// With -z, entries end with NUL and paths come as they are (no quoting or octal escapes), so
// names like Prüfung.php or "my file.php" survive. Entry kinds:
//   # branch.head <name>|(detached)
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                ordinary change
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<orig>  rename or copy
//   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>       unmerged (conflict)
//   ? <path>                                                     untracked

import type { ChangeStatus, ConflictKind, GitChange } from '../backend/types';

export interface ParsedStatus {
  /** Branch name; 'HEAD' when detached. */
  branch: string;
  /** Paths relative to the repository root. */
  changes: { path: string; status: ChangeStatus; from?: string; conflict?: ConflictKind }[];
}

/** Unmerged entries' XY: D deleted, A added, U changed, on our side then theirs. */
const CONFLICTS: Record<string, ConflictKind> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  DU: 'deleted-by-us',
  UD: 'deleted-by-them',
  AU: 'added-by-us',
  UA: 'added-by-them',
};

/** Fields before the path, per entry kind (the path may contain spaces). */
const FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10 };

function statusOf(xy: string): ChangeStatus {
  if (xy.includes('A')) return 'A';
  if (xy.includes('D')) return 'D';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  return 'M';
}

export function parseStatusV2(output: string): ParsedStatus {
  const entries = output.split('\0');
  let branch = 'HEAD';
  const changes: ParsedStatus['changes'] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith('# branch.head ')) {
      const head = e.slice('# branch.head '.length);
      branch = head === '(detached)' ? 'HEAD' : head;
      continue;
    }
    if (e.startsWith('#')) continue;
    const kind = e[0];
    if (kind === '?') {
      changes.push({ path: e.slice(2), status: 'U' });
      continue;
    }
    const fields = FIELDS[kind];
    if (!fields) continue; // '!' ignored files, or something newer git adds
    // The path is everything after the fixed fields (it may contain spaces).
    let at = 0;
    for (let f = 0; f < fields; f++) at = e.indexOf(' ', at) + 1;
    const path = e.slice(at);
    const xy = e.slice(2, 4);
    if (kind === '2') {
      // The original path is the next NUL-separated field.
      changes.push({ path, status: 'R', from: entries[++i] });
    } else if (kind === 'u') {
      changes.push({ path, status: 'C', conflict: CONFLICTS[xy] ?? 'both-modified' });
    } else {
      changes.push({ path, status: statusOf(xy) });
    }
  }
  return { branch, changes };
}

/** Absolute paths for the UI. */
export function toChanges(root: string, parsed: ParsedStatus): GitChange[] {
  return parsed.changes.map((c) => ({ path: `${root}/${c.path}`, status: c.status, ...(c.conflict ? { conflict: c.conflict } : {}) }));
}

/** The branch a merge brings in, from MERGE_MSG ("Merge branch 'feature' into main", "Merge remote-tracking branch 'origin/x'"). */
export function mergeSource(message: string): string | undefined {
  return message.split('\n')[0].match(/'([^']+)'/)?.[1];
}

// Several Git repositories in one project: the project's own (when it is one), repositories in
// its first two folder levels (packages/api, a cloned library…), and its submodules anywhere.

import type { Backend, GitChange, GitInfo } from '../backend/types';

/** Folders not looked into for repositories (dependencies, build output, tool folders). */
const SKIP = new Set(['.git', 'node_modules', 'vendor', '.idea', '.vscode', '.blitz', 'var', 'cache', 'dist', 'build', 'target', 'tmp', 'storage', 'public']);
/** At most this many folders are listed while looking (a huge project stays quick to open). */
const MAX_LISTED = 300;

/** The repositories' folders below the project root (absolute, sorted); the root itself isn't among them. */
export async function findRepositories(backend: Backend): Promise<string[]> {
  const found = new Set<string>();
  // Submodules, at any depth: .gitmodules says where.
  const modules = await backend.git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']).catch(() => null);
  if (modules?.code === 0) {
    for (const line of modules.stdout.split('\n')) {
      const path = line.trim().split(/\s+/).slice(1).join(' ');
      if (path) found.add(`${backend.root}/${path.replace(/\\/g, '/').replace(/\/+$/, '')}`);
    }
  }
  // Folders with a .git of their own (a folder, or a file for a worktree / submodule), two levels
  // down. Folder listings leave .git out, so it's looked for by reading what's in one.
  const isRepository = async (dir: string) =>
    (await backend.readFile(`${dir}/.git/HEAD`).then(
      () => true,
      () => false,
    )) || (await backend.readFile(`${dir}/.git`).then((t) => t.startsWith('gitdir:'), () => false));
  let listed = 0;
  const look = async (dir: string, depth: number) => {
    if (listed++ >= MAX_LISTED) return;
    const entries = await backend.listDir(dir).catch(() => []);
    const dirs = entries.filter((e) => e.isDir && !SKIP.has(e.name) && !e.name.startsWith('.'));
    await Promise.all(
      dirs.map(async (d) => {
        if (await isRepository(d.path)) found.add(d.path.replace(/\\/g, '/'));
        else if (depth < 2) await look(d.path, depth + 1);
      }),
    );
  };
  await look(backend.root, 1);
  return [...found].filter((p) => p !== backend.root).sort();
}

/**
 * The project's changes from each repository's status, as one list. A repository's own status
 * shows the ones inside it as a changed or new folder: those entries are left out.
 */
export function combinedChanges(infos: { root: string; info: GitInfo | null }[]): GitChange[] {
  const roots = infos.map((r) => r.root);
  const out: GitChange[] = [];
  for (const { root, info } of infos) {
    for (const c of info?.changes ?? []) {
      const path = c.path.replace(/\/+$/, '');
      // Another repository's folder, or a file inside one (the deeper repository reports it).
      if (roots.some((r) => r !== root && r.startsWith(root + '/') && (path === r || path.startsWith(r + '/')))) continue;
      out.push(path === c.path ? c : { ...c, path });
    }
  }
  return out;
}

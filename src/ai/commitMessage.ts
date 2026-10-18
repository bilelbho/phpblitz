// A commit message for the changes being committed, from the fast model: the diff of the included
// files against HEAD, the names of new files, and the recent subjects for the project's style.

import type { Workspace } from '../useWorkspace';
import { getSettings } from '../settings';
import { streamAi, type AiStream } from './client';

const MAX_DIFF = 40_000;

const SYSTEM = `You write git commit messages. You get the changes being committed and the repository's recent commit subjects.
Answer with only the message: a first line under 72 characters in the imperative mood ("Add…", "Fix…") that says what changed and why it matters, in the style of the recent subjects; then, for changes that need it, a blank line and a few short "- " lines about the important parts. No Markdown headings, no code fences, no quotes around it.`;

/** Streams a message into `onText`; `cancel` on the result stops it. */
export async function generateCommitMessage(ws: Workspace, changes: { path: string; status: string }[], onText: (all: string) => void): Promise<AiStream> {
  const root = ws.backend.root;
  const rel = (p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const tracked = changes.filter((c) => c.status !== 'U').map((c) => rel(c.path));
  const added = changes.filter((c) => c.status === 'U').map((c) => rel(c.path));
  const diff = tracked.length ? (await ws.gitRepo.run(['diff', 'HEAD', '--no-color', '--', ...tracked], { allowFail: true, quiet: true })).stdout : '';
  const subjects = (await ws.gitRepo.log({ max: 10 }).catch(() => [])).map((c) => `- ${c.subject}`);
  const content = [
    subjects.length ? `Recent commit subjects:\n${subjects.join('\n')}` : '',
    added.length ? `New files:\n${added.map((p) => `- ${p}`).join('\n')}` : '',
    `Diff:\n${diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff cut, ${diff.length - MAX_DIFF} more characters)` : diff || '(only new files)'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return streamAi({ model: getSettings().ai.fastModel, maxTokens: 400, temperature: 0.2, system: SYSTEM, messages: [{ role: 'user', content }] }, (_piece, all) => onText(all.trim()));
}

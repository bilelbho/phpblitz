// Interactive rebase: the steps the dialog lets you set (oldest commit first, as git runs them) and
// the todo list git gets for them. A reworded commit is picked, then amended with its new message
// by an `exec` line, so no editor ever opens.

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseStep {
  hash: string;
  action: RebaseAction;
  /** Reword: the new message. */
  message?: string;
}

export const REBASE_ACTIONS: [RebaseAction, string][] = [
  ['pick', 'Pick'],
  ['reword', 'Reword'],
  ['edit', 'Stop to Edit'],
  ['squash', 'Squash'],
  ['fixup', 'Fixup'],
  ['drop', 'Drop'],
];

/** Why these steps can't run (null when they can). */
export function rebaseProblem(steps: RebaseStep[]): string | null {
  const kept = steps.filter((s) => s.action !== 'drop');
  if (!kept.length) return 'Every commit is dropped: use Reset Current Branch instead.';
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') return 'The first commit kept can’t be squashed or fixed up: there is no commit before it to join.';
  if (steps.some((s) => s.action === 'reword' && !s.message?.trim())) return 'A reworded commit needs a message.';
  return null;
}

/** The todo list; `messageFile(i)` is where step i's new message is written (rewords only). */
export function rebaseTodo(steps: RebaseStep[], messageFile: (i: number) => string): string {
  const lines: string[] = [];
  steps.forEach((s, i) => {
    if (s.action === 'reword') {
      lines.push(`pick ${s.hash}`);
      lines.push(`exec git commit --amend --allow-empty --quiet --file "${messageFile(i)}"`);
    } else lines.push(`${s.action} ${s.hash}`);
  });
  return lines.join('\n') + '\n';
}

/** Moves step `i` up (-1) or down (1); the list as it is when it can't move. */
export function moveStep(steps: RebaseStep[], i: number, dir: -1 | 1): RebaseStep[] {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return steps;
  const next = [...steps];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

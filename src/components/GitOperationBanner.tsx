// A merge, rebase, cherry-pick or revert that stopped: what it is, its conflicts, and the way on
// (Resolve, Continue, Skip) or back (Abort). Shown above the Commit panel's changes.

import type { Workspace } from '../useWorkspace';
import type { GitOperation } from '../backend/types';
import { confirmDialog } from '../platform';
import { Icon } from './Icon';

export function operationName(op: GitOperation): string {
  switch (op.kind) {
    case 'merge':
      return `Merging${op.incoming ? ` ${op.incoming}` : ''}`;
    case 'rebase':
      return `Rebasing${op.branch ? ` ${op.branch}` : ''}${op.step ? ` (${op.step})` : ''}`;
    case 'cherry-pick':
      return `Cherry-picking${op.incoming ? ` ${op.incoming}` : ''}`;
    case 'revert':
      return `Reverting${op.incoming ? ` ${op.incoming}` : ''}`;
  }
}

export const OPERATION_VERB: Record<GitOperation['kind'], string> = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };

/** Abort, after asking: it throws away what was done to resolve conflicts. */
export async function abortOperation(ws: Workspace) {
  const op = ws.git?.operation;
  if (!op) return;
  const what = op.kind === 'merge' ? 'the merge' : op.kind === 'rebase' ? 'the rebase: the branch goes back to where it was' : `the ${op.kind}`;
  if (await confirmDialog(`Abort ${what}? Changes made to resolve conflicts are lost.`)) await ws.runGit(`Abort ${OPERATION_VERB[op.kind].toLowerCase()}`, () => ws.gitRepo.abortOperation(op.kind));
}

export function GitOperationBanner({ ws }: { ws: Workspace }) {
  const op = ws.git?.operation;
  if (!op) return null;
  const conflicts = (ws.git?.changes ?? []).filter((c) => c.status === 'C').length;
  const verb = OPERATION_VERB[op.kind];

  return (
    <div className={'git-op-banner' + (conflicts ? ' conflicted' : '')} role="status">
      <Icon name={conflicts ? 'warning' : 'branch'} size={14} />
      <span className="git-op-text">
        {operationName(op)}
        {conflicts ? ` · ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}` : op.kind === 'rebase' ? ' · stopped' : ' · conflicts resolved'}
      </span>
      <span className="git-op-actions">
        {conflicts > 0 && (
          <button type="button" className="btn small primary" onClick={() => ws.setGitDialog({ kind: 'conflicts' })}>
            Resolve…
          </button>
        )}
        <button
          type="button"
          className={'btn small' + (conflicts ? '' : ' primary')}
          disabled={conflicts > 0}
          title={conflicts ? 'Resolve the conflicts first' : `Continue the ${op.kind} (commits with git's prepared message)`}
          onClick={() => void ws.runGit(`Continue ${verb.toLowerCase()}`, () => ws.gitRepo.continueOperation(op.kind))}
        >
          Continue
        </button>
        {op.kind !== 'merge' && (
          <button type="button" className="btn small" title="Leave out the commit that stopped, go on with the next" onClick={() => void ws.runGit(`Skip commit`, () => ws.gitRepo.skipCommit(op.kind))}>
            Skip
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={() => void abortOperation(ws)}>
          Abort
        </button>
      </span>
    </div>
  );
}

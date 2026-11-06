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

/** The current repository's operation, and a line for each other repository that's in the middle of one. */
export function GitOperationBanner({ ws }: { ws: Workspace }) {
  const several = ws.repositoryList.length > 1;
  const others = ws.repositoryList.filter((r) => r.root !== ws.gitRepo.root && r.operation);
  return (
    <>
      <CurrentOperation ws={ws} several={several} />
      {others.map((r) => (
        <div key={r.root} className={'git-op-banner other' + (r.conflicts ? ' conflicted' : '')} role="status">
          <Icon name={r.conflicts ? 'warning' : 'branch'} size={14} />
          <span className="git-op-text">
            <span className="git-op-repo">{r.name}:</span> {operationName(r.operation!)}
            {r.conflicts ? ` · ${r.conflicts} ${r.conflicts === 1 ? 'conflict' : 'conflicts'}` : ''}
          </span>
          <span className="git-op-actions">
            <button type="button" className="btn small" title={`Make ${r.name} the current repository, to continue or abort there`} onClick={() => ws.setCurrentRepo(r.root)}>
              Switch to It
            </button>
          </span>
        </div>
      ))}
    </>
  );
}

function CurrentOperation({ ws, several }: { ws: Workspace; several: boolean }) {
  const op = ws.git?.operation;
  if (!op) return null;
  // This repository's conflicts (the Commit panel lists every repository's changes).
  const own = ws.repositoryList.find((r) => r.root === ws.gitRepo.root);
  const conflicts = own ? own.conflicts : (ws.git?.changes ?? []).filter((c) => c.status === 'C').length;
  const verb = OPERATION_VERB[op.kind];

  return (
    <div className={'git-op-banner' + (conflicts ? ' conflicted' : '')} role="status">
      <Icon name={conflicts ? 'warning' : 'branch'} size={14} />
      <span className="git-op-text">
        {several && own && <span className="git-op-repo">{own.name}: </span>}
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

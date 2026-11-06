# Git

PHPBlitz uses the `git` on your `PATH`.

- **Change markers** in the gutter: click one to see the old lines and roll them back.
- **Diff viewer**: side by side or inline, from the Commit window, the log, or a file's menu.
- **Commit** (<kbd>Ctrl+K</kbd>): check the files to commit; amend and fixup commits; a
  menu on every file and group (commit only these, *Add to .gitignore*, *Copy as Patch…*). ✨ writes
  the message from your changes with [AI](./ai), when you've set it up.
- **Rollback…** opens a panel where you check the files to put back.
- **Push** (<kbd>Ctrl+Shift+K</kbd>), **pull** (*Update Project*, <kbd>Ctrl+T</kbd>).
- **Branches**: the branch button in the top bar lists them, creates, checks out, merges and
  rebases.
- **Log** (<kbd>Alt+9</kbd>): every branch with its graph, a search by text or hash, and each
  commit's files and diff.
- **Annotate with Git Blame**: who changed each line, from the gutter's right-click menu.
- **Stash** and unstash.

## Committing part of your work

- **Partial commits**: in the diff of a changed file, check or uncheck each change, so only some of
  a file's changes go into the commit.
- **Changelists**: group changes under names (right-click ▸ *Move to Changelist*), and commit one
  list at a time. New changes go to the active list.
- **Shelf** (the Commit window's *Shelf* tab): *Shelve Changes…* puts changes aside and takes them
  out of your files; unshelve them later, all or a few files. **Stash** has its own tab too.
- **Patches**: *Create Patch…* or *Copy as Patch to Clipboard* from the Commit window or a commit
  in the Log; *Git ▸ Patch ▸ Apply Patch…* applies one.

## Merges, rebases and conflicts

- **Conflicts**: when a merge, rebase, cherry-pick, pull or unstash stops on conflicts, the
  *Conflicts* dialog lists the files. Take one side whole, or open the **merge editor**: your
  version, the result and theirs side by side, with arrows to take each change, a button that
  applies every change without a conflict at once, and the result editable by hand.
- **Continue or Abort**: a banner above the Commit window's changes says what's in progress
  (merging, rebasing…) and how many conflicts are left, with *Resolve…*, *Continue*, *Skip* and
  *Abort*.
- **Interactive rebase**: right-click a commit in the Log ▸ *Interactively Rebase from Here…* to
  pick, reword, squash, fix up, drop or reorder the commits after it.
- **Cherry-pick** a commit from the Log, and **compare branches** from the branch button
  (*Compare with '…'*): the commits each has that the other hasn't, and the files that differ.
- **Diffs**: side by side or unified, unchanged parts folded, whitespace ignored or not, and moved
  code marked as moved.
- **Inline blame**: the last change of the caret's line, at the end of the line.

## GitHub pull requests

With the [GitHub CLI](https://cli.github.com/) (`gh`) installed and signed in (`gh auth login`),
*Git ▸ GitHub ▸ Pull Requests* lists the repository's pull requests in the Git window: their
description, checks, reviews, comments and changed files. Check one out, review its diff, comment,
approve, merge it, or create one from your branch (*Create Pull Request…*).

Issue numbers in commit messages (`#123`, `PROJ-42`) become links: *Settings ▸ Version Control ▸
Issue Navigation* sets where they point.

## Several repositories

A project with Git repositories in its folders (packages, libraries, submodules) shows all their
changes in one Commit window, and commits to each its own changes. The branch button names the
current repository and switches between them. If another repository is in the middle of a merge or
rebase, the Commit window says so, with *Switch to It*. The Git console (in the Git window) lists
the commands of every repository, each with its name.

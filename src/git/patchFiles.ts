// Create Patch / Apply Patch: a patch saved to or read from a file the user picks, or the clipboard.

import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Workspace } from '../useWorkspace';
import { isTauri } from '../platform';

const FILTERS = [{ name: 'Patches', extensions: ['patch', 'diff'] }];

/** Asks where, then saves the patch there; false when cancelled. */
export async function savePatch(ws: Workspace, patch: string, name: string): Promise<boolean> {
  if (!patch.trim()) {
    ws.notify({ title: "Couldn't create the patch", body: 'There are no differences.', tone: 'error' });
    return false;
  }
  if (!isTauri) {
    await navigator.clipboard.writeText(patch).catch(() => {});
    ws.setStatus('Copied the patch (saving files needs the desktop app).');
    return true;
  }
  const path = await save({ title: 'Create Patch', defaultPath: `${ws.backend.root}/${name.replace(/[\\/:*?"<>|]+/g, '-')}.patch`, filters: FILTERS });
  if (!path) return false;
  await invoke<void>('write_file', { path, content: patch });
  ws.notify({ title: 'Patch created', body: path, tone: 'success' });
  return true;
}

/** Applies a patch; files where lines it changes were changed here too get conflict markers (said so). */
async function apply(ws: Workspace, label: string, text: string) {
  await ws.runGit(label, async () => {
    const { conflicted } = await ws.gitRepo.applyPatch(text);
    if (conflicted.length) {
      ws.notify({
        title: `Applied with conflicts in ${conflicted.length === 1 ? conflicted[0].split('/').pop() : `${conflicted.length} files`}`,
        body: 'Lines the patch changes were changed here too: look for <<<<<<< in the file.',
        tone: 'warning',
        action: { label: 'Open', run: () => void ws.openFile(`${ws.gitRepo.root}/${conflicted[0]}`) },
      });
    }
  });
}

/** Apply Patch…: picks a .patch file and applies it to the working tree. */
export async function applyPatchFile(ws: Workspace) {
  if (!isTauri) return;
  const path = await open({ title: 'Apply Patch', multiple: false, directory: false, filters: FILTERS });
  if (typeof path !== 'string') return;
  const text = await ws.backend.readFile(path.replace(/\\/g, '/'));
  await apply(ws, `Apply ${path.split(/[\\/]/).pop()}`, text);
}

/** Apply Patch from Clipboard. */
export async function applyPatchFromClipboard(ws: Workspace) {
  const text = await navigator.clipboard.readText().catch(() => '');
  if (!/^(diff --git|--- |From [0-9a-f]{40})/m.test(text)) {
    ws.notify({ title: 'No patch on the clipboard', body: 'Copy a patch (git diff output) first.', tone: 'warning' });
    return;
  }
  await apply(ws, 'Apply patch from the clipboard', text);
}

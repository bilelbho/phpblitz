import type { Workspace } from '../useWorkspace';
import { getSettings } from '../settings';

/** Folder new terminal tabs start in: Settings ▸ Start directory, else the project root. */
export function terminalStartDir(ws: Workspace): string {
  const configured = getSettings().terminal.startDir.trim();
  if (configured) return configured;
  return ws.backend.kind === 'disk' ? ws.backend.root : '';
}

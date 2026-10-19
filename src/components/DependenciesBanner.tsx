// Above the editor while the project's Composer packages aren't installed (composer.json lists
// packages, vendor/autoload.php is missing): why classes from packages are unknown, and the fix.
// Type checking is held back meanwhile (see mago.rs), so the editor doesn't fill with false errors.

import { useState } from 'react';
import type { Workspace } from '../useWorkspace';
import { Icon } from './Icon';

export function DependenciesBanner({ ws }: { ws: Workspace }) {
  // Hidden for this project until it's reopened.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  if (!ws.magoStatus.summary?.needsInstall || hiddenFor === ws.backend.root) return null;
  const held = ws.projectProblemsHidden;
  return (
    <div className="deps-banner" role="status">
      <Icon name="warning" size={14} />
      <span className="grow">
        Dependencies aren't installed: classes from packages can't be found, so type checking is off
        {held > 0 ? ` (${held.toLocaleString()} problems held back).` : '.'}
      </span>
      <button type="button" className="btn small primary" onClick={ws.composerInstall}>
        Run composer install
      </button>
      <button type="button" className="icon-btn small" aria-label="Hide" title="Hide until the project is reopened" onClick={() => setHiddenFor(ws.backend.root)}>
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}

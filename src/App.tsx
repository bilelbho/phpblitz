import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Backend } from './backend/types';
import { DiskBackend } from './backend/disk';
import { SampleBackend } from './backend/sample';
import { isTauri, pickFolder, rememberProject } from './platform';
import { Welcome } from './components/Welcome';
import { WorkspaceView } from './components/WorkspaceView';

export default function App() {
  const [backend, setBackend] = useState<Backend | null>(null);

  const openPath = useCallback((path: string) => {
    const b = new DiskBackend(path);
    rememberProject(b.root);
    setBackend(b);
  }, []);

  const openFolder = useCallback(async () => {
    const path = await pickFolder();
    if (path) openPath(path);
  }, [openPath]);

  const openSample = useCallback(() => setBackend(new SampleBackend()), []);

  useEffect(() => {
    const title = backend ? `${backend.name} – PHPBlitz` : 'PHPBlitz';
    document.title = title;
    if (isTauri) getCurrentWindow().setTitle(title).catch(() => {});
  }, [backend]);

  if (!backend) return <Welcome onOpenFolder={openFolder} onOpenPath={openPath} onOpenSample={openSample} />;
  return (
    <WorkspaceView
      key={`${backend.kind}:${backend.root}`}
      backend={backend}
      onOpenFolder={openFolder}
      onOpenPath={openPath}
      onClose={() => setBackend(null)}
    />
  );
}

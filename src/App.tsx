import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Backend } from './backend/types';
import { DiskBackend } from './backend/disk';
import { SampleBackend } from './backend/sample';
import { isTauri, pickFolder, rememberProject } from './platform';
import { useApplyUiSettings } from './uiSettings';
import { useSettings } from './settings';
import { Welcome } from './components/Welcome';
import { WorkspaceView } from './components/lazy';
import { projectStorage } from './projectStorage';
import { perf } from './perf';

export default function App() {
  const [backend, setBackend] = useState<Backend | null>(null);

  const openPath = useCallback(async (path: string) => {
    const b = new DiskBackend(path);
    rememberProject(b.root);
    perf.begin(b.root);
    // Its .blitz settings first: the workspace reads them as it opens.
    await perf.time('Project settings (.blitz)', projectStorage.open(b.root));
    setBackend(b);
  }, []);

  const openFolder = useCallback(async () => {
    const path = await pickFolder();
    if (path) openPath(path);
  }, [openPath]);

  const openSample = useCallback(() => {
    void projectStorage.close();
    perf.begin('sample project');
    setBackend(new SampleBackend());
  }, []);

  useApplyUiSettings();
  const fullPath = useSettings().ui.fullPathInTitle;
  useEffect(() => {
    const title = backend ? `${fullPath && backend.kind === 'disk' ? backend.root : backend.name} – PHPBlitz` : 'PHPBlitz';
    document.title = title;
    if (isTauri) getCurrentWindow().setTitle(title).catch(() => {});
  }, [backend, fullPath]);

  if (!backend) return <Welcome onOpenFolder={openFolder} onOpenPath={openPath} onOpenSample={openSample} />;
  return (
    <WorkspaceView
      key={`${backend.kind}:${backend.root}`}
      backend={backend}
      onOpenFolder={openFolder}
      onOpenPath={openPath}
      onClose={() => {
        void projectStorage.close();
        setBackend(null);
      }}
    />
  );
}

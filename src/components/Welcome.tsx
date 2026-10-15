import { Icon, Logo } from './Icon';
import { isTauri, recentProjects } from '../platform';
import { WindowControls, projectColor } from './WindowControls';

interface Props {
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onOpenSample: () => void;
}

export function Welcome({ onOpenFolder, onOpenPath, onOpenSample }: Props) {
  const recent = isTauri ? recentProjects() : [];
  return (
    <div className="app">
      <header className="topbar" data-tauri-drag-region>
        <span style={{ display: 'inline-flex', padding: '0 8px' }}>
          <Logo size={20} />
        </span>
        <span className="tw-title" data-tauri-drag-region>
          Welcome to PHPBlitz
        </span>
        <div className="drag" data-tauri-drag-region />
        <WindowControls />
      </header>
      <main className="welcome island">
        <div className="welcome-box">
          <h1>
            <Logo size={40} />
            PHPBlitz
          </h1>
          <p>A fast PHP IDE. Open a project folder to start, or try the built-in sample Laravel project.</p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={onOpenFolder} disabled={!isTauri}>
              <Icon name="folderOpen" />
              Open…
            </button>
            <button type="button" className="btn" onClick={onOpenSample}>
              Open Sample Project
            </button>
          </div>
          {!isTauri && <p className="muted">Opening folders only works in the desktop app (npm run tauri dev).</p>}
          {recent.length > 0 && (
            <div>
              <div className="recent-title">Recent projects</div>
              {recent.map((path) => {
                const name = path.split('/').pop() ?? path;
                return (
                  <button key={path} type="button" className="recent" onClick={() => onOpenPath(path)}>
                    <span className="project-square" style={{ background: projectColor(name), width: 28, height: 28, borderRadius: 6 }}>
                      {name.slice(0, 2).toUpperCase()}
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span>{name}</span>
                      <span className="path">{path}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

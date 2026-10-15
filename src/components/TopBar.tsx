import type { Workspace } from '../useWorkspace';
import { isTauri, recentProjects } from '../platform';
import { Icon, Play } from './Icon';
import { MenuButton, type MenuEntry } from './Menu';
import { WindowControls, projectColor } from './WindowControls';
import type { SearchTab } from './SearchEverywhere';

interface Props {
  ws: Workspace;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
  onSearch: (tab?: SearchTab) => void;
}

export function TopBar({ ws, onOpenFolder, onOpenPath, onClose, onSearch }: Props) {
  const { backend } = ws;
  const initials = backend.name
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  const mainMenu: MenuEntry[] = [
    { kind: 'head', label: 'File' },
    { label: 'Open…', run: onOpenFolder, disabled: !isTauri },
    { label: 'Save', shortcut: 'Ctrl+S', run: ws.saveActive, disabled: !ws.activePath },
    { label: 'Close Project', run: onClose },
    { kind: 'sep' },
    { kind: 'head', label: 'Navigate' },
    { label: 'Search Everywhere', shortcut: 'Double Shift', run: () => onSearch('all') },
    { label: 'Class…', shortcut: 'Ctrl+N', run: () => onSearch('classes') },
    { label: 'File…', shortcut: 'Ctrl+Shift+N', run: () => onSearch('files') },
    { label: 'Find in Files…', shortcut: 'Ctrl+Shift+F', run: () => ws.openFindInFiles('find') },
    { label: 'Replace in Files…', shortcut: 'Ctrl+Shift+R', run: () => ws.openFindInFiles('replace') },
    { kind: 'sep' },
    { kind: 'head', label: 'View' },
    { label: 'Project', run: () => ws.toggleLeft('project') },
    { label: 'Structure', run: () => ws.toggleLeft('structure') },
    { label: 'Terminal', run: () => ws.showBottom('terminal') },
    { label: 'Problems', run: () => ws.showBottom('problems') },
    { kind: 'sep' },
    { label: 'Run Tests', run: ws.runTests },
    { label: 'Commit…', shortcut: 'Ctrl+K', run: () => ws.showLeft('commit') },
  ];

  const projectMenu = (): MenuEntry[] => [
    { kind: 'head', label: 'Recent Projects' },
    ...recentProjects()
      .filter((p) => p !== backend.root)
      .slice(0, 6)
      .map((p) => ({ label: p.split('/').pop() ?? p, run: () => onOpenPath(p) })),
    { kind: 'sep' },
    { label: 'Open…', run: onOpenFolder, disabled: !isTauri },
    { label: 'Close Project', run: onClose },
  ];

  const gitMenu: MenuEntry[] = [
    { kind: 'head', label: `Current branch: ${ws.git?.branch ?? '—'}` },
    { label: 'Commit…', shortcut: 'Ctrl+K', run: () => ws.showLeft('commit') },
    { label: 'Refresh Status', run: ws.refreshGit },
  ];

  const runMenu: MenuEntry[] = [
    { label: 'Run Tests', run: ws.runTests },
    { label: 'Check Composer Updates', run: () => { ws.setRightTool('composer'); ws.checkOutdated(); } },
    { label: 'Open Terminal', run: () => ws.showBottom('terminal') },
  ];

  return (
    <header className="topbar" data-tauri-drag-region style={{ ['--project-color' as string]: projectColor(backend.name) }}>
      <MenuButton className="top-icon" label="Main menu" title="Main Menu" entries={mainMenu}>
        <Icon name="menu" />
      </MenuButton>
      <MenuButton className="widget" label={`Project ${backend.name}`} entries={projectMenu}>
        <span className="project-square" style={{ background: projectColor(backend.name) }}>
          {initials || 'P'}
        </span>
        {backend.name}
        <span className="chevron">
          <Icon name="chevronDown" size={12} strokeWidth={2.2} />
        </span>
      </MenuButton>
      {ws.git && (
        <MenuButton className="widget" label={`Git branch ${ws.git.branch}`} entries={gitMenu}>
          <Icon name="branch" size={15} />
          {ws.git.branch}
          <span className="chevron">
            <Icon name="chevronDown" size={12} strokeWidth={2.2} />
          </span>
        </MenuButton>
      )}

      <div className="drag" data-tauri-drag-region />

      <MenuButton className="widget" label="Run configuration PHPUnit" entries={runMenu}>
        <span className="badge" style={{ background: '#5fb865' }}>T</span>
        PHPUnit
        <span className="chevron">
          <Icon name="chevronDown" size={12} strokeWidth={2.2} />
        </span>
      </MenuButton>
      <button type="button" className="top-icon" aria-label="Run tests" title="Run 'PHPUnit'" style={{ color: '#5fb865' }} onClick={ws.runTests} disabled={ws.tests.running}>
        <Play />
      </button>
      <button
        type="button"
        className={'top-icon' + (ws.listening ? ' open' : '')}
        aria-label={ws.listening ? 'Stop listening for Xdebug' : 'Start listening for Xdebug'}
        aria-pressed={ws.listening}
        title={ws.listening ? 'Stop Listening for PHP Debug Connections' : 'Start Listening for PHP Debug Connections'}
        style={{ color: ws.listening ? '#5fb865' : '#ced0d6' }}
        onClick={() => ws.setListening(!ws.listening)}
      >
        <Icon name="bug" />
      </button>
      <MenuButton className="top-icon" label="More actions" entries={runMenu}>
        <Icon name="more" strokeWidth={3} />
      </MenuButton>

      <div className="drag" data-tauri-drag-region style={{ flex: '0 0 24px' }} />

      <button type="button" className={'top-icon' + (ws.rightTool === 'ai' ? ' open' : '')} aria-label="AI Assistant" title="AI Assistant" onClick={() => ws.toggleRight('ai')}>
        <Icon name="sparkle" />
      </button>
      <button type="button" className="top-icon" aria-label="Search everywhere" title="Search Everywhere (Double Shift)" onClick={() => onSearch('all')}>
        <Icon name="search" />
      </button>
      <button type="button" className="top-icon" aria-label="Settings" title="Settings (coming soon)" disabled>
        <Icon name="gear" />
      </button>
      <div className="drag" data-tauri-drag-region style={{ flex: '0 0 8px' }} />
      <WindowControls />
    </header>
  );
}

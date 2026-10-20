import { withKeys } from '../keymap/store';
import type { Workspace } from '../useWorkspace';
import { Icon, Logo, Play } from './Icon';
import { MenuButton, type MenuEntry } from './Menu';
import { WindowControls } from './WindowControls';
import type { SearchTab } from './SearchEverywhere';
import { useRef, useState } from 'react';
import { BranchesPopup } from './BranchesPopup';
import { ProjectPopup } from './ProjectPopup';
import { projectInitials, useProjectColor } from '../projectColors';
import { debug } from '../debug/manager';
import { useTestRunner } from '../tests/runner';
import { useSettings } from '../settings';
import { hamburgerItems, mainMenu } from '../mainMenu';
import { MainMenuBar } from './MainMenuBar';
import { ContextMenu } from './ContextMenu';

interface Props {
  ws: Workspace;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
  onSearch: (tab?: SearchTab) => void;
}

export function TopBar({ ws, onOpenFolder, onOpenPath, onClose, onSearch }: Props) {
  const { backend } = ws;
  const runner = useTestRunner();

  const ui = useSettings().ui;
  const branchButton = useRef<HTMLButtonElement>(null);
  const [hamburger, setHamburger] = useState<DOMRect | null>(null);


  const [branches, setBranches] = useState<DOMRect | null>(null);
  const [projects, setProjects] = useState<DOMRect | null>(null);
  const color = useProjectColor(backend.root, backend.name);
  const menus = mainMenu({
    ws,
    onOpenFolder,
    onOpenPath,
    onClose,
    onSearch,
    onBranches: () => branchButton.current && setBranches(branchButton.current.getBoundingClientRect()),
  });

  const runMenu: MenuEntry[] = [
    { label: 'Run Tests', run: ws.runTests },
    { label: 'Debug Tests', disabled: runner.running, run: () => ws.runTestScope({ kind: 'all' }, { debug: true }) },
    ...(ws.activePath?.endsWith('.php') ? [{ label: `Debug '${ws.activePath.split('/').pop()}'`, run: () => void debug.debugScript(ws.activePath!) }] : []),
    { label: 'Check Composer Updates', run: () => { ws.setRightTool('composer'); ws.checkOutdated(); } },
    { label: 'Open Terminal', run: () => ws.showBottom('terminal') },
  ];

  return (
    <>
      {ui.mainMenu === 'separate' && (
        <div className="menubar-row" data-tauri-drag-region>
          <span className="menubar-logo">
            <Logo size={16} />
          </span>
          <MainMenuBar menus={menus} merged={false} />
          <div className="drag" data-tauri-drag-region />
          <WindowControls />
        </div>
      )}
      <header className="topbar" data-tauri-drag-region>
        {ui.mainMenu === 'hamburger' && (
          <button
            type="button"
            className={'top-icon hamburger-btn' + (hamburger ? ' open' : '')}
            aria-label="Main menu"
            aria-haspopup="menu"
            title="Main Menu"
            onClick={(e) => setHamburger(hamburger ? null : e.currentTarget.getBoundingClientRect())}
          >
            <Icon name="menu" />
          </button>
        )}
        {hamburger && <ContextMenu x={hamburger.left} y={hamburger.bottom + 4} items={hamburgerItems(menus)} ignoreClicksIn=".hamburger-btn" onClose={() => setHamburger(null)} />}
        {ui.mainMenu === 'merged' && (
          <>
            <span className="menubar-logo">
              <Logo size={16} />
            </span>
            <MainMenuBar menus={menus} merged />
          </>
        )}
        <button
          type="button"
          className={'widget' + (projects ? ' open' : '')}
          aria-label={`Project ${backend.name}`}
          aria-haspopup="dialog"
          onClick={(e) => setProjects(projects ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
        >
          <span className="project-square" style={{ background: color }}>
            {projectInitials(backend.name)}
          </span>
          <span className="widget-text">{backend.name}</span>
          <span className="chevron">
            <Icon name="chevronDown" size={12} />
          </span>
        </button>
        {projects && (
          <ProjectPopup ws={ws} anchor={projects} onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onCloseProject={onClose} onColorChange={() => {}} onClose={() => setProjects(null)} />
        )}
        {ws.git && (
          <button
            type="button"
            ref={branchButton}
            className={'widget' + (branches ? ' open' : '')}
            aria-label={`Git branch ${ws.git.branch}`}
            aria-haspopup="dialog"
            title="Git branches"
            onClick={(e) => setBranches(branches ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
          >
            <Icon name="branch" size={15} />
            <span className="widget-text">{ws.git.branch}</span>
            <span className="chevron">
              <Icon name="chevronDown" size={12} />
            </span>
          </button>
        )}
        {branches && <BranchesPopup ws={ws} anchor={branches} onClose={() => setBranches(null)} />}

        <div className="drag" data-tauri-drag-region />

        <MenuButton className="widget" label="Run configuration PHPUnit" entries={runMenu}>
          <span className="badge" style={{ background: '#5fb865' }}>T</span>
          <span className="widget-text">PHPUnit</span>
          <span className="chevron">
            <Icon name="chevronDown" size={12} />
          </span>
        </MenuButton>
        <button type="button" className="top-icon" aria-label="Run tests" title="Run 'PHPUnit'" style={{ color: '#5fb865' }} onClick={ws.runTests} disabled={runner.running}>
          <Play />
        </button>
        <button
          type="button"
          className="top-icon"
          aria-label="Debug current file"
          title={ws.activePath?.endsWith('.php') ? `Debug '${ws.activePath.split('/').pop()}'` : 'Debug (open a PHP file)'}
          style={{ color: '#5fb865' }}
          disabled={!ws.activePath?.endsWith('.php')}
          onClick={() => ws.activePath && void debug.debugScript(ws.activePath)}
        >
          <Icon name="bug" />
        </button>
        <button
          type="button"
          className={'top-icon' + (ws.listening ? ' open' : '')}
          aria-label={ws.listening ? 'Stop listening for Xdebug' : 'Start listening for Xdebug'}
          aria-pressed={ws.listening}
          title={ws.listening ? 'Stop Listening for PHP Debug Connections' : 'Start Listening for PHP Debug Connections'}
          style={{ color: ws.listening ? '#5fb865' : 'var(--icon)' }}
          onClick={() => ws.setListening(!ws.listening)}
        >
          <Icon name="listen" />
        </button>
        <MenuButton className="top-icon" label="More actions" entries={runMenu}>
          <Icon name="more" />
        </MenuButton>

        <div className="drag" data-tauri-drag-region style={{ flex: '0 0 24px' }} />

        <button type="button" className="top-icon" aria-label="Search everywhere" title={withKeys('Search Everywhere', 'phpblitz.searchEverywhere')} onClick={() => onSearch('all')}>
          <Icon name="search" />
        </button>
        <button type="button" className="top-icon" aria-label="Settings" title={withKeys('Settings', 'phpblitz.settings')} onClick={() => ws.openSettings()}>
          <Icon name="gear" />
        </button>
        <div className="drag" data-tauri-drag-region style={{ flex: '0 0 8px' }} />
        {ui.mainMenu !== 'separate' && <WindowControls />}
      </header>
    </>
  );
}

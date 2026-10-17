import type { Workspace } from '../useWorkspace';
import { isTauri } from '../platform';
import { Icon, Play } from './Icon';
import { MenuButton, type MenuEntry } from './Menu';
import { WindowControls } from './WindowControls';
import type { SearchTab } from './SearchEverywhere';
import { useState } from 'react';
import { BranchesPopup } from './BranchesPopup';
import { ProjectPopup } from './ProjectPopup';
import { projectInitials, useProjectColor } from '../projectColors';
import { debug } from '../debug/manager';
import { perf } from '../perf';
import { openAppDialog } from '../appDialogs';

interface Props {
  ws: Workspace;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
  onSearch: (tab?: SearchTab) => void;
}

export function TopBar({ ws, onOpenFolder, onOpenPath, onClose, onSearch }: Props) {
  const { backend } = ws;

  const mainMenu: MenuEntry[] = [
    { kind: 'head', label: 'File' },
    { label: 'Open…', run: onOpenFolder, disabled: !isTauri },
    { label: 'Save', shortcut: 'Ctrl+S', run: ws.saveActive, disabled: !ws.activePath },
    { label: 'Settings…', shortcut: 'Ctrl+Alt+S', run: () => ws.openSettings() },
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
    { kind: 'sep' },
    { kind: 'head', label: 'Git' },
    { label: 'Update Project…', shortcut: 'Ctrl+T', disabled: !ws.git, run: () => ws.runGit('Update project', () => ws.gitRepo.pull()) },
    { label: 'Push…', shortcut: 'Ctrl+Shift+K', disabled: !ws.git, run: () => ws.setGitDialog({ kind: 'push' }) },
    { label: 'Show Git Log', disabled: !ws.git, run: () => ws.showHistory('') },
    { kind: 'sep' },
    { kind: 'head', label: 'Help' },
    { label: 'Startup Performance…', run: () => perf.show(true) },
    { label: 'Open Source Licenses…', run: () => openAppDialog('licenses') },
    { label: 'About PHPBlitz', run: () => openAppDialog('about') },
  ];


  const [branches, setBranches] = useState<DOMRect | null>(null);
  const [projects, setProjects] = useState<DOMRect | null>(null);
  const color = useProjectColor(backend.root, backend.name);

  const runMenu: MenuEntry[] = [
    { label: 'Run Tests', run: ws.runTests },
    { label: 'Debug Tests', disabled: backend.kind !== 'disk', run: () => void debug.debugScript(`${backend.root}/vendor/bin/phpunit`) },
    ...(ws.activePath?.endsWith('.php') ? [{ label: `Debug '${ws.activePath.split('/').pop()}'`, run: () => void debug.debugScript(ws.activePath!) }] : []),
    { label: 'Check Composer Updates', run: () => { ws.setRightTool('composer'); ws.checkOutdated(); } },
    { label: 'Open Terminal', run: () => ws.showBottom('terminal') },
  ];

  return (
    <header className="topbar" data-tauri-drag-region>
      <MenuButton className="top-icon" label="Main menu" title="Main Menu" entries={mainMenu}>
        <Icon name="menu" />
      </MenuButton>
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
        {backend.name}
        <span className="chevron">
          <Icon name="chevronDown" size={12} strokeWidth={2.2} />
        </span>
      </button>
      {projects && (
        <ProjectPopup ws={ws} anchor={projects} onOpenFolder={onOpenFolder} onOpenPath={onOpenPath} onCloseProject={onClose} onColorChange={() => {}} onClose={() => setProjects(null)} />
      )}
      {ws.git && (
        <button
          type="button"
          className={'widget' + (branches ? ' open' : '')}
          aria-label={`Git branch ${ws.git.branch}`}
          aria-haspopup="dialog"
          title="Git branches"
          onClick={(e) => setBranches(branches ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
        >
          <Icon name="branch" size={15} />
          {ws.git.branch}
          <span className="chevron">
            <Icon name="chevronDown" size={12} strokeWidth={2.2} />
          </span>
        </button>
      )}
      {branches && <BranchesPopup ws={ws} anchor={branches} onClose={() => setBranches(null)} />}

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
        style={{ color: ws.listening ? '#5fb865' : '#ced0d6' }}
        onClick={() => ws.setListening(!ws.listening)}
      >
        <Icon name="listen" />
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
      <button type="button" className="top-icon" aria-label="Settings" title="Settings (Ctrl+Alt+S)" onClick={() => ws.openSettings()}>
        <Icon name="gear" />
      </button>
      <div className="drag" data-tauri-drag-region style={{ flex: '0 0 8px' }} />
      <WindowControls />
    </header>
  );
}

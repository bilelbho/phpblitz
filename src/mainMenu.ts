// The main menu (File, Edit, View, Navigate, Code, Refactor, Run, Tools, Git, Window, Help), with
// underlined letters for Alt+key, shown as a menu bar or under the hamburger
// button (View ▸ Appearance ▸ Main Menu). It lists what PHPBlitz can do; items that need an open
// code editor are disabled without one.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import type { Workspace } from './useWorkspace';
import type { ContextItem } from './components/ContextMenu';
import type { SearchTab } from './components/SearchEverywhere';
import type { IconName } from './components/Icon';
import { TOOL_WINDOWS } from './components/RecentFiles';
import { editorAction, editorCommand } from './editorCommands';
import { getSettings, saveSettings, updateEditorSettings, DEFAULT_SETTINGS, type MainMenuMode, type UiSettings } from './settings';
import { zoomBy } from './uiSettings';
import { isTauri, recentProjects } from './platform';
import { debug } from './debug/manager';
import { testRunner } from './tests/runner';
import { perf } from './perf';
import { openAppDialog } from './appDialogs';
import { checkForUpdates, RELEASES_URL } from './updater';

export interface TopMenu {
  label: string;
  /** The underlined letter: Alt+it opens the menu. */
  mnemonic: string;
  items: () => ContextItem[];
}

export interface MainMenuActions {
  ws: Workspace;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
  onSearch: (tab?: SearchTab) => void;
  onBranches: () => void;
}

const REPO = 'https://github.com/bilelbho/phpblitz';
const openUrl = (url: string) => () => void invoke('open_external', { url }).catch(() => window.open(url, '_blank'));

type Extra = { mnemonic?: string; icon?: IconName; shortcut?: string };

/** A command the code editor registered (editorCommands): label and shortcut come with it. */
function cmd(id: string, label?: string, extra: Extra = {}): ContextItem {
  const c = editorCommand(id);
  return {
    label: label ?? c?.label ?? id,
    shortcut: c?.shortcut,
    ...extra,
    disabled: !c,
    run: c?.run,
  };
}

/** A Monaco (or PHPBlitz) editor action, run in the code editor. */
function act(actionId: string, label: string, extra: Extra = {}): ContextItem {
  const run = editorAction(actionId);
  return { label, ...extra, disabled: !run, run };
}

function setUi(patch: Partial<UiSettings>) {
  const s = getSettings();
  saveSettings({ ...s, ui: { ...s.ui, ...patch } });
}

const MAIN_MENU_MODES: { id: MainMenuMode; label: string }[] = [
  { id: 'hamburger', label: 'Hide under Hamburger Button' },
  { id: 'merged', label: 'Merge with Main Toolbar' },
  { id: 'separate', label: 'Show above Main Toolbar' },
];

export function mainMenu({ ws, onOpenFolder, onOpenPath, onClose, onSearch, onBranches }: MainMenuActions): TopMenu[] {
  const ui = () => getSettings().ui;
  const name = (p: string) => p.split('/').pop() ?? p;
  const otherTabs = () => ws.tabs.filter((t) => t.id !== ws.activeId).map((t) => t.id);
  const git = !!ws.git;
  const runGit = (label: string, fn: () => Promise<unknown>) => () => void ws.runGit(label, fn);
  const fontSize = (step: number | null) => () =>
    updateEditorSettings({
      fontSize: step === null ? DEFAULT_SETTINGS.editor.fontSize : Math.min(40, Math.max(8, getSettings().editor.fontSize + step)),
    });

  return [
    {
      label: 'File',
      mnemonic: 'F',
      items: () => {
        const recent = recentProjects().filter((p) => p !== ws.backend.root);
        return [
          {
            label: 'Open…',
            mnemonic: 'O',
            icon: 'folderOpen',
            disabled: !isTauri,
            run: onOpenFolder,
          },
          {
            label: 'Recent Projects',
            mnemonic: 'R',
            disabled: !recent.length,
            submenu: recent.map((p) => ({
              label: name(p),
              run: () => onOpenPath(p),
            })),
          },
          { label: 'Close Project', mnemonic: 'j', run: onClose },
          { kind: 'sep' },
          {
            label: 'Settings…',
            mnemonic: 't',
            icon: 'gear',
            shortcut: 'Ctrl+Alt+S',
            run: () => ws.openSettings(),
          },
          { kind: 'sep' },
          {
            label: 'Save',
            mnemonic: 'S',
            shortcut: 'Ctrl+S',
            disabled: !ws.activePath || !ws.dirty.has(ws.activePath),
            run: ws.saveActive,
          },
          {
            label: 'Save All',
            mnemonic: 'v',
            disabled: !ws.dirty.size,
            run: () => void Promise.all([...ws.dirty].map((p) => ws.save(p))),
          },
          { kind: 'sep' },
          {
            label: 'Exit',
            mnemonic: 'x',
            disabled: !isTauri,
            run: () => void getCurrentWindow().close(),
          },
        ];
      },
    },
    {
      label: 'Edit',
      mnemonic: 'E',
      items: () => [
        cmd('undo', 'Undo', { mnemonic: 'U' }),
        cmd('redo', 'Redo', { mnemonic: 'R' }),
        { kind: 'sep' },
        cmd('cut', 'Cut', { mnemonic: 't', icon: 'cut' }),
        cmd('copy', 'Copy', { mnemonic: 'C', icon: 'copy' }),
        {
          label: 'Copy Path/Reference',
          submenu: [
            act('phpblitz.copyPath', 'Absolute Path', {
              shortcut: 'Ctrl+Shift+C',
            }),
            cmd('copyReference', 'Reference'),
          ],
        },
        cmd('paste', 'Paste', { mnemonic: 'P', icon: 'paste' }),
        act('deleteRight', 'Delete', { mnemonic: 'D', shortcut: 'Delete' }),
        { kind: 'sep' },
        {
          label: 'Find',
          mnemonic: 'F',
          icon: 'search',
          submenu: [
            cmd('find', 'Find…', { mnemonic: 'F' }),
            cmd('replace', 'Replace…', { mnemonic: 'R' }),
            act('phpblitz.findNext', 'Find Next', {
              mnemonic: 'N',
              shortcut: 'F3',
            }),
            act('phpblitz.findPrev', 'Find Previous', {
              mnemonic: 'v',
              shortcut: 'Shift+F3',
            }),
            { kind: 'sep' },
            {
              label: 'Find in Files…',
              mnemonic: 'i',
              shortcut: 'Ctrl+Shift+F',
              run: () => ws.openFindInFiles('find'),
            },
            {
              label: 'Replace in Files…',
              mnemonic: 'a',
              shortcut: 'Ctrl+Shift+R',
              run: () => ws.openFindInFiles('replace'),
            },
          ],
        },
        cmd('findUsages', 'Find Usages', { mnemonic: 'U' }),
        { kind: 'sep' },
        act('phpblitz.columnSelection', 'Column Selection Mode', {
          mnemonic: 'M',
          shortcut: 'Alt+Shift+Insert',
        }),
        cmd('selectAll', 'Select All', { mnemonic: 'A' }),
        act('editor.action.insertCursorAtEndOfEachLineSelected', 'Add Carets to Ends of Selected Lines', { shortcut: 'Alt+Shift+I' }),
        act('editor.action.smartSelect.expand', 'Extend Selection', {
          shortcut: 'Alt+Shift+Right',
        }),
        act('editor.action.smartSelect.shrink', 'Shrink Selection', {
          shortcut: 'Alt+Shift+Left',
        }),
        { kind: 'sep' },
        {
          label: 'Toggle Case',
          submenu: [act('editor.action.transformToUppercase', 'Upper Case'), act('editor.action.transformToLowercase', 'Lower Case'), act('editor.action.transformToTitlecase', 'Title Case')],
        },
        act('editor.action.joinLines', 'Join Lines'),
        cmd('duplicate', 'Duplicate Line or Selection', { mnemonic: 'u' }),
        act('editor.action.sortLinesAscending', 'Sort Lines'),
        act('editor.action.transpose', 'Transpose'),
        { kind: 'sep' },
        act('editor.action.indentLines', 'Indent Selection', {
          shortcut: 'Ctrl+]',
        }),
        act('editor.action.outdentLines', 'Unindent Line or Selection', {
          shortcut: 'Ctrl+[',
        }),
        {
          label: 'Convert Indents',
          submenu: [act('editor.action.indentationToSpaces', 'To Spaces'), act('editor.action.indentationToTabs', 'To Tabs')],
        },
        { kind: 'sep' },
        {
          label: 'Bookmarks',
          mnemonic: 'k',
          icon: 'bookmark',
          submenu: [cmd('toggleBookmark'), cmd('mnemonicBookmark'), cmd('bookmarks')],
        },
      ],
    },
    {
      label: 'View',
      mnemonic: 'V',
      items: () => [
        {
          label: 'Tool Windows',
          mnemonic: 'T',
          submenu: TOOL_WINDOWS.map((t) => ({
            label: t.label,
            icon: t.icon,
            shortcut: t.shortcut,
            run: () => t.run(ws),
          })),
        },
        {
          label: 'Appearance',
          mnemonic: 'A',
          submenu: [
            {
              label: 'Compact Mode',
              checked: ui().compact,
              run: () => setUi({ compact: !ui().compact }),
            },
            {
              label: `Zoom IDE (Current: ${ui().zoom}%)`,
              submenu: [
                {
                  label: 'Zoom In',
                  shortcut: 'Alt+Shift+=',
                  run: () => zoomBy(10),
                },
                {
                  label: 'Zoom Out',
                  shortcut: 'Alt+Shift+Minus',
                  run: () => zoomBy(-10),
                },
                {
                  label: 'Reset',
                  shortcut: 'Alt+Shift+0',
                  run: () => zoomBy('reset'),
                },
              ],
            },
            { kind: 'sep' },
            {
              label: 'Main Menu',
              submenu: MAIN_MENU_MODES.map((m) => ({
                label: m.label,
                checked: ui().mainMenu === m.id,
                run: () => setUi({ mainMenu: m.id }),
              })),
            },
            {
              label: 'Tool Window Bars',
              checked: ui().toolWindowBars,
              run: () => setUi({ toolWindowBars: !ui().toolWindowBars }),
            },
            {
              label: 'Tool Window Names',
              checked: ui().toolWindowNames,
              disabled: !ui().toolWindowBars,
              run: () => setUi({ toolWindowNames: !ui().toolWindowNames }),
            },
          ],
        },
        { kind: 'sep' },
        act('phpblitz.quickDoc', 'Quick Documentation', {
          mnemonic: 'D',
          shortcut: 'Ctrl+Q',
        }),
        act('phpblitz.paramInfo', 'Parameter Info', {
          mnemonic: 'P',
          shortcut: 'Ctrl+P',
        }),
        { kind: 'sep' },
        {
          label: 'Recent Files',
          mnemonic: 'n',
          shortcut: 'Ctrl+E',
          run: () => ws.setRecentOpen(true),
        },
        { kind: 'sep' },
        { label: 'Increase Font Size in All Editors', run: fontSize(1) },
        { label: 'Decrease Font Size in All Editors', run: fontSize(-1) },
        { label: 'Reset Font Size in All Editors', run: fontSize(null) },
        { kind: 'sep' },
        cmd('softWrap', 'Soft-Wrap', { mnemonic: 'W' }),
      ],
    },
    {
      label: 'Navigate',
      mnemonic: 'N',
      items: () => [
        {
          label: 'Search Everywhere',
          icon: 'search',
          shortcut: 'Double Shift',
          run: () => onSearch('all'),
        },
        { kind: 'sep' },
        { label: 'Back', mnemonic: 'B', shortcut: 'Ctrl+Alt+Left', run: () => ws.navigateBack() },
        { label: 'Forward', mnemonic: 'o', shortcut: 'Ctrl+Alt+Right', run: () => ws.navigateForward() },
        { label: 'Recent Locations', mnemonic: 'L', shortcut: 'Ctrl+Shift+E', run: () => ws.setLocationsOpen(true) },
        { label: 'Reopen Closed Tab', shortcut: 'Ctrl+Shift+T', run: () => ws.reopenClosedTab() },
        { kind: 'sep' },
        {
          label: 'Class…',
          mnemonic: 'C',
          shortcut: 'Ctrl+N',
          run: () => onSearch('classes'),
        },
        {
          label: 'File…',
          mnemonic: 'F',
          shortcut: 'Ctrl+Shift+N',
          run: () => onSearch('files'),
        },
        { label: 'Symbol…', mnemonic: 'S', run: () => onSearch('symbols') },
        {
          label: 'Text…',
          mnemonic: 'x',
          shortcut: 'Ctrl+Shift+F',
          run: () => ws.openFindInFiles('find'),
        },
        cmd('gotoLine', 'Line:Column…', { mnemonic: 'L' }),
        { kind: 'sep' },
        act('phpblitz.nextProblem', 'Next Highlighted Error', {
          mnemonic: 'N',
          shortcut: 'F2',
        }),
        act('phpblitz.prevProblem', 'Previous Highlighted Error', {
          mnemonic: 'P',
          shortcut: 'Shift+F2',
        }),
        { kind: 'sep' },
        cmd('declaration', 'Declaration or Usages', { mnemonic: 'D' }),
        act('phpblitz.gotoImplementation', 'Implementation(s)', {
          mnemonic: 'I',
          shortcut: 'Ctrl+Alt+B',
        }),
        act('phpblitz.typeDeclaration', 'Type Declaration', {
          mnemonic: 'T',
          shortcut: 'Ctrl+Shift+B',
        }),
        { kind: 'sep' },
        cmd('fileStructure', 'File Structure', { mnemonic: 'l' }),
        {
          label: 'Bookmarks',
          mnemonic: 'k',
          icon: 'bookmark',
          submenu: [cmd('toggleBookmark'), cmd('mnemonicBookmark'), cmd('bookmarks')],
        },
      ],
    },
    {
      label: 'Code',
      mnemonic: 'C',
      items: () => [
        cmd('generate', 'Generate…', { mnemonic: 'G' }),
        cmd('contextActions', 'Show Context Actions', { mnemonic: 'x' }),
        act('editor.action.triggerSuggest', 'Code Completion', {
          mnemonic: 'C',
          shortcut: 'Ctrl+Space',
        }),
        { kind: 'sep' },
        {
          label: 'Folding',
          mnemonic: 'F',
          submenu: [
            act('phpblitz.expand', 'Expand', { shortcut: 'Ctrl+NumPad +' }),
            act('phpblitz.collapse', 'Collapse', { shortcut: 'Ctrl+NumPad -' }),
            cmd('unfoldAll', 'Expand All'),
            cmd('foldAll', 'Collapse All'),
          ],
        },
        { kind: 'sep' },
        cmd('commentLine', 'Comment with Line Comment', { mnemonic: 'L' }),
        cmd('blockComment', 'Comment with Block Comment', { mnemonic: 'B' }),
        cmd('reformat', 'Reformat Code', { mnemonic: 'R' }),
        act('editor.action.reindentselectedlines', 'Auto-Indent Lines', {
          mnemonic: 'I',
        }),
        { kind: 'sep' },
        act('editor.action.moveLinesDownAction', 'Move Line Down', {
          mnemonic: 'n',
          shortcut: 'Alt+Down',
        }),
        act('editor.action.moveLinesUpAction', 'Move Line Up', {
          mnemonic: 'p',
          shortcut: 'Alt+Up',
        }),
      ],
    },
    {
      label: 'Refactor',
      mnemonic: 'R',
      items: () => [cmd('rename', 'Rename…', { mnemonic: 'R' })],
    },
    {
      label: 'Run',
      mnemonic: 'u',
      items: () => {
        const session = debug.active;
        const stopped = session?.status === 'break';
        const php = ws.activePath?.endsWith('.php') ? ws.activePath : null;
        return [
          {
            label: 'Run All Tests',
            mnemonic: 'u',
            icon: 'run',
            disabled: testRunner.running,
            run: ws.runTests,
          },
          {
            label: 'Debug All Tests',
            mnemonic: 'D',
            icon: 'bug',
            disabled: testRunner.running,
            run: () => ws.runTestScope({ kind: 'all' }, { debug: true }),
          },
          {
            label: testRunner.run ? `Rerun '${testRunner.run.label}'` : 'Rerun',
            icon: 'run',
            disabled: !testRunner.run || testRunner.running,
            run: () => {
              ws.showBottom('tests');
              testRunner.rerun();
            },
          },
          {
            label: 'Rerun Failed Tests',
            icon: 'refresh',
            disabled: testRunner.running || !testRunner.failedTests().length,
            run: () => ws.runTestScope({ kind: 'failed' }),
          },
          {
            label: 'Stop Tests',
            icon: 'stopSquare',
            disabled: !testRunner.running,
            run: () => void testRunner.stop(),
          },
          { kind: 'sep' },
          {
            label: php ? `Debug '${name(php)}'` : 'Debug Current File',
            icon: 'bug',
            disabled: !php,
            run: () => php && void debug.debugScript(php),
          },
          { kind: 'sep' },
          {
            label: 'Stop',
            icon: 'stopSquare',
            shortcut: 'Ctrl+F2',
            disabled: !session,
            run: () => void debug.stop(),
          },
          {
            label: 'Debugging Actions',
            submenu: [
              {
                label: 'Resume Program',
                icon: 'resume',
                shortcut: 'F9',
                disabled: !stopped,
                run: debug.resume,
              },
              { kind: 'sep' },
              {
                label: 'Step Over',
                icon: 'stepOver',
                shortcut: 'F8',
                disabled: !stopped,
                run: debug.stepOver,
              },
              {
                label: 'Step Into',
                icon: 'stepInto',
                shortcut: 'F7',
                disabled: !stopped,
                run: debug.stepInto,
              },
              {
                label: 'Step Out',
                icon: 'stepOut',
                shortcut: 'Shift+F8',
                disabled: !stopped,
                run: debug.stepOut,
              },
            ],
          },
          act('phpblitz.toggleBreakpoint', 'Toggle Line Breakpoint', {
            shortcut: 'Ctrl+F8',
          }),
          { kind: 'sep' },
          {
            label: ws.listening ? 'Stop Listening for PHP Debug Connections' : 'Start Listening for PHP Debug Connections',
            icon: 'listen',
            run: () => ws.setListening(!ws.listening),
          },
          {
            label: 'Break at First Line in PHP Scripts',
            checked: getSettings().debug.breakAtFirstLine,
            run: () => toggleBreakAtFirstLine(),
          },
        ];
      },
    },
    {
      label: 'Tools',
      mnemonic: 'T',
      items: () => [
        {
          label: 'Composer',
          icon: 'box',
          submenu: [
            { label: 'Show Packages', run: () => ws.setRightTool('composer') },
            {
              label: 'Check for Updates',
              run: () => {
                ws.setRightTool('composer');
                ws.checkOutdated();
              },
            },
          ],
        },
        {
          label: 'HTTP Endpoints',
          icon: 'route',
          run: () => ws.setRightTool('endpoints'),
        },
        {
          label: 'Database',
          icon: 'database',
          run: () => ws.showLeft('database'),
        },
        { kind: 'sep' },
        {
          label: 'Terminal',
          mnemonic: 'T',
          icon: 'terminal',
          shortcut: 'Alt+F12',
          run: () => ws.showBottom('terminal'),
        },
      ],
    },
    {
      label: 'Git',
      mnemonic: 'G',
      items: () => [
        {
          label: 'Commit…',
          mnemonic: 'm',
          icon: 'commit',
          shortcut: 'Ctrl+K',
          disabled: !git,
          run: () => ws.showLeft('commit'),
        },
        {
          label: 'Push…',
          mnemonic: 'P',
          shortcut: 'Ctrl+Shift+K',
          disabled: !git,
          run: () => ws.setGitDialog({ kind: 'push' }),
        },
        {
          label: 'Update Project…',
          mnemonic: 'U',
          shortcut: 'Ctrl+T',
          disabled: !git,
          run: runGit('Update project', () => ws.gitRepo.pull()),
        },
        {
          label: 'Fetch',
          disabled: !git,
          run: runGit('Fetch', () => ws.gitRepo.fetch()),
        },
        { kind: 'sep' },
        {
          label: 'Branches…',
          mnemonic: 'B',
          icon: 'branch',
          disabled: !git,
          run: onBranches,
        },
        {
          label: 'New Branch…',
          shortcut: 'Ctrl+Alt+N',
          disabled: !git,
          run: () => ws.setGitDialog({ kind: 'newBranch' }),
        },
        { kind: 'sep' },
        {
          label: 'Show Git Log',
          icon: 'history',
          shortcut: 'Alt+9',
          disabled: !git,
          run: () => ws.showHistory(''),
        },
        {
          label: 'Uncommitted Changes',
          mnemonic: 'n',
          disabled: !git,
          submenu: [
            {
              label: 'Stash Changes…',
              run: () => ws.setGitDialog({ kind: 'stash' }),
            },
            {
              label: 'Unstash Changes…',
              run: () => ws.setGitDialog({ kind: 'unstash' }),
            },
          ],
        },
      ],
    },
    {
      label: 'Window',
      mnemonic: 'W',
      items: () => [
        {
          label: 'Layouts',
          mnemonic: 'L',
          submenu: [{ label: 'Restore Default Layout', run: ws.resetToolLayout }],
        },
        {
          label: 'Editor Tabs',
          mnemonic: 'T',
          submenu: [
            {
              label: 'Close Tab',
              disabled: !ws.activeId,
              run: () => ws.activeId && void ws.closeTab(ws.activeId),
            },
            {
              label: 'Close Other Tabs',
              disabled: !otherTabs().length,
              run: () => void ws.closeTabs(otherTabs()),
            },
            {
              label: 'Close All Tabs',
              disabled: !ws.tabs.length,
              run: () => void ws.closeTabs(ws.tabs.map((t) => t.id)),
            },
          ],
        },
        {
          label: 'Active Tool Window',
          submenu: [
            {
              label: 'Hide Bottom Panel',
              disabled: !ws.bottomOpen,
              run: () => ws.setBottomOpen(false),
            },
          ],
        },
        {
          label: 'Notifications',
          mnemonic: 'N',
          icon: 'bell',
          run: () => ws.setRightTool('notifications'),
        },
        { kind: 'sep' },
        { label: ws.backend.name, checked: true, run: () => {} },
      ],
    },
    {
      label: 'Help',
      mnemonic: 'H',
      items: () => [
        {
          label: 'Find Action…',
          mnemonic: 'F',
          shortcut: 'Ctrl+Shift+A',
          run: () => onSearch('actions'),
        },
        { label: 'Help', mnemonic: 'H', run: openUrl(`${REPO}#readme`) },
        { kind: 'sep' },
        {
          label: "What's New in PHPBlitz",
          mnemonic: 'N',
          run: openUrl(RELEASES_URL),
        },
        {
          label: 'Submit a Bug Report…',
          run: openUrl(`${REPO}/issues/new/choose`),
        },
        { kind: 'sep' },
        {
          label: 'Diagnostic Tools',
          submenu: [{ label: 'Startup Performance…', run: () => perf.show(true) }],
        },
        { kind: 'sep' },
        {
          label: 'Check for Updates…',
          disabled: !isTauri,
          run: () => void checkForUpdates({ manual: true }),
        },
        {
          label: 'Open Source Licenses…',
          run: () => openAppDialog('licenses'),
        },
        { label: 'About', mnemonic: 'A', run: () => openAppDialog('about') },
      ],
    },
  ];
}

function toggleBreakAtFirstLine() {
  const s = getSettings();
  saveSettings({
    ...s,
    debug: { ...s.debug, breakAtFirstLine: !s.debug.breakAtFirstLine },
  });
}

/** The whole menu as one list with submenus, for the hamburger button. */
export function hamburgerItems(menus: TopMenu[]): ContextItem[] {
  return menus.map((m) => ({
    label: m.label,
    mnemonic: m.mnemonic,
    submenu: m.items(),
  }));
}

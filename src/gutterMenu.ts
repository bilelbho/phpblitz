// Right-click in the editor's gutter (line numbers, icons, change markers), like PhpStorm's:
// Git blame, bookmarks, soft wraps, and what the gutter shows.

import type { ContextItem } from './components/ContextMenu';
import type { Workspace } from './useWorkspace';
import { bookmarks } from './bookmarks';
import { getSettings, updateEditorSettings, type EditorSettings } from './settings';

export function gutterMenu(ws: Workspace, path: string, line: number, opts: { softWrap: boolean; toggleSoftWrap: () => void; mnemonic: () => void }): ContextItem[] {
  const change = ws.git?.changes.find((c) => c.path === path);
  const bookmark = bookmarks.at(path, line);
  const e = getSettings().editor;
  const toggle = (key: keyof EditorSettings & ('lineNumbers' | 'gutterIcons' | 'foldingOutline' | 'indentGuides' | 'whitespaces'), label: string): ContextItem => ({
    label,
    checked: e[key],
    run: () => updateEditorSettings({ [key]: !e[key] }),
  });
  return [
    {
      label: 'Annotate with Git Blame',
      checked: ws.annotated.has(path),
      disabled: !ws.git || change?.status === 'U' || change?.status === 'A',
      run: () => ws.toggleAnnotate(path),
    },
    { kind: 'sep' },
    bookmark ? { label: 'Remove Bookmark', run: () => bookmarks.remove(path, line) } : { label: 'Add Bookmark', run: () => bookmarks.set({ path, line }) },
    { label: bookmark?.mnemonic ? 'Edit Mnemonic Bookmark…' : 'Add Mnemonic Bookmark…', shortcut: 'Ctrl+F11', run: opts.mnemonic },
    { kind: 'sep' },
    { label: 'Soft-Wrap', shortcut: 'Alt+Z', checked: opts.softWrap, run: opts.toggleSoftWrap },
    { label: 'Configure Soft Wraps…', run: () => ws.openSettings('editor-general') },
    { kind: 'sep' },
    {
      label: 'Appearance',
      submenu: [
        toggle('lineNumbers', 'Show Line Numbers'),
        toggle('gutterIcons', 'Show Gutter Icons'),
        toggle('foldingOutline', 'Show Code Folding Outline'),
        toggle('indentGuides', 'Show Indent Guides'),
        toggle('whitespaces', 'Show Whitespaces'),
      ],
    },
    { label: 'Configure Gutter Icons…', run: () => ws.openSettings('gutter-icons') },
  ];
}

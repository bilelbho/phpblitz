// Every command a keymap can bind, with its name and group (Settings ▸ Keymap, Help ▸ Keyboard
// Shortcuts). Ids starting with "phpblitz." are ours: an action of the focused code editor and/or
// a handler the workspace registers (commands.ts). The others are Monaco's own editor commands,
// run in the focused code editor. Which keys run them is the keymap's business (keymaps.ts).

export interface Command {
  id: string;
  label: string;
  group: string;
  /** A Monaco editor command (run in the focused code editor). */
  monaco?: boolean;
  /** Runs in the terminal too, when the terminal keeps the keys for the shell. */
  always?: boolean;
}

const m = (id: string, label: string, group: string): Command => ({ id, label, group, monaco: true });
const p = (id: string, label: string, group: string, extra: Partial<Command> = {}): Command => ({ id: `phpblitz.${id}`, label, group, ...extra });

const DIGITS = Array.from({ length: 10 }, (_, d) => String(d));

export const COMMANDS: Command[] = [
  // File
  p('settings', 'Settings…', 'File', { always: true }),
  p('save', 'Save', 'File'),
  p('closeTab', 'Close Tab', 'File'),
  p('reopenClosedTab', 'Reopen Closed Tab', 'File'),

  // Edit
  m('undo', 'Undo', 'Edit'),
  m('redo', 'Redo', 'Edit'),
  m('editor.action.duplicateSelection', 'Duplicate Line or Selection', 'Edit'),
  m('editor.action.copyLinesDownAction', 'Copy Line Down', 'Edit'),
  m('editor.action.copyLinesUpAction', 'Copy Line Up', 'Edit'),
  m('editor.action.deleteLines', 'Delete Line', 'Edit'),
  m('editor.action.moveLinesUpAction', 'Move Line Up', 'Edit'),
  m('editor.action.moveLinesDownAction', 'Move Line Down', 'Edit'),
  p('moveStatementUp', 'Move Statement Up', 'Edit'),
  p('moveStatementDown', 'Move Statement Down', 'Edit'),
  m('editor.action.joinLines', 'Join Lines', 'Edit'),
  m('editor.action.insertLineAfter', 'Start New Line', 'Edit'),
  m('editor.action.insertLineBefore', 'Start New Line Before Current', 'Edit'),
  m('editor.action.indentLines', 'Indent Selection', 'Edit'),
  m('editor.action.outdentLines', 'Unindent Line or Selection', 'Edit'),
  m('editor.action.sortLinesAscending', 'Sort Lines', 'Edit'),
  m('editor.action.transpose', 'Transpose', 'Edit'),
  m('editor.action.commentLine', 'Comment with Line Comment', 'Edit'),
  m('editor.action.addCommentLine', 'Add Line Comment', 'Edit'),
  m('editor.action.removeCommentLine', 'Remove Line Comment', 'Edit'),
  m('editor.action.blockComment', 'Comment with Block Comment', 'Edit'),
  p('toggleCase', 'Toggle Case', 'Edit'),
  m('editor.action.transformToUppercase', 'To Uppercase', 'Edit'),
  m('editor.action.transformToLowercase', 'To Lowercase', 'Edit'),

  // Selection and carets
  m('editor.action.smartSelect.expand', 'Extend Selection', 'Selection'),
  m('editor.action.smartSelect.shrink', 'Shrink Selection', 'Selection'),
  m('expandLineSelection', 'Select Line', 'Selection'),
  p('columnSelection', 'Column Selection Mode', 'Selection'),
  m('editor.action.insertCursorAbove', 'Add Caret Above', 'Selection'),
  m('editor.action.insertCursorBelow', 'Add Caret Below', 'Selection'),
  m('editor.action.addSelectionToNextFindMatch', 'Add Selection for Next Occurrence', 'Selection'),
  m('editor.action.moveSelectionToNextFindMatch', 'Skip to Next Occurrence', 'Selection'),
  m('cursorUndo', 'Unselect Occurrence', 'Selection'),
  m('editor.action.selectHighlights', 'Select All Occurrences', 'Selection'),
  m('editor.action.insertCursorAtEndOfEachLineSelected', 'Add Carets to Ends of Selected Lines', 'Selection'),

  // Find
  p('find', 'Find…', 'Find'),
  p('replace', 'Replace…', 'Find'),
  p('findNext', 'Find Next', 'Find'),
  p('findPrev', 'Find Previous', 'Find'),
  p('findInFiles', 'Find in Files…', 'Find'),
  p('replaceInFiles', 'Replace in Files…', 'Find'),
  p('findUsages', 'Find Usages', 'Find'),
  p('showUsages', 'Show Usages', 'Find'),

  // Navigate
  p('searchEverywhere', 'Search Everywhere', 'Navigate'),
  p('findAction', 'Find Action…', 'Navigate'),
  p('gotoClass', 'Go to Class…', 'Navigate'),
  p('gotoFile', 'Go to File…', 'Navigate'),
  p('gotoSymbol', 'Go to Symbol…', 'Navigate'),
  p('gotoLine', 'Go to Line:Column…', 'Navigate'),
  p('fileStructure', 'File Structure', 'Navigate'),
  p('recentFiles', 'Recent Files', 'Navigate'),
  p('recentLocations', 'Recent Locations', 'Navigate'),
  p('back', 'Back', 'Navigate'),
  p('forward', 'Forward', 'Navigate'),
  p('lastEditLocation', 'Last Edit Location', 'Navigate'),
  p('gotoDeclaration', 'Go to Declaration', 'Navigate'),
  p('gotoImplementation', 'Go to Implementation', 'Navigate'),
  p('typeDeclaration', 'Go to Type Declaration', 'Navigate'),
  p('prevMethod', 'Previous Method', 'Navigate'),
  p('nextMethod', 'Next Method', 'Navigate'),
  m('editor.action.jumpToBracket', 'Move Caret to Matching Brace', 'Navigate'),
  p('nextProblem', 'Next Highlighted Error', 'Navigate'),
  p('prevProblem', 'Previous Highlighted Error', 'Navigate'),

  // Code
  p('contextActions', 'Show Context Actions', 'Code'),
  p('applyFirstFix', 'Apply First Fix', 'Code'),
  p('generate', 'Generate…', 'Code'),
  p('surroundWith', 'Surround With…', 'Code'),
  m('editor.action.triggerSuggest', 'Code Completion', 'Code'),
  p('paramInfo', 'Parameter Info', 'Code'),
  p('quickDoc', 'Quick Documentation', 'Code'),
  p('reformat', 'Reformat Code', 'Code'),
  p('rename', 'Rename…', 'Code'),
  p('editWithAi', 'Edit with AI…', 'Code'),
  p('copyPath', 'Copy Absolute Path', 'Code'),
  p('copyReference', 'Copy Reference', 'Code'),
  p('softWrap', 'Soft-Wrap', 'Code'),

  // Folding
  p('expand', 'Expand', 'Folding'),
  p('collapse', 'Collapse', 'Folding'),
  m('editor.toggleFold', 'Toggle Fold', 'Folding'),
  p('expandAll', 'Expand All', 'Folding'),
  p('collapseAll', 'Collapse All', 'Folding'),

  // Bookmarks
  p('toggleBookmark', 'Toggle Bookmark', 'Bookmarks'),
  p('mnemonicBookmark', 'Toggle Bookmark with Mnemonic…', 'Bookmarks'),
  p('showBookmarks', 'Show All Bookmarks', 'Bookmarks'),
  ...DIGITS.map((d) => p(`gotoBookmark${d}`, `Go to Bookmark ${d}`, 'Bookmarks')),
  ...DIGITS.map((d) => p(`toggleBookmark${d}`, `Toggle Bookmark ${d}`, 'Bookmarks')),

  // Run and debug
  p('runTests', 'Run Tests', 'Run'),
  p('toggleBreakpoint', 'Toggle Line Breakpoint', 'Run'),
  p('runToCursor', 'Run to Cursor', 'Run'),
  p('debugResume', 'Resume Program', 'Run'),
  p('debugStepOver', 'Step Over', 'Run'),
  p('debugStepInto', 'Step Into', 'Run'),
  p('debugStepOut', 'Step Out', 'Run'),
  p('debugStop', 'Stop', 'Run'),

  // Git
  p('commit', 'Commit…', 'Git'),
  p('push', 'Push…', 'Git'),
  p('updateProject', 'Update Project…', 'Git'),
  p('newBranch', 'New Branch…', 'Git'),

  // Tool windows
  p('tool.commit', 'Commit', 'Tool Windows'),
  p('tool.project', 'Project', 'Tool Windows'),
  p('tool.terminal', 'Terminal', 'Tool Windows'),
  p('tool.database', 'Database', 'Tool Windows'),
  p('tool.structure', 'Structure', 'Tool Windows'),
  p('tool.problems', 'Problems', 'Tool Windows'),
  p('tool.git', 'Git', 'Tool Windows'),
  p('tool.todo', 'TODO', 'Tool Windows'),
  p('tool.run', 'Run', 'Tool Windows'),
  p('tool.ai', 'AI', 'Tool Windows'),
  p('tool.endpoints', 'Endpoints', 'Tool Windows'),
  p('tool.composer', 'Composer', 'Tool Windows'),
  p('tool.npm', 'npm', 'Tool Windows'),
  p('tool.notifications', 'Notifications', 'Tool Windows'),
  // Also from the terminal: F6 is the way out of it.
  p('panel.next', 'Focus Next Panel', 'Tool Windows', { always: true }),
  p('panel.previous', 'Focus Previous Panel', 'Tool Windows', { always: true }),
  p('panel.maximize', 'Maximize / Restore Panel', 'Tool Windows', { always: true }),

  // View
  p('zoomIn', 'Zoom In', 'View', { always: true }),
  p('zoomOut', 'Zoom Out', 'View', { always: true }),
  p('zoomReset', 'Reset Zoom', 'View', { always: true }),
  p('fontSizeUp', 'Increase Font Size', 'View'),
  p('fontSizeDown', 'Decrease Font Size', 'View'),
  p('fontSizeReset', 'Reset Font Size', 'View'),
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: string): Command | undefined {
  return BY_ID.get(id);
}

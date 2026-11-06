# PHPBlitz UI QA report

Bugs found while running UI_CHECKLIST.md on the dev build, with test copies in `C:\demo\…`.

| ID | Checklist | Severity | Summary | Status |
|---|---|---|---|---|
| QA-01 | N-01 | High | Search Everywhere ▸ Symbols found nothing for "Timesheet" in Kimai | Fixed |
| QA-02 | A-07 | Medium | TypeError in the editor's hover after Ctrl+click opened another file | Fixed |
| QA-03 | A-08 | Low | Monaco's "Canceled" promise rejections logged in the Error Log | Fixed |
| QA-04 | ST-02 | High | Opening ~30 tabs quickly crashed the tab bar ("Maximum update depth exceeded") | Fixed |
| QA-05 | D-15 | Medium | Push, Compare and Conflicts dialogs didn't take the focus: Esc and Tab did nothing | Fixed |
| QA-06 | A-02 | Low | Project tree reached with Tab, no row selected: no sign of focus | Fixed |
| QA-07 | S-17 | Medium | Coverage window narrow (900×600 window): headers overlap, file names squeezed to nothing | Fixed |

## QA-01: Symbols tab empty when many classes match

**Steps:** Kimai, Search Everywhere (Shift Shift) ▸ Symbols, type `Timesheet`.
**Expected:** methods like `FavoriteTimesheet::getTimesheet()`.
**Actual:** "Nothing found" (typing `getTimesheet` does find them).
**Cause:** one index search returned the best 100 hits of every kind, and the Classes and Symbols
tabs filtered those. Over 100 classes match "Timesheet" and outrank methods, so none were left. The
All tab lost its methods the same way.
**Fix:** the index search takes a kind (`class` / `symbol`); each tab asks for its own, All for both.
Rust test `search_one_kind_keeps_the_limit_for_it`.

## QA-02: hover error after Ctrl+click

**Steps:** in a PHP file, Ctrl+click a class name (the mouse stays over the text).
**Actual:** `TypeError: Cannot read properties of null (reading 'getBoundingClientRect')` in
`wordBox` / `showHoverAt` (EditorArea.tsx), about half a second after the other file opened.
**Cause:** the hover's 550 ms timer fired after the editor it belonged to was disposed;
`editor.getDomNode()` was null.
**Fix:** `wordBox` returns null without a DOM node, and the timer is cleared when the editor is
disposed.

## QA-03: "Canceled" in the Error Log

**Steps:** switch files while the editor highlights the word at the caret.
**Actual:** an unhandled rejection `Canceled: Canceled` (Monaco's word highlighter) is logged as a
"Background task" error.
**Cause:** Monaco cancels work it no longer needs with a `Canceled` error that nothing awaits.
**Fix:** the Error Log's `unhandledrejection` handler ignores exactly that error.

## QA-04: the tab bar crashes with many tabs

**Steps:** Kimai, Focus layout, double-click 29+ files in src/Entity quickly.
**Actual:** `Maximum update depth exceeded` in TabBar's `measure`; the error boundary replaces the
tab bar (no tabs shown until the panel is reloaded).
**Cause:** `measure` (which tabs are scrolled out of view) runs after every render and sets that
list. The ▾ button grew with its count (`width: auto`), so the list changed the row's width, the
browser clamped its scroll position, and the list changed again, without end. A new ResizeObserver
was also made after every render, each reporting at once.
**Fix:** the ▾ button keeps one width with or without the count, and one ResizeObserver is made per
row. 30 tabs now open with "22 more" on the button.

## QA-05: some dialogs don't take the focus

**Steps:** a Git project, Ctrl+Shift+K (Push), then Esc. Same with a branch ▸ Compare with '…'.
**Actual:** the dialog stays open; the focus is still on the page behind it, so Esc, Tab and
screen readers don't reach the dialog. Only Cancel closes it.
**Cause:** these dialogs have no field with autoFocus, and their shells didn't use the app's
`useDialogFocus` hook (GitDialogs' shared `Dialog`, CompareDialog, ConflictsDialog).
**Fix:** they use `useDialogFocus` (tabIndex -1 on the dialog): a field with autoFocus keeps the
focus, else the dialog takes it; on close it goes back where it was. Push's button is not focused,
so Enter doesn't push.

## QA-06: no focus sign in the Project tree

**Steps:** Tab into the Project tree before any row is selected.
**Actual:** the tree has the focus (`:focus-visible`) but shows nothing: its outline is turned off
on purpose, and the focus sign is the selected row's color, but no row is selected.
**Fix:** while the tree has keyboard focus and no selected row, its first row gets an accent
outline; ArrowDown then selects it.

## QA-07: Coverage window too narrow

**Steps:** a 900×600 window with Endpoints, Run and Coverage side by side (Coverage ~140–200 px).
**Actual:** the "Element / Lines / Methods" headers overlap and the file names get no width (only
the bars and percentages show).
**Cause:** a fixed grid (name, 96 px, 52 px) with no narrow layout.
**Fix:** a container query below 280 px drops the Methods column and the bars; names come first,
lines as a percentage.

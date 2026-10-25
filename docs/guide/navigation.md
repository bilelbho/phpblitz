# Navigation and refactoring

All of this works from PHPBlitz's own index of your project and `vendor/`, with no language server
needed. The index is cached in the project's `.blitz` folder.

<img class="shot" src="/screenshots/search.png" alt="Search Everywhere finding classes">

## Finding things

| To | Press |
| --- | --- |
| Search everything: classes, files, symbols, actions | Double <kbd>Shift</kbd> |
| Go to a class / file / symbol | <kbd>Ctrl+N</kbd> / <kbd>Ctrl+Shift+N</kbd> / <kbd>Ctrl+Alt+Shift+N</kbd> |
| Find an action | <kbd>Ctrl+Shift+A</kbd> |
| Find in Files / Replace in Files | <kbd>Ctrl+Shift+F</kbd> / <kbd>Ctrl+Shift+R</kbd> |
| Recent files | <kbd>Ctrl+E</kbd> |
| Recent locations: where you've been and what you changed | <kbd>Ctrl+Shift+E</kbd> |

## Following code

| To | Press |
| --- | --- |
| Go to Definition | <kbd>Ctrl+B</kbd> or <kbd>Ctrl</kbd>+click |
| Find Usages (in a tool window) | <kbd>Alt+F7</kbd> |
| Show Usages (a popup at the code) | <kbd>Ctrl+Alt+F7</kbd> |
| Back / Forward | <kbd>Ctrl+Alt+←</kbd> / <kbd>Ctrl+Alt+→</kbd>, or the mouse's side buttons |
| Last edit location | <kbd>Ctrl+Shift+Backspace</kbd> |
| Reopen the last closed tab | <kbd>Ctrl+Shift+T</kbd> |

Usages on values of a known type are exact. A call on a value of unknown type
(`$anything->save()`) is a *dynamic* usage, maybe this method, maybe another with the same name;
the usages popup lets you include or leave them out. When no other class declares a member with that
name, PHPBlitz knows it can only be this one.

## Rename

**Shift+F6** renames a class, method, property, constant, function or variable, with its usages in
every file. Open files change in their editor (undoable, unsaved like any edit); the others are
changed on disk. A class whose file is named after it (`Post.php`) is renamed with its file.

Fixing a typo with *Alt+Enter ▸ Rename to…* does the same at once, without the dialog.

These are the PHPBlitz keymap's keys: see [keyboard shortcuts](../reference/shortcuts) for every
keymap.

# Project files (.blitz)

PHPBlitz keeps per-project files in a `.blitz` folder in your project. It creates a `.gitignore` in
it, so only what's meant to be shared can be committed.

| File | What | Commit it? |
| --- | --- | --- |
| `project.json` | PHP settings, Excluded folders, the spelling dictionary | Yes, to share them with your team |
| `workspace.json` | Bookmarks, recent files, data sources, debugger watches, commit message history, the window's layout | No (git-ignored): this machine only |
| `cache/` | The symbol index, Local History | No (git-ignored) |

## If a file is broken

If `project.json` or `workspace.json` isn't valid JSON (a bad edit, a merge conflict), PHPBlitz
keeps it as it was in `.blitz/cache/<name>.<time>.broken`, starts that file's settings fresh, and
says so in a notification with a button to open the copy. A file that can't be read at all is
never written over. Nothing in it is lost.

## Editing by hand

The files are plain JSON, sorted, and paths inside the project are written as `$PROJECT_DIR$/…`, so
they work after the project folder moves. Values that don't make sense (an unknown tool window, a
negative size) are ignored when PHPBlitz reads them, in favor of the defaults.

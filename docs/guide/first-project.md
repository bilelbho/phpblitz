# Your first project

## Open or create one

The welcome window lists your recent projects. From there:

- **Open** a folder on disk.
- **Clone Repository** from a Git URL.
- **New Project** (*File ▸ New Project*): plain PHP, Laravel (starter kits and packages like
  Filament, Sanctum or Pest), Symfony, Drupal, and JavaScript generators (Next.js, Nuxt, Angular,
  Express…). PHPBlitz runs the tools for you and shows their output, then opens the new project.

The **Customize** page sets the theme, the [layout](./layouts), the zoom, the editor font size and
the keymap (*Keys like in*: if you come from another editor, its shortcuts work here).

## What happens when it opens

1. PHPBlitz indexes the project and its `vendor/` folder: classes, functions, methods. The index is
   cached in the project's `.blitz` folder, so the next time it opens in seconds.
2. Mago analyzes the files you open right away, then the whole project in the background. Framework
   rules (Laravel, Symfony, PHPUnit, Doctrine…) come from `composer.json`.
3. If `vendor/` is missing, PHPBlitz says so and offers *Run composer install*, instead of reporting
   every class from a package as unknown.

Nothing in the project runs while it opens: PHPBlitz reads and parses files, it never executes them.

## Set up PHP

*Settings ▸ PHP* chooses the PHP interpreter for running scripts and tests and for the debugger:

- **Local**: a `php` executable on this computer.
- **Docker** or **Docker Compose**: PHP in a container, with path mappings between the project and
  the container.
- **SSH**: PHP on another machine.

It also sets the PHP language level, include paths and Composer files. These settings are saved in
`.blitz/project.json`, which you can commit to share with your team (see
[project files](../reference/project-files)).

## Find your way around

| To | Press |
| --- | --- |
| Find anything (classes, files, symbols, actions) | Double <kbd>Shift</kbd> |
| Open a file by name | <kbd>Ctrl+Shift+N</kbd> |
| Open a class | <kbd>Ctrl+N</kbd> |
| Find an action or setting | <kbd>Ctrl+Shift+A</kbd> |
| See recent files | <kbd>Ctrl+E</kbd> |
| Open Settings | <kbd>Ctrl+Alt+S</kbd> |

These are the PHPBlitz keymap's keys; every keymap's are in [keyboard shortcuts](../reference/shortcuts),
and *Help ▸ Keyboard Shortcuts* lists them in the app.

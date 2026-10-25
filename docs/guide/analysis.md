# Errors and analysis

[Mago](https://github.com/carthage-software/mago)'s linter and analyzer are built into PHPBlitz:
no separate tool to install or run.

- **Open files are checked as you type.** Errors get a red underline, warnings a yellow one; the
  marks in the scrollbar and the counts at the top right jump between them.
- **The whole project is analyzed in the background** when it opens. The **Problems** tool window
  (<kbd>Alt+6</kbd>) has the open file's problems and, on its *Project Errors* tab, everyone's.
- **Framework rules come from `composer.json`**: Laravel, Symfony, PHPUnit, Doctrine and more are
  recognized and their rules turned on.

## Fixing and silencing

- <kbd>Alt+Enter</kbd> on a problem shows its fixes, and *Suppress* writes the comment that silences
  that rule on that line.
- *Settings ▸ PHP ▸ Mago* sets each rule's level (error, warning, weak, off). A `mago.toml` in the
  project is used as it is.

## Before `composer install`

Without `vendor/`, classes from packages can't be found. Rather than flag each of them as unknown,
PHPBlitz holds back type checking, says so, and offers *Run composer install*.

## Spelling

Typos are checked too: see [Spelling](./editor#spelling).

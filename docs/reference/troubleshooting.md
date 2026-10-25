# Troubleshooting

## Something feels slow

Open **Help ▸ Startup Performance**. It times each stage of opening the project and each file you
open. *Copy Report* and attach it to an [issue](https://github.com/bilelbho/phpblitz/issues), with
your system and the PHPBlitz version.

## Many problems about unknown classes

Run `composer install` so `vendor/` exists. Until then PHPBlitz holds back type checking and says so.

## Something went wrong

A panel that fails shows *Reload panel* instead of taking the window down. **Help ▸ Diagnostic
Tools ▸ Error Log** lists what failed: *Copy Report* and attach it to an issue.

## A .blitz file couldn't be read

PHPBlitz kept the file as it was in `.blitz/cache/` and started its settings fresh: see
[Project files](./project-files#if-a-file-is-broken).

## Linux: "External file changes sync may be slow"

The system's file watch limit is too low for the project. The notification has a button that copies
the command to raise it.

## Linux: blank or flickering window

Seen with some graphics drivers. Set the environment variable `WEBKIT_DISABLE_DMABUF_RENDERER=1`
before starting PHPBlitz, for example in a terminal:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./PHPBlitz_<version>_amd64.AppImage
```

or in its launcher.

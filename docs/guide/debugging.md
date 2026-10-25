# Debugging

Step debugging with [Xdebug 3](https://xdebug.org): breakpoints, variables, watches and inline
values in the editor.

## Set up

1. Install Xdebug for the PHP you run (`php -v` lists it when it's loaded).
2. In *Settings ▸ PHP*, choose the interpreter. For Docker, Docker Compose or SSH, set the **path
   mappings** between your project and where the code runs.
3. *Settings ▸ PHP ▸ Debug* has the port (9003 by default), *Break at first line*, exceptions to stop
   on, and how many children of an array or object to load.

## Debug

- **A script**: the top bar's 🐞 debugs the open PHP file.
- **A test**: *Debug* in the Run menu or a test's gutter menu.
- **A web request**: turn on *Start Listening for PHP Debug Connections* (the top bar's button
  beside 🐞 in the Classic layout, or *Run* in the main menu), then load the page with Xdebug's trigger
  (a browser extension or `XDEBUG_TRIGGER`).

Breakpoints: click the gutter, or <kbd>Ctrl+F8</kbd>.

| To | Press |
| --- | --- |
| Resume | <kbd>F9</kbd> |
| Step over / into / out | <kbd>F8</kbd> / <kbd>F7</kbd> / <kbd>Shift+F8</kbd> |
| Run to cursor | <kbd>Alt+F9</kbd> |
| Stop | <kbd>Ctrl+F2</kbd> |

The **Debug** tool window has the frames, variables and watches; the values of variables also show
in the editor beside the lines that set them.

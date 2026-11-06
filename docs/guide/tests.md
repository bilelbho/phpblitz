# Tests

PHPUnit and Pest, run with the project's PHP interpreter, local or in Docker
(*Settings ▸ PHP*).

<img class="shot" src="/screenshots/tests.png" alt="Running PHPUnit tests: run icons in the gutter, the result tree and the expected and actual values of a failure">

- **▶ in the gutter** beside each test class, test method and Pest test, green or red after a run.
- <kbd>Ctrl+Shift+F10</kbd> runs the test at the caret.
- **The Run tool window** (<kbd>Alt+4</kbd>) shows the results as a tree: failures with expected and
  actual values, clickable stack traces, and the output.
- **Rerun** the failed tests, or one data set of a data provider.
- **Debug** a test: it runs with Xdebug, and stops at your breakpoints (see [Debugging](./debugging)).

The top bar's ▶ runs the whole suite.

## Coverage

*Run … with Coverage* measures which lines your tests run. It's in the ▶ menu in the gutter, the
top bar's ▶ menu (*Run Tests with Coverage*), *Run ▸ Run All Tests with Coverage*, and the Run
window.

- **The Coverage tool window** lists folders and files with the share of their lines and methods
  covered. Click a file to open it.
- **In the editor**, a green bar marks covered lines and a red bar the lines no test reached. The
  Coverage window's eye button hides and shows them.
- **The last report is kept** (in `.blitz/cache/`) and is still there after a restart, until the
  next coverage run or *Close the Report*.

PHP needs a coverage driver: Xdebug (PHPBlitz turns its coverage mode on for the run) or PCOV.
PHPUnit measures the folders of the `<source>` section of `phpunit.xml`; without one, PHPBlitz
measures `src/`, `app/` or `lib/`. Coverage works with local and Docker interpreters, not over SSH.

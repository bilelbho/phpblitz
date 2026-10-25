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

# Editor

PHPBlitz's editor is [Monaco](https://microsoft.github.io/monaco-editor/), with PHP support written
for PHPBlitz.

<img class="shot" src="/screenshots/editor.png" alt="A controller in the editor: rendered doc comments, usage counts above declarations and an error found as you type">

## Writing PHP

- **Highlighting and completion** for PHP, from PHPBlitz's own index of your project and `vendor/`.
  With a PHP language server on your `PATH` (`phpantom_lsp` or `php-lsp`), completion and
  refactorings go further.
- **Doc comments rendered** in place: parameters, return types and exceptions read like
  documentation. Click the pencil to edit the comment.
- **Usage counts** above classes, methods and functions ("3 usages"): click one to see them.
- **Alt+Enter** shows the fixes and actions for the caret: import a class, fix a typo, suppress a
  rule.
- **Surround With** (<kbd>Ctrl+Alt+T</kbd>) wraps the selection in `if`, `foreach`, `try`/`catch` and
  more. *Settings ▸ Editor ▸ Surround With* edits the templates.
- **Bookmarks** (<kbd>F11</kbd>, and numbered ones with <kbd>Ctrl+Shift+1</kbd>…), soft wrap, a
  Markdown preview, and TODO comments with a TODO tool window.

## Templates and Emmet

Type a short abbreviation and press <kbd>Tab</kbd>: it becomes the code, and <kbd>Tab</kbd> then
moves through the places to fill in.

- **Live templates** in PHP: `fore` (`foreach`), `forek`, `fori`, `ifn`, `pubf` (`public function`),
  `prif`, `pubsf`, `con` (constructor), `pubp` / `prip` (properties), `const`, `test`, `thr`
  (`throw new`), `sw`, `match`, `vd` (`var_dump`), `strict` (`declare(strict_types=1);`) and more.
  They're also in the completion list as you type them.
- **Postfix templates**: type a dot after an expression, then the template. `$user.nn` becomes
  `if ($user !== null) { }`; also `.if`, `.else`, `.null`, `.isset`, `.empty`, `.fore`, `.forek`,
  `.return`, `.var`, `.echo`, `.throw`, `.not`, `.par`, `.count`, `.new`.
- **Emmet in HTML** (HTML, Blade, Twig and the HTML of PHP files):
  `ul>li.item*3>a{Item $}` becomes the list, `!` an HTML5 page. `>` child, `+` sibling, `^` up a
  level, `( )` groups, `*3` repeats, `$` numbers the copies, `.class`, `#id`, `[attr=value]`,
  `{text}`.
- **Emmet in CSS** (CSS, SCSS and Less, inside a rule): `m10-auto` becomes
  `margin: 10px auto;`, `d:f` `display: flex;`, `jc:sb` `justify-content: space-between;`,
  `c#f` `color: #fff;`, `w50p` `width: 50%;`, `fz1.5r` `font-size: 1.5rem;`, and a `!` at the
  end adds `!important`.

*Settings ▸ Editor ▸ Live Templates* turns built-in templates off, adds your own (with `$NAME$`
places to fill and `$END$` for where the caret ends), and turns postfix templates and Emmet on or
off. Where nothing expands, <kbd>Tab</kbd> indents as usual.

## Spelling

Typos in names, comments and strings get a green wavy underline. camelCase and snake_case names are
split into words, so `getClietn` is caught.

- **Alt+Enter ▸ Rename to…** fixes it. In a name, every usage is renamed at once, in every file.
- **Save to dictionary** accepts the word for the project. The dictionary is in
  `.blitz/project.json`, shared with your team if you commit it.

Words your project uses in several of its own names (`Teamlead`, `Kimai`…) and every word of
`vendor/` names count as spelled right.

## Local History

Every save is kept, also the versions you never committed. Right-click a file ▸ *Local History…*
shows each version as a diff against the current text, and reverts to it in one undoable step.

## Comfort

- The lock in the status bar makes a file read-only.
- Drag files from Explorer or Finder onto the Project tree to copy them in, or onto the editor to
  open them.
- *View ▸ Appearance* zooms the whole window; <kbd>Ctrl+Alt+S</kbd> ▸ *Editor ▸ Font* sets the
  editor's font, size and ligatures.

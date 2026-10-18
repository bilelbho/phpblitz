// Monaco without the parts PHPBlitz doesn't use, so the editor loads less code. Vite points every
// `import ... from 'monaco-editor'` here (vite.config.ts); the API is the same as the full package.
//
// Left out: AI inline completions and inline edits, Monaco's own quick-access boxes (command
// palette, go to line or symbol: PHPBlitz has its own), the color picker, paste/drop providers,
// in-place replace, section headers, the token inspector, the iPad keyboard and high-contrast toggle.
// Kept: every other editor feature, the peek references widget, and all languages (each loads
// only when a file or Markdown code block needs it).

import 'monaco-editor/esm/vs/editor/browser/coreCommands.js';
import 'monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-editor/esm/vs/editor/contrib/anchorSelect/browser/anchorSelect.js';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/caretOperations/browser/transpose.js';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/esm/vs/editor/contrib/codelens/browser/codelensController.js';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/esm/vs/editor/contrib/dnd/browser/dnd.js';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/esm/vs/editor/contrib/fontZoom/browser/fontZoom.js';
import 'monaco-editor/esm/vs/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/esm/vs/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-editor/esm/vs/editor/contrib/inlineProgress/browser/inlineProgress.js';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/linkedEditing/browser/linkedEditing.js';
import 'monaco-editor/esm/vs/editor/contrib/links/browser/links.js';
import 'monaco-editor/esm/vs/editor/contrib/longLinesHelper/browser/longLinesHelper.js';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/esm/vs/editor/contrib/placeholderText/browser/placeholderText.contribution.js';
import 'monaco-editor/esm/vs/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/esm/vs/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import 'monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/esm/vs/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/esm/vs/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/esm/vs/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js';
import 'monaco-editor/esm/vs/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-editor/esm/vs/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js';
import 'monaco-editor/esm/vs/editor/common/standaloneStrings.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/css/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/html/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';

export * from 'monaco-editor/esm/vs/editor/editor.api.js';

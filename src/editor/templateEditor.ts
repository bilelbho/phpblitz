// Tab in the editor: a live template's abbreviation (fore), a postfix template ($items.fore) or an
// Emmet abbreviation (ul>li*3 in HTML, m10 in CSS) before the caret becomes its code; anything else is a Tab.
// Live and postfix templates are in the completion list too (Settings ▸ Editor ▸ Live Templates).

import * as monaco from 'monaco-editor';
import { getSettings } from '../settings';
import { abbreviationBefore, expandAbbreviation } from './emmet';
import { cssAbbreviationBefore, expandCss, inCssDeclarations } from './emmetCss';
import { BUILTIN_POSTFIX, expressionBefore, inHtmlOfPhp, inPhpCode, liveTemplates, templateSnippet } from './templates';

const EMMET_LANGUAGES = new Set(['html', 'twig', 'handlebars', 'xml']);
const CSS_LANGUAGES = new Set(['css', 'scss', 'less']);

const unitOf = (model: monaco.editor.ITextModel) => {
  const o = model.getOptions();
  return o.insertSpaces ? ' '.repeat(o.indentSize) : '\t';
};

const templates = () => {
  const e = getSettings().editor;
  return liveTemplates(e.liveTemplates, e.liveHidden);
};

/** `$items.fore`: the postfix template and expression before the caret (on its line). */
function postfixAt(line: string, column: number) {
  if (!getSettings().editor.postfixTemplates) return null;
  const m = /\.(\w+)$/.exec(line.slice(0, column - 1));
  if (!m) return null;
  const template = BUILTIN_POSTFIX.find((t) => t.key === m[1]);
  const expr = template && expressionBefore(line, column - 1 - m[0].length);
  return template && expr ? { template, expr } : null;
}

/** What Tab would expand at the caret: the snippet and how many characters before the caret it replaces. */
export function expansionAt(model: monaco.editor.ITextModel, position: monaco.Position): { snippet: string; replace: number } | null {
  const line = model.getLineContent(position.lineNumber);
  const offset = model.getOffsetAt(position);
  const language = model.getLanguageId();
  const unit = unitOf(model);
  const text = language === 'php' ? model.getValue() : '';
  if (language === 'php' && inPhpCode(text, offset)) {
    const post = postfixAt(line, position.column);
    if (post) return { snippet: templateSnippet(post.template.body, unit, post.expr.text), replace: position.column - 1 - post.expr.start };
    const word = /(^|[^\w$>:\\])([\w-]+)$/.exec(line.slice(0, position.column - 1));
    const t = word && templates().find((x) => x.abbr === word[2]);
    if (t) return { snippet: templateSnippet(t.body, unit), replace: word![2].length };
    return null;
  }
  if (!getSettings().editor.emmet) return null;
  if (CSS_LANGUAGES.has(language)) {
    // CSS shorthands (m10, d:f…), in a rule's declarations only.
    const abbr = cssAbbreviationBefore(line, position.column);
    const snippet = abbr && inCssDeclarations(model.getValue(), offset) ? expandCss(abbr.text) : null;
    return snippet ? { snippet, replace: position.column - abbr!.start } : null;
  }
  if (EMMET_LANGUAGES.has(language) || (language === 'php' && inHtmlOfPhp(text, offset))) {
    const abbr = abbreviationBefore(line, position.column);
    const snippet = abbr && expandAbbreviation(abbr.text, unit);
    if (snippet) return { snippet, replace: position.column - abbr!.start };
  }
  return null;
}

type SnippetController = { insert(template: string, opts?: { overwriteBefore?: number }): void };

/** Tab: expands what's before the caret, else does what Tab does. */
export function setupTemplates(editor: monaco.editor.IStandaloneCodeEditor) {
  editor.addCommand(
    monaco.KeyCode.Tab,
    () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      const found = model && position ? expansionAt(model, position) : null;
      if (!found) return editor.trigger('keyboard', 'tab', null);
      const controller = editor.getContribution('snippetController2') as unknown as SnippetController | null;
      controller?.insert(found.snippet, { overwriteBefore: found.replace });
    },
    'editorTextFocus && !editorReadonly && !editorHasSelection && !editorHasMultipleSelections && !suggestWidgetVisible && !inSnippetMode && !inlineSuggestionVisible && !editorTabMovesFocus',
  );
}

// The completion list: live templates as you type their abbreviation, postfix templates after `expr.`
monaco.languages.registerCompletionItemProvider('php', {
  triggerCharacters: ['.'],
  provideCompletionItems(model, position) {
    const line = model.getLineContent(position.lineNumber);
    const before = line.slice(0, position.column - 1);
    if (!inPhpCode(model.getValue(), model.getOffsetAt(position))) return { suggestions: [] };
    const unit = unitOf(model);
    const suggestions: monaco.languages.CompletionItem[] = [];
    const post = /\.(\w*)$/.exec(before);
    const expr = post && getSettings().editor.postfixTemplates ? expressionBefore(line, position.column - 1 - post[0].length) : null;
    if (expr) {
      // The range covers the expression, so choosing one replaces it; filtered on "expr.key".
      const range = new monaco.Range(position.lineNumber, expr.start + 1, position.lineNumber, position.column);
      for (const t of BUILTIN_POSTFIX) {
        suggestions.push({
          label: { label: `.${t.key}`, description: t.description },
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: 'Postfix template',
          documentation: { value: '```php\n' + t.body.replace(/\$EXPR\$/g, expr.text).replace(/\$(\w+)(?::[^$]*)?\$/g, (_, n: string) => (n === 'END' ? '' : n.toLowerCase())) + '\n```' },
          filterText: `${expr.text}.${t.key}`,
          insertText: templateSnippet(t.body, unit, expr.text),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          sortText: `~${t.key}`,
          range,
        });
      }
      return { suggestions };
    }
    const word = /(^|[^\w$>:\\.])([\w-]+)$/.exec(before);
    if (!word) return { suggestions: [] };
    const range = new monaco.Range(position.lineNumber, position.column - word[2].length, position.lineNumber, position.column);
    for (const t of templates()) {
      if (!t.abbr.startsWith(word[2])) continue;
      suggestions.push({
        label: { label: t.abbr, description: t.description },
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: 'Live template (Tab)',
        documentation: { value: '```php\n' + t.body.replace(/\$(\w+)(?::([^$]*))?\$/g, (_, n: string, d?: string) => (n === 'END' ? '' : (d ?? n.toLowerCase()))) + '\n```' },
        insertText: templateSnippet(t.body, unit),
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      });
    }
    return { suggestions };
  },
});

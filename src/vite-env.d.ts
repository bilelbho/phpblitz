
// Monaco's built-in language grammars (loaded to replace PHP's with ours, see editor/phpGrammar.ts).
declare module 'monaco-editor/esm/vs/basic-languages/*';

// The editor's service registry: editor/textModels.ts replaces the document service before any
// editor exists.
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: {
    initialize(overrides: Record<string, unknown>): unknown;
  };
}

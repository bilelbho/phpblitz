// ESLint: the recommended JavaScript and TypeScript rules, and React's hook rules (hooks called
// in the same order every render, effect dependencies complete). Run with `npm run lint`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'src-tauri', 'node_modules', 'src/thirdParty.json'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Protocol payloads (LSP, DBGp, Monaco internals) are typed loosely on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
      // `ok ? a() : b()` and `x && y()` as statements are used on purpose.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // HTML put into the page must be escaped or sanitized (DOMPurify): each place that does it
      // says why it's safe in an eslint-disable comment, so a new one gets looked at.
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Inserts HTML: escape or sanitize it, and say why it is safe.' },
        { selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]", message: 'Inserts HTML: escape or sanitize it, and say why it is safe.' },
        { selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/][callee.object.name='document'], CallExpression[callee.property.name='insertAdjacentHTML']", message: 'Inserts HTML: escape or sanitize it, and say why it is safe.' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
);

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests for the UI's pure modules (parsers, inference, generators). They run in Node; Monaco,
// which some of these modules register providers with when they load, is replaced by a stub.
export default defineConfig({
  resolve: {
    alias: [{ find: /^monaco-editor$/, replacement: fileURLToPath(new URL('./src/testing/monacoStub.ts', import.meta.url)) }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

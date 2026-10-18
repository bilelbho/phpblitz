import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Tauri expects a fixed dev-server port and must not watch the Rust sources.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Monaco without the features PHPBlitz doesn't use (see src/editor/monacoSlim.ts). Only the bare
    // package name: deep imports (workers, contributions) still go to the package itself.
    alias: [{ find: /^monaco-editor$/, replacement: fileURLToPath(new URL('./src/editor/monacoSlim.ts', import.meta.url)) }],
  },
  clearScreen: false,
  // Monaco is large; that's fine for a desktop app loading from disk.
  build: { chunkSizeWarningLimit: 5000 },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});

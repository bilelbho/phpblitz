import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev-server port and must not watch the Rust sources.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Monaco is large; that's fine for a desktop app loading from disk.
  build: { chunkSizeWarningLimit: 5000 },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});

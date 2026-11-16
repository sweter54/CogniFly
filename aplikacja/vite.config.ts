import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// One HTML page per Tauri window; fixed port expected by tauri.conf.json.
const pages = ['background', 'main'];

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: {
    target: 'safari15',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});

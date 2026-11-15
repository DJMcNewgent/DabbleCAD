import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'src/renderer'),
  base: './',
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  server: { port: 5183, strictPort: true },
});

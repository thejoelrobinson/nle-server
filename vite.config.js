import { defineConfig } from 'vite';
import path from 'path';

const projectRoot = path.resolve(__dirname);

export default defineConfig({
  // Serve src/web/ as the document root (index.html lives here)
  root: 'src/web',

  // publicDir files are served as-is at / with no module processing.
  // This makes /frame_server.js and /frame_server.wasm available to the
  // browser without Vite touching them.
  publicDir: path.resolve(projectRoot, 'build'),

  server: {
    headers: {
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  build: {
    outDir:      path.resolve(projectRoot, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(projectRoot, 'src/web/index.html'),
    },
  },
});

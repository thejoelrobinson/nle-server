import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  // Serve src/web/ as the root so index.html resolves relative imports correctly
  root: 'src/web',

  // Allow Vite to resolve files outside root (e.g. /build/frame_server.js)
  server: {
    fs: {
      // Allow serving files from the project root and the build output dir
      allow: [
        path.resolve(__dirname),
      ],
    },
    headers: {
      // Required for SharedArrayBuffer (even though Phase 1 doesn't use it,
      // setting these now means the WASM module loads correctly and Phase 2
      // threading will work without any config change).
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  // In production builds, output to dist/ at project root
  build: {
    outDir:    path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/web/index.html'),
    },
  },

  // Make /build/ available as a static directory at /build/*
  // Vite doesn't serve outside root by default, so we use a plugin to proxy
  // requests for the WASM binary.
  plugins: [
    {
      name: 'serve-wasm-build',
      configureServer(server) {
        server.middlewares.use('/build', (req, res, next) => {
          // Let Vite's static file middleware handle these after path rewrite
          req.url = '/../../build' + req.url;
          next();
        });
      },
    },
  ],
});

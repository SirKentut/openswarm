import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import Pages from 'vite-plugin-pages';
import terminal from 'vite-plugin-terminal';
import path from 'path';

export default defineConfig(({ mode }) => {
  const backendPort = process.env.BACKEND_PORT;
  const backendEnabled = backendPort && backendPort !== 'NONE';

  return {
    // Per-workspace vite optimization cache. Workspaces share their
    // `node_modules/` directory via a symlink to the OpenSwarm warm
    // cache (see view_builder_templates.py::_ensure_warm_cache), which
    // by default would also share `node_modules/.vite/` — meaning the
    // optimized-deps bundle from workspace A could be picked up by
    // workspace B's vite, ending up with two React copies in the same
    // iframe (`Invalid hook call` / `Cannot read properties of null
    // (reading 'useState')`). Pointing cacheDir outside node_modules
    // makes the optimization cache per-workspace while keeping the
    // package files themselves shared.
    cacheDir: '.vite-cache',
    plugins: [
      react(),
      Pages({ dirs: 'src/pages', extensions: ['tsx'] }),
      terminal({ console: 'terminal', output: ['terminal', 'console'] }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
      // Force single instances of React and emotion — even if anything
      // tries to resolve them from a deeper node_modules path (which
      // could happen with symlinked node_modules + nested deps), vite
      // pins to the one true copy at the symlinked top-level.
      dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'],
    },
    define: {
      'process.env.BACKEND_ENABLED': JSON.stringify(backendEnabled ? 'true' : ''),
    },
    server: {
      host: '127.0.0.1',
      port: Number(process.env.FRONTEND_PORT) || 3000,
      strictPort: true,
      open: false,
      proxy: backendEnabled
        ? {
            '/api': {
              target: `http://localhost:${backendPort || 8324}`,
              changeOrigin: true,
            },
          }
        : undefined,
    },
  };
});

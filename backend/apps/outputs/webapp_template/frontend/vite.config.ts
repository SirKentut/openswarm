import { defineConfig } from 'vite';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Detect whether the workspace is in React/workspace mode or vanilla/lightweight
// mode. Lightweight apps delete src/ entirely (per SKILL.md); when it's gone,
// we must NOT load react() or vite-plugin-pages. The pages plugin registers a
// catch-all SPA fallback that intercepts any unresolved URL — including static
// asset requests like /css/style.css — and returns index.html with Content-Type
// text/html, causing the browser to refuse the file as a stylesheet.
const srcDir = path.join(__dirname, 'src');
const isWorkspaceMode = fs.existsSync(srcDir) && fs.readdirSync(srcDir).length > 0;

// Shared, hash-keyed vite optimization cache. Every webapp-template
// workspace shares its node_modules/ via a symlink to OpenSwarm's warm
// cache, AND now shares the optimized-deps output via this cache too —
// keyed on the hash of vite.config.ts + package.json so a real config
// or dep bump invalidates automatically. First workspace ever opened
// pays the ~10–15s MUI pre-bundle; every subsequent workspace reuses
// the same `.vite-cache/deps/` and boots in under a second.
//
// Why this is safe (despite the earlier React-duplicate issue):
//   1. The skill prompt now mandates MUI path-imports — so every
//      workspace ends up with the SAME, small, deduped optimizeDeps
//      set. No more "workspace A pre-bundled @mui/material barrel,
//      workspace B pre-bundled @mui/material/Button — collision."
//   2. resolve.dedupe pins react/react-dom/emotion to single instances
//      from the symlinked node_modules root.
//   3. Vite's own metadata.json swap is atomic, so concurrent boots
//      don't corrupt the cache.
function sharedViteCacheDir(): string {
  const here = __dirname;
  let digest = 'fallback';
  try {
    const crypto = require('crypto') as typeof import('crypto');
    const hasher = crypto.createHash('sha256');
    for (const f of ['vite.config.ts', 'package.json']) {
      const p = path.join(here, f);
      if (fs.existsSync(p)) hasher.update(fs.readFileSync(p));
    }
    digest = hasher.digest('hex').slice(0, 12);
  } catch {
    // Fall through — if hashing fails we still get a stable shared
    // cache, just under one "fallback" key.
  }
  const base = process.env.OPENSWARM_VITE_CACHE_DIR
    || path.join(os.homedir(), '.openswarm', 'cache', 'webapp_template_vite_cache');
  return path.join(base, digest);
}

export default defineConfig(async ({ mode }) => {
  const backendPort = process.env.BACKEND_PORT;
  const backendEnabled = backendPort && backendPort !== 'NONE';

  const plugins = [];

  if (isWorkspaceMode) {
    const { default: react } = await import('@vitejs/plugin-react');
    const { default: Pages } = await import('vite-plugin-pages');
    const { default: terminal } = await import('vite-plugin-terminal');
    plugins.push(
      react(),
      Pages({ dirs: 'src/pages', extensions: ['tsx'] }),
      ...(mode === 'development'
        ? [terminal({ console: 'terminal', output: ['terminal', 'console'] })]
        : []),
    );
  }

  return {
    cacheDir: sharedViteCacheDir(),
    plugins,
    ...(isWorkspaceMode
      ? {
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
        }
      : {}),
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

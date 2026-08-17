import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// `__dirname` does not exist here: package.json declares an ES module, so vite
// loads this config as one.
const page = (name: string): string => fileURLToPath(new URL(`web/${name}`, import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // Two entries, two audiences. The affiliate portal is a separate bundle so
    // that an external partner's browser is never sent the dashboard's code —
    // see `servePortal` in src/server/index.ts.
    rollupOptions: {
      input: {
        main: page('index.html'),
        portal: page('portal.html'),
      },
    },
  },
  server: {
    proxy: {
      // Order matters: `/portal/api` has to be matched before `/portal` would be
      // handled as a page request by the dev server.
      '/portal/api': 'http://localhost:8787',
      '/api': 'http://localhost:8787',
      '/r': 'http://localhost:8787',
    },
    port: 5173,
  },
});

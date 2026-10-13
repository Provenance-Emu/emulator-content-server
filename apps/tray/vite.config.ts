import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'watch-shared-packages',
      configureServer(server) {
        // The client is consumed from its build, and the shared components from
        // their sources. Both live outside this app, so Vite would not notice
        // either changing.
        server.watcher.add(resolve(here, '../../packages/client-ts/dist'));
        server.watcher.add(resolve(here, '../web/src'));
      },
    },
  ],
  // Tauri serves the build from a file path, so asset URLs have to be relative.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  optimizeDeps: { exclude: ['@ecs/client', '@ecs/web'] },
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [resolve(here, '../..')] },
  },
});

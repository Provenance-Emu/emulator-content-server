import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // The server mounts the build under /ui, so every asset URL has to be relative
  // to that prefix rather than to the origin root.
  base: '/ui/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': 'http://127.0.0.1:7878', '/health': 'http://127.0.0.1:7878' } },
});

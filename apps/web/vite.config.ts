import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);

/**
 * Writes `.br` and `.gz` beside every text asset once the bundle is on disk. The server hands
 * them to a client that accepts the encoding, so nothing is compressed while serving.
 */
function precompress(): Plugin {
  let out = 'dist';
  return {
    name: 'ecs-precompress',
    apply: 'build',
    configResolved(config) {
      out = config.build.outDir;
    },
    async closeBundle() {
      const entries = await readdir(out, { recursive: true, withFileTypes: true });
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() && /\.(?:js|mjs|css|html|svg|json|txt|wasm)$/.test(entry.name),
          )
          .map(async (entry) => {
            const file = join(entry.parentPath, entry.name);
            const bytes = await readFile(file);
            // Small files gain nothing, and a compressed copy that is not smaller is not kept.
            if (bytes.length < 1024) return;
            const [br, gz] = await Promise.all([
              brotli(bytes, {
                params: {
                  [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                  [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
                },
              }),
              deflate(bytes, { level: 9 }),
            ]);
            if (br.length < bytes.length) await writeFile(`${file}.br`, br);
            if (gz.length < bytes.length) await writeFile(`${file}.gz`, gz);
          }),
      );
    },
  };
}

export default defineConfig({
  plugins: [svelte(), precompress()],
  // The server mounts the build under /ui, so every asset URL has to be relative
  // to that prefix rather than to the origin root.
  base: '/ui/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: { index: 'index.html', player: 'play/index.html' } },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:7878', '/health': 'http://127.0.0.1:7878' } },
});

import { resolve } from 'node:path';
import { build } from 'vite';
import { skinInfo, skinLargeImagePdf, skinPdf, skinPng, skinZip } from '../skin-fixture';
import { expect, test } from './fixture';

test.use({ headless: true });
test.setTimeout(60000);
test.beforeAll(async () => {
  const id = resolve('skin-artwork-test');
  await build({
    configFile: false,
    base: '/ui/',
    logLevel: 'silent',
    plugins: [
      {
        name: 'skin-test',
        resolveId(v) {
          if (v === id) return v;
        },
        load(v) {
          if (v === id)
            return `export {SkinLibrary} from ${JSON.stringify(resolve('src/player/skins/library.ts'))};export {importSkin} from ${JSON.stringify(resolve('src/player/skins/import-client.ts'))};export {renderSkinAsset} from ${JSON.stringify(resolve('src/player/skins/artwork.ts'))};`;
        },
      },
    ],
    build: {
      outDir: resolve('dist'),
      emptyOutDir: false,
      target: 'es2022',
      rollupOptions: {
        input: id,
        preserveEntrySignatures: 'strict',
        output: {
          entryFileNames: 'skin-artwork-test.js',
          chunkFileNames: 'assets/skin-test-[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
});
test('first-party archive worker and lazy PDF worker decode bounded transparent artwork under player CSP', async ({
  page,
  fixture,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)));
  page.on('requestfailed', (r) => errors.push(r.url() + ': ' + r.failure()?.errorText));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(r.url() + ': ' + r.status());
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text().slice(0, 300));
  });
  await page.goto(fixture.origin + '/play/');
  for (const ext of ['png', 'pdf']) {
    const bytes = await skinZip(
      skinInfo('art.' + ext),
      {
        ['art.' + ext]: ext === 'png' ? skinPng() : skinPdf(),
      },
      6,
    );
    const result = await page.evaluate(
      async ({ data }) => {
        try {
          const api = await import('/ui/skin-artwork-test.js'),
            signal = new AbortController().signal,
            pkg = await api.importSkin(new Blob([new Uint8Array(data)]), signal),
            asset = await api.renderSkinAsset(pkg.assets[0], signal),
            img = new Image();
          img.src = asset.url;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const top = [...ctx.getImageData(1, 1, 1, 1).data],
            bottom = [...ctx.getImageData(1, c.height - 5, 1, 1).data];
          asset.release();
          return { top, bottom, width: c.width, height: c.height };
        } catch (e) {
          return { error: String(e).slice(0, 300) };
        }
      },
      { data: [...bytes] },
    );
    expect(result.error, errors.join('\n')).toBeUndefined();
    expect(result.top?.[3]).toBe(0);
    expect(result.bottom?.[3]).toBe(255);
    expect(result.bottom?.slice(0, 3)).toEqual(ext === 'png' ? [70, 145, 120] : [51, 153, 128]);
  }
});

test('oversized embedded PDF images are not decoded into artwork', async ({ page, fixture }) => {
  await page.goto(fixture.origin + '/play/');
  const alpha = await page.evaluate(
    async (data) => {
      const api = await import('/ui/skin-artwork-test.js');
      const asset = await api.renderSkinAsset(
        {
          id: 'large',
          name: 'large.pdf',
          mediaType: 'application/pdf',
          blob: new Blob([new Uint8Array(data)]),
        },
        new AbortController().signal,
      );
      try {
        const img = new Image();
        img.src = asset.url;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(1, 1, 1, 1).data[3];
      } finally {
        asset.release();
      }
    },
    [...skinLargeImagePdf()],
  );
  expect(alpha).toBe(0);
});
test('browser library retains archive and artwork blobs atomically', async ({ page, fixture }) => {
  await page.goto(fixture.origin + '/play/');
  const result = await page.evaluate(
    async (data) => {
      const api = await import('/ui/skin-artwork-test.js'),
        lib = new api.SkinLibrary('skin-browser-test');
      try {
        const pkg = await api.importSkin(
          new Blob([new Uint8Array(data)]),
          new AbortController().signal,
        );
        await lib.put(pkg);
        await lib.putPreference('scope', { basis: pkg.id, choices: {}, overrides: {} });
        const saved = await lib.get(pkg.id);
        return { original: saved.original.size, artwork: saved.assets[0].blob.size };
      } catch (e) {
        return { error: String(e) };
      } finally {
        lib.close();
      }
    },
    [...(await skinZip())],
  );
  expect(result.error).toBeUndefined();
  expect(result.original).toBeGreaterThan(0);
  expect(result.artwork).toBeGreaterThan(0);
});

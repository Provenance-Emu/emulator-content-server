/** Real cached FCEUmm and original generated NES bytes; never operator data. */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContentClient } from '@ecs/client';
import { expect, test } from '@playwright/test';
import { installPinnedPlayer } from '../../../../scripts/browser-core/install-plugin.mjs';
import { openServer } from '../../../server/dist/src/index.js';

const externalCore = process.env.ECS_ACCEPTANCE_CORE;
if (externalCore) test.use({ headless: process.env.ECS_ACCEPTANCE_HEADLESS === '1' });
test('real player captures changing PNGs, links native previews, loads a browsed state and changes display settings', async ({
  page,
}, testInfo) => {
  test.skip(!externalCore, 'Set ECS_ACCEPTANCE_CORE to the external pinned FCEUmm build');
  test.setTimeout(180000);
  const dir = await mkdtemp(join(tmpdir(), 'ecs-capture-real-'));
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  try {
    const registry = join(dir, 'players');
    await mkdir(registry);
    await installPinnedPlayer(resolve(externalCore ?? ''), join(registry, 'fceumm'));
    execFileSync('ca65', [
      resolve('../../examples/browser-playback/acceptance.s'),
      '-o',
      join(dir, 'program.o'),
    ]);
    execFileSync('ld65', [
      '-C',
      resolve('../../examples/browser-playback/nes.cfg'),
      join(dir, 'program.o'),
      '-o',
      join(dir, 'program.nes'),
    ]);
    server = await openServer({
      dataDir: join(dir, 'data'),
      uiDir: resolve('dist'),
      playerPluginsDir: registry,
      localTrust: false,
      logger: false,
    });
    const secret = randomBytes(32).toString('hex');
    server.catalog.saveBootstrapHash(createHash('sha256').update(secret).digest('hex'));
    const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ContentClient(origin);
    const session = await client.bootstrap(
      secret,
      'capture-owner',
      randomBytes(24).toString('hex'),
    );
    const library = await client.createLibrary({ name: 'Generated capture acceptance' });
    const item = await client.createItem({
      libraryId: library.id,
      title: 'Original palette counter',
      systemIdentifier: 'com.provenance.nes',
      md5: null,
      crc: null,
    });
    const rom = await client.upload({
      libraryId: library.id,
      itemId: item.id,
      kind: 'rom',
      displayName: 'Original program',
      relativePath: 'program.nes',
      baseRevision: item.revision,
      body: await readFile(join(dir, 'program.nes')),
    });
    await page.addInitScript(
      ({ origin, session }) => {
        if (window === top && location.origin === origin)
          localStorage.setItem(
            `ecs.session:${encodeURIComponent(origin)}`,
            JSON.stringify(session),
          );
      },
      { origin, session },
    );
    await page.goto(`${origin}/play/?item=${item.id}&asset=${rom.id}&profile=org.libretro.fceumm`);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const capture = page.getByRole('button', { name: 'Capture screenshot', exact: true });
    await expect(capture).toBeEnabled({ timeout: 45000 });
    async function screenshot(name: string) {
      await capture.click();
      await expect(
        page.getByRole('button', { name: 'Download screenshot', exact: true }),
      ).toBeVisible();
      await expect(capture).toBeEnabled();
      await expect(page.getByRole('alert')).toHaveCount(0);
      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download screenshot', exact: true }).click();
      const download = await downloading;
      const path = testInfo.outputPath(name);
      await download.saveAs(path);
      return await readFile(path);
    }
    async function pixel(bytes: Uint8Array) {
      return await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(data)], { type: 'image/png' }),
        );
        const c = document.createElement('canvas');
        c.width = bitmap.width;
        c.height = bitmap.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const p = Array.from(
          ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data,
        );
        bitmap.close();
        return p;
      }, Array.from(bytes));
    }
    const first = await screenshot('first.png');
    const firstPixel = await pixel(first);
    expect(firstPixel[3]).toBe(255);
    await page.getByRole('button', { name: 'Save state', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save state', exact: true })).toBeEnabled({
      timeout: 15000,
    });
    const manifest = await client.manifest(item.id);
    const state = manifest.files.find((f) => f.kind === 'save_state');
    expect(state).toBeDefined();
    const preview = manifest.files.find(
      (f) => f.kind === 'screenshot' && f.relativePath === `${state?.relativePath}.png`,
    );
    expect(preview).toBeDefined();
    const previewBytes = (await client.collect(preview!.id)).bytes;
    expect(Array.from(previewBytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const browser = page.getByRole('region', { name: 'Save state browser' });
    await expect(browser.getByRole('img', { name: 'Preview of saved game' })).toBeVisible();
    await page.frameLocator('iframe').locator('canvas').click();
    await page.keyboard.down('x');
    await page.waitForTimeout(150);
    await page.keyboard.up('x');
    await page.waitForTimeout(150);
    const second = await screenshot('second.png');
    expect(await pixel(second)).not.toEqual(firstPixel);
    await browser.getByRole('button', { name: 'Load state', exact: true }).click();
    await expect(browser.getByText('State loaded.', { exact: true })).toBeVisible();
    const restored = await screenshot('restored.png');
    expect(await pixel(restored)).toEqual(firstPixel);
    const controls = page.getByRole('region', { name: 'Display controls' });
    await controls.getByRole('combobox', { name: 'Scaling', exact: true }).selectOption('fill');
    await controls
      .getByRole('combobox', { name: 'Aspect ratio', exact: true })
      .selectOption('16:9');
    await controls.getByRole('combobox', { name: 'Filtering', exact: true }).selectOption('smooth');
    await expect(page.frameLocator('iframe').locator('canvas')).toHaveCSS(
      'image-rendering',
      'auto',
    );
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await page.goto('about:blank');
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

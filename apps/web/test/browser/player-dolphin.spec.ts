/** Opt-in full ECS acceptance using an original PPC program, never a game/BIOS fixture. */
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContentClient } from '@ecs/client';
import { expect, test } from '@playwright/test';
import { dolphinVideoSmokeDol } from '../../../../scripts/browser-core/dolphin-video-smoke.mjs';
import { openServer } from '../../../server/dist/src/index.js';

const plugin = process.env.ECS_ACCEPTANCE_DOLPHIN_PLUGIN;
test('Dolphin boots through the authenticated player in its own isolated origin', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(!plugin, 'Set ECS_ACCEPTANCE_DOLPHIN_PLUGIN to the verified operator-local profile.');
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'ecs-dolphin-player-'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  try {
    const registry = join(directory, 'players');
    await mkdir(registry);
    await cp(resolve(plugin ?? ''), join(registry, 'dolphin'), { recursive: true });
    server = await openServer({
      dataDir: join(directory, 'data'),
      uiDir: resolve('dist'),
      playerPluginsDir: registry,
      localTrust: false,
    });
    const secret = randomBytes(32).toString('hex');
    server.catalog.saveBootstrapHash(createHash('sha256').update(secret).digest('hex'));
    const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ContentClient(origin);
    const session = await client.bootstrap(
      secret,
      'dolphin-owner',
      randomBytes(24).toString('hex'),
    );
    const library = await client.createLibrary({ name: 'Original GameCube program' });
    const item = await client.createItem({
      libraryId: library.id,
      title: 'Original video bands',
      systemIdentifier: 'com.provenance.gamecube',
      md5: null,
      crc: null,
    });
    const program = dolphinVideoSmokeDol();
    const rom = await client.upload({
      libraryId: library.id,
      itemId: item.id,
      kind: 'rom',
      displayName: 'original.dol',
      relativePath: 'original.dol',
      baseRevision: item.revision,
      body: program,
    });
    await page.addInitScript(
      ({ origin, session }) => {
        if (location.origin === origin && window === top)
          localStorage.setItem(
            `ecs.session:${encodeURIComponent(origin)}`,
            JSON.stringify(session),
          );
      },
      { origin, session },
    );
    // Only this empty-fixture acceptance page exposes aggregate core counters to the test.
    await page.route('http://127.0.0.1:*/**', async (route) => {
      if (
        route.request().resourceType() !== 'document' ||
        new URL(route.request().url()).origin === origin
      )
        return route.continue();
      const response = await route.fetch();
      const body = await response.text();
      const marker = '/* Verify initialized module memory. */';
      if (!body.includes(marker)) return route.fulfill({ response, body });
      await route.fulfill({
        response,
        body: body.replace(
          marker,
          "globalThis.__ecsDolphinStats=()=>({jit:runtime._GetPpcWasmBlockRunCount(),compiled:runtime._GetPpcWasmBlockCompileCount(),video:text('GetVideoStats'),input:input?.info()});" +
            marker,
        ),
      });
    });
    await page.goto(`${origin}/play/?item=${item.id}&asset=${rom.id}&profile=org.dolphin.wasm`);
    await expect(page.getByRole('combobox', { name: 'Emulator', exact: true })).toHaveValue(
      'org.dolphin.wasm',
    );
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(
      page.getByText('This emulator profile does not provide save synchronization.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin',
    );
    const frame = page
      .frames()
      .find((f) => f !== page.mainFrame() && new URL(f.url()).origin !== origin);
    if (!frame) throw new Error('Dolphin companion frame missing');
    const isolation = await frame.evaluate(() => ({
      isolated: crossOriginIsolated,
      shared: typeof SharedArrayBuffer === 'function',
      parentBlocked: (() => {
        try {
          return parent.document === null;
        } catch {
          return true;
        }
      })(),
      credentialsAbsent: !Object.keys(localStorage).some((k) => k.startsWith('ecs.session:')),
    }));
    expect(isolation).toEqual({
      isolated: true,
      shared: true,
      parentBlocked: true,
      credentialsAbsent: true,
    });
    const stats = () =>
      frame.evaluate(() =>
        (
          globalThis as unknown as {
            __ecsDolphinStats(): {
              jit: number;
              compiled: number;
              video: string;
              input: { ready: boolean };
            };
          }
        ).__ecsDolphinStats(),
      );
    await expect.poll(async () => (await stats()).video, { timeout: 45_000 }).toMatch(/^xfb:[1-9]/);
    const before = await stats();
    await expect.poll(async () => (await stats()).jit).toBeGreaterThan(before.jit);
    await expect.poll(async () => (await stats()).input?.ready).toBe(true);
    const pixels = await frame.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('Game display missing');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D compositor missing');
      return {
        width: canvas.width,
        height: canvas.height,
        top: [...ctx.getImageData(canvas.width >> 1, canvas.height >> 2, 1, 1).data],
        bottom: [...ctx.getImageData(canvas.width >> 1, (canvas.height * 3) >> 2, 1, 1).data],
      };
    });
    expect(pixels.top[1]).toBeGreaterThan(200);
    expect(pixels.top[0]).toBeLessThan(30);
    expect(pixels.top[2]).toBeLessThan(30);
    expect(pixels.bottom[2]).toBeGreaterThan(200);
    expect(pixels.bottom[0]).toBeLessThan(30);
    expect(pixels.bottom[1]).toBeLessThan(30);
    const canvas = frame.locator('canvas');
    await canvas.focus();
    await page.keyboard.down('x');
    await expect
      .poll(
        async () =>
          ((
            await frame.evaluate(() =>
              (
                globalThis as unknown as {
                  __ecsDolphinStats(): { input: { states: { buttons: number }[] } };
                }
              ).__ecsDolphinStats(),
            )
          ).input.states[0]?.buttons ?? 0) & 256,
      )
      .toBe(256);
    await expect.poll(async () => (await stats()).video).toMatch(/\binput:1\b/);
    const pressed = await stats();
    await page.keyboard.up('x');
    await expect.poll(async () => (await stats()).video).toMatch(/\binput:0\b/);
    expect(errors).toEqual([]);
    await mkdir(testInfo.outputDir, { recursive: true });
    await canvas.screenshot({ path: testInfo.outputPath('dolphin-player.png') });
    await writeFile(
      testInfo.outputPath('dolphin-player.json'),
      JSON.stringify(
        {
          browser: browser.version(),
          profile: (await client.playerProfiles()).items[0],
          originalProgramSha256: createHash('sha256').update(program).digest('hex'),
          isolation,
          before,
          pressed,
          after: await stats(),
          pixels,
          errors,
        },
        null,
        2,
      ),
    );
    await page.goto('about:blank');
  } finally {
    await page.goto('about:blank').catch(() => {});
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
